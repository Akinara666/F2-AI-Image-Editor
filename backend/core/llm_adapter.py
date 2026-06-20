import json
import logging
import os
import threading
import time
from typing import Any, Optional

from core.config import settings


#_____________апдейт_______ Shared adapter contract
class BasePromptLLMAdapter:
    def __init__(self) -> None:
        self._state_lock = threading.RLock()
        self._active_calls = 0
        self._unload_requested = False

    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        raise NotImplementedError

    def ensure_ready(self) -> None:
        """Pre-load heavy resources (weights) before the timed transform call.

        Callers run this outside their transform timeout so that a multi-GB
        model load is not mistaken for a slow inference. No-op by default.
        """
        return None

    def _get_logger(self) -> logging.Logger:
        return getattr(self, "logger", logging.getLogger(self.__class__.__name__))

    def run_transform(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        with self._state_lock:
            self._active_calls += 1
            active_calls = self._active_calls

        self._get_logger().info(
            "LLM transform call started: active_calls=%s prompt_len=%s",
            active_calls,
            len(prompt or ""),
        )

        try:
            return self.transform_to_sd(prompt, context)
        finally:
            should_unload = False
            with self._state_lock:
                self._active_calls = max(0, self._active_calls - 1)
                active_calls = self._active_calls
                if self._active_calls == 0 and self._unload_requested:
                    self._unload_requested = False
                    should_unload = True
            self._get_logger().info(
                "LLM transform call finished: active_calls=%s deferred_unload=%s",
                active_calls,
                should_unload,
            )
            if should_unload:
                self._unload_now()

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "adapter": self.__class__.__name__}

    def should_unload_after_call(self) -> bool:
        """Whether unloading after every call actually frees a scarce resource.

        Defaults to True so callers honouring unload_after_call keep their old
        behaviour. Adapters that gain nothing from per-call unloading (e.g. a
        CPU-only model whose unload only churns disk reads) override this.
        """
        return True

    def unload(self) -> None:
        with self._state_lock:
            if self._active_calls > 0:
                self._unload_requested = True
                self._get_logger().info(
                    "LLM unload deferred because calls are still active: active_calls=%s",
                    self._active_calls,
                )
                return

        self._get_logger().info("LLM unload requested immediately.")
        self._unload_now()

    def _unload_now(self) -> None:
        with self._state_lock:
            self._unload_requested = False
        self._unload_now_locked()

    def _unload_now_locked(self) -> None:
        pass


#_____________апдейт_______ Safe deterministic adapter used by default
class StubPromptLLMAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        clean = " ".join((prompt or "").strip().split())
        return {
            "positive_prompt": clean,
            "negative_prompt_extra": "",
            "style_tags": [],
        }

    def should_unload_after_call(self) -> bool:
        # Nothing is ever loaded, so per-call unloading is pointless.
        return False


