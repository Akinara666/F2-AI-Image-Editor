import json
import logging
import threading
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

    def run_transform(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        with self._state_lock:
            self._active_calls += 1

        try:
            return self.transform_to_sd(prompt, context)
        finally:
            should_unload = False
            with self._state_lock:
                self._active_calls = max(0, self._active_calls - 1)
                if self._active_calls == 0 and self._unload_requested:
                    self._unload_requested = False
                    should_unload = True
            if should_unload:
                self._unload_now()

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "adapter": self.__class__.__name__}

    def unload(self) -> None:
        with self._state_lock:
            if self._active_calls > 0:
                self._unload_requested = True
                return

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

    def _ensure_model_loaded(self):
        if self._llm is not None:
            return

        with self._load_lock:
            if self._llm is not None:
                return

            if not self.model_path:
                raise RuntimeError("LLM_MODEL_PATH is empty for qwen_gguf provider.")

            try:
                from llama_cpp import Llama
            except Exception as exc:
                raise RuntimeError(
                    "llama_cpp is not installed. Install llama-cpp-python for qwen_gguf provider."
                ) from exc

            init_args: dict[str, Any] = {
                "model_path": self.model_path,
                "n_ctx": self.n_ctx,
                "n_threads": self.n_threads,
                "n_gpu_layers": self.n_gpu_layers,
                "verbose": False,
            }

            # LoRA support depends on installed llama_cpp build.
            if self.lora_path:
                init_args["lora_path"] = self.lora_path
                init_args["lora_scale"] = self.lora_scale

            self.logger.info(
                "Loading Qwen GGUF model. model_path=%s lora_path=%s n_ctx=%s n_gpu_layers=%s",
                self.model_path,
                self.lora_path or "<none>",
                self.n_ctx,
                self.n_gpu_layers,
            )
            self._llm = Llama(**init_args)

    @staticmethod
    def _extract_json_object(text: str) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise RuntimeError("LLM returned empty response.")

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise RuntimeError("LLM response does not contain JSON object.")
        return json.loads(text[start : end + 1])

    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        self._ensure_model_loaded()
        assert self._llm is not None

        ctx = context or {}
        user_negative = (ctx.get("user_negative_prompt") or "").strip()

        user_prompt = (
            "Transform user request into Stable Diffusion syntax.\n"
            "Output ONLY strict JSON:\n"
            '{"positive_prompt":"...","negative_prompt_extra":"...","style_tags":["..."]}\n\n'
            f'User prompt: "{prompt}"\n'
            f'User negative prompt: "{user_negative}"\n'
            "Do not include markdown."
        )

        try:
            response = self._llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": self.system_prompt or settings.LLM_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=self.temperature,
                top_p=self.top_p,
                max_tokens=self.max_tokens,
            )
            content = response["choices"][0]["message"]["content"]
        except Exception as exc:
            raise RuntimeError(f"Qwen inference failed: {exc}") from exc

        parsed = self._extract_json_object(content)
        return parsed

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


#_____________апдейт_______ Provider factory
def build_llm_adapter(provider_name: str) -> BasePromptLLMAdapter:
    provider = (provider_name or "stub").strip().lower()
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