#_____________апдейт_______ Qwen GGUF + LoRA adapter (lazy-loaded)
class QwenGGUFLoraAdapter(BasePromptLLMAdapter):
    def __init__(
        self,
        model_path: str,
        lora_path: str = "",
        lora_scale: float = 1.0,
        n_ctx: int = 4096,
        n_threads: int = 6,
        n_gpu_layers: int = 0,
        max_tokens: int = 220,
        temperature: float = 0.2,
        top_p: float = 0.9,
        system_prompt: str = "",
        logger: Optional[logging.Logger] = None,
    ):
        super().__init__()
        self.model_path = model_path
        self.lora_path = lora_path
        self.lora_scale = lora_scale
        self.n_ctx = n_ctx
        self.n_threads = n_threads
        self.n_gpu_layers = n_gpu_layers
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.top_p = top_p
        self.system_prompt = system_prompt
        self.logger = logger or logging.getLogger("QwenGGUFLoraAdapter")
        self._llm = None
        self._load_lock = threading.Lock()

    @staticmethod
    def _validate_runtime_file(path: str, label: str) -> str:
        normalized_path = (path or "").strip()
        if not normalized_path:
            raise RuntimeError(f"{label} path is empty.")
        if not os.path.isfile(normalized_path):
            raise RuntimeError(f"{label} file does not exist: {normalized_path}")
        file_size = os.path.getsize(normalized_path)
        if file_size <= 0:
            raise RuntimeError(f"{label} file is empty: {normalized_path}")
        return normalized_path

    def _ensure_model_loaded(self):
        if self._llm is not None:
            self.logger.info(
                "Reusing loaded Qwen GGUF model from memory. n_ctx=%s n_gpu_layers=%s",
                self.n_ctx,
                self.n_gpu_layers,
            )
            return

        with self._load_lock:
            if self._llm is not None:
                self.logger.info(
                    "Reusing loaded Qwen GGUF model from memory after load lock. n_ctx=%s n_gpu_layers=%s",
                    self.n_ctx,
                    self.n_gpu_layers,
                )
                return

            if not self.model_path:
                raise RuntimeError("LLM_MODEL_PATH is empty for qwen_gguf provider.")

            validated_model_path = self._validate_runtime_file(self.model_path, "LLM model")
            validated_lora_path = ""
            if self.lora_path:
                validated_lora_path = self._validate_runtime_file(self.lora_path, "LLM LoRA adapter")

            try:
                from llama_cpp import Llama
            except Exception as exc:
                raise RuntimeError(
                    "llama_cpp is not installed. Install llama-cpp-python for qwen_gguf provider."
                ) from exc

            init_args: dict[str, Any] = {
                "model_path": validated_model_path,
                "n_ctx": self.n_ctx,
                "n_threads": self.n_threads,
                "n_gpu_layers": self.n_gpu_layers,
                "verbose": False,
            }

            # LoRA support depends on installed llama_cpp build.
            if validated_lora_path:
                init_args["lora_path"] = validated_lora_path
                init_args["lora_scale"] = self.lora_scale

            started = time.perf_counter()
            self.logger.info(
                "Loading Qwen GGUF model. model_path=%s lora_path=%s n_ctx=%s n_gpu_layers=%s",
                validated_model_path,
                validated_lora_path or "<none>",
                self.n_ctx,
                self.n_gpu_layers,
            )
            self._llm = Llama(**init_args)
            self.logger.info(
                "Qwen GGUF model loaded in %s ms.",
                int((time.perf_counter() - started) * 1000),
            )

    @staticmethod
    def _extract_json_object(text: str) -> dict[str, Any]:
        import re
        text = (text or "").strip()
        if not text:
            raise RuntimeError("LLM returned empty response.")

        # Qwen3 thinking mode wraps reasoning in <think>...</think> before the answer.
        # Strip it so the JSON extractor sees only the actual output.
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise RuntimeError("LLM response does not contain JSON object.")
        return json.loads(text[start : end + 1])

    def ensure_ready(self) -> None:
        self._ensure_model_loaded()

    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        started = time.perf_counter()
        self._ensure_model_loaded()
        assert self._llm is not None

        ctx = context or {}
        user_negative = (ctx.get("user_negative_prompt") or "").strip()
        mode = ctx.get("mode") or "<unknown>"
        model_id = ctx.get("model_id") or "<unknown>"

        user_prompt = (
            "Transform user request into Stable Diffusion syntax.\n"
            "Output ONLY strict JSON:\n"
            '{"positive_prompt":"...","negative_prompt_extra":"...","style_tags":["..."]}\n\n'
            f'User prompt: "{prompt}"\n'
            f'User negative prompt: "{user_negative}"\n'
            "Do not include markdown."
        )

        try:
            self.logger.info(
                "Starting Qwen inference: prompt_len=%s negative_len=%s mode=%s model_id=%s max_tokens=%s n_ctx=%s n_gpu_layers=%s loaded=%s",
                len(prompt or ""),
                len(user_negative),
                mode,
                model_id,
                self.max_tokens,
                self.n_ctx,
                self.n_gpu_layers,
                self._llm is not None,
            )
            # Qwen3 по умолчанию в thinking-режиме: генерирует <think>...</think>
            # (много токенов, медленно) до ответа. Для SD-промпта это не нужно —
            # /no_think переключает в прямой режим (стандартный флаг Qwen3/llama.cpp).
            response = self._llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": self.system_prompt or settings.LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt + " /no_think"},
                ],
                temperature=self.temperature,
                top_p=self.top_p,
                max_tokens=self.max_tokens,
            )
            content = response["choices"][0]["message"]["content"]
            self.logger.info(
                "Qwen inference finished in %s ms. response_len=%s",
                int((time.perf_counter() - started) * 1000),
                len(content or ""),
            )
        except Exception as exc:
            raise RuntimeError(f"Qwen inference failed: {exc}") from exc

        parsed = self._extract_json_object(content)
        self.logger.info(
            "Qwen response parsed successfully: positive_len=%s negative_extra_len=%s style_tags=%s",
            len(str(parsed.get("positive_prompt") or "")),
            len(str(parsed.get("negative_prompt_extra") or "")),
            len(parsed.get("style_tags") or []),
        )
        return parsed

    def should_unload_after_call(self) -> bool:
        # Unloading only frees VRAM when some layers live on the GPU. For pure
        # CPU inference (n_gpu_layers == 0) an unload merely forces the next call
        # to re-read the multi-GB GGUF from disk with no memory benefit, so keep
        # the model resident.
        return self.n_gpu_layers != 0

    def health(self) -> dict[str, Any]:
        loaded = self._llm is not None
        return {
            "status": "ok",
            "adapter": "qwen_gguf_lora",
            "loaded": loaded,
            "active_calls": self._active_calls,
            "unload_requested": self._unload_requested,
            "model_path": self.model_path,
            "lora_path": self.lora_path,
            "n_ctx": self.n_ctx,
            "n_gpu_layers": self.n_gpu_layers,
        }

    def _unload_now_locked(self) -> None:
        with self._load_lock:
            if self._llm is not None:
                self.logger.info("Unloading Qwen GGUF model from memory.")
                del self._llm
                self._llm = None
        import gc
        gc.collect()
        # When layers were offloaded to the GPU, releasing the Python object is
        # not enough: the CUDA caching allocator keeps the freed blocks until an
        # explicit empty_cache(). Skipping this would leave VRAM occupied right
        # before a heavy SD/SDXL load and could trigger a spurious OOM.
        if self.n_gpu_layers != 0:
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
            except Exception as exc:
                self.logger.warning("Could not free CUDA cache after LLM unload: %s", exc)


#_____________апдейт_______ Provider factory
def _create_llm_adapter(provider: str) -> BasePromptLLMAdapter:
    if provider in {"qwen_gguf", "qwen_gguf_lora"}:
        return QwenGGUFLoraAdapter(
            model_path=settings.LLM_MODEL_PATH,
            lora_path=settings.LLM_LORA_PATH,
            lora_scale=settings.LLM_LORA_SCALE,
            n_ctx=settings.LLM_CTX_SIZE,
            n_threads=settings.LLM_THREADS,
            n_gpu_layers=settings.LLM_GPU_LAYERS,
            max_tokens=settings.LLM_MAX_NEW_TOKENS,
            temperature=settings.LLM_TEMPERATURE,
            top_p=settings.LLM_TOP_P,
            system_prompt=settings.LLM_SYSTEM_PROMPT,
        )
    return StubPromptLLMAdapter()


# Adapters are cached per provider so that the positive and negative prompt
# transformers reuse a single underlying model instead of each loading its own
# copy of the (multi-GB) GGUF weights into memory.
_adapter_cache: dict[str, BasePromptLLMAdapter] = {}
_adapter_cache_lock = threading.Lock()


def build_llm_adapter(provider_name: str) -> BasePromptLLMAdapter:
    provider = (provider_name or "stub").strip().lower()
    with _adapter_cache_lock:
        cached = _adapter_cache.get(provider)
        if cached is not None:
            return cached
        adapter = _create_llm_adapter(provider)
        _adapter_cache[provider] = adapter
        return adapter
