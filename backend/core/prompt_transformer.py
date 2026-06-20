import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from core.config import settings
from core.llm_adapter import BasePromptLLMAdapter, build_llm_adapter


#_____________апдейт_______ Prompt transformer result contract
@dataclass
class PromptTransformResult:
    raw_prompt: str
    transformed_prompt: str
    transformed_negative_prompt: str
    transform_status: str
    provider: str
    latency_ms: int
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "raw_prompt": self.raw_prompt,
            "transformed_prompt": self.transformed_prompt,
            "transformed_negative_prompt": self.transformed_negative_prompt,
            "transform_status": self.transform_status,
            "provider": self.provider,
            "latency_ms": self.latency_ms,
        }
        if self.error:
            data["error"] = self.error
        return data


#_____________апдейт_______ Helpers for JSON contract and negative merge
def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw in items:
        item = _clean_text(raw)
        if not item:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _split_prompt_parts(value: str) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _merge_negative_prompts(user_negative: str, llm_negative_extra: str, policy: str) -> str:
    normalized_policy = (policy or "append").strip().lower()
    user_clean = _clean_text(user_negative)
    llm_clean = _clean_text(llm_negative_extra)

    if normalized_policy == "replace":
        return llm_clean
    if normalized_policy == "user_only":
        return user_clean

    parts = _split_prompt_parts(user_clean) + _split_prompt_parts(llm_clean)
    return ", ".join(_dedupe_keep_order(parts))


def _normalize_llm_payload(raw_payload: Any) -> dict[str, Any]:
    if not isinstance(raw_payload, dict):
        raise RuntimeError("LLM adapter must return dict payload.")

    positive_prompt = _clean_text(raw_payload.get("positive_prompt"))
    if not positive_prompt:
        raise RuntimeError("LLM payload has empty positive_prompt.")

    negative_prompt_extra = _clean_text(raw_payload.get("negative_prompt_extra", ""))
    style_raw = raw_payload.get("style_tags", [])
    if style_raw is None:
        style_raw = []
    if not isinstance(style_raw, list):
        raise RuntimeError("LLM payload style_tags must be an array.")

    style_tags = _dedupe_keep_order([str(tag) for tag in style_raw])
    return {
        "positive_prompt": positive_prompt,
        "negative_prompt_extra": negative_prompt_extra,
        "style_tags": style_tags,
    }


#_____________апдейт_______ Prompt transformer service
class PromptTransformer:
    def __init__(
        self,
        enabled: bool,
        timeout_ms: int,
        provider_name: str,
        negative_merge_policy: str = "append",
        unload_after_call: bool = True,
        adapter: Optional[BasePromptLLMAdapter] = None,
        logger: Optional[logging.Logger] = None,
    ):
        self.enabled = enabled
        self.timeout_ms = timeout_ms
        self.provider_name = provider_name
        self.negative_merge_policy = negative_merge_policy
        self.unload_after_call = unload_after_call
        self.adapter = adapter or build_llm_adapter(provider_name)
        self.logger = logger or logging.getLogger("PromptTransformer")
        self._transform_slot_lock = threading.Lock()
        self._transform_inflight = False
        self._transform_slot_generation = 0

    def _try_acquire_transform_slot(self) -> int:
        """Returns generation id > 0 on success, 0 if busy."""
        with self._transform_slot_lock:
            if self._transform_inflight:
                return 0
            self._transform_inflight = True
            self._transform_slot_generation += 1
            return self._transform_slot_generation

    def _release_transform_slot(self, generation: int) -> None:
        # Guard against a stale background thread releasing a slot that already
        # belongs to a newer request (happens when timeout fires early).
        with self._transform_slot_lock:
            if self._transform_slot_generation == generation:
                self._transform_inflight = False

    def _is_transform_busy(self) -> bool:
        with self._transform_slot_lock:
            return self._transform_inflight

    async def transform_prompt(
        self,
        raw_prompt: str,
        use_prompt_transform: Optional[bool] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> PromptTransformResult:
        transform_id = uuid.uuid4().hex[:8]
        prompt_clean = _clean_text(raw_prompt)
        context = context or {}
        user_negative_prompt = _clean_text(context.get("user_negative_prompt"))
        self.logger.info(
            "Prompt transform request received: transform_id=%s provider=%s prompt_len=%s negative_len=%s timeout_ms=%s busy=%s mode=%s model_id=%s",
            transform_id,
            self.provider_name,
            len(prompt_clean),
            len(user_negative_prompt),
            self.timeout_ms,
            self._is_transform_busy(),
            context.get("mode") or "<none>",
            context.get("model_id") or "<none>",
        )

        if not prompt_clean:
            self.logger.info("Prompt transform skipped because prompt is empty: transform_id=%s", transform_id)
            return PromptTransformResult(
                raw_prompt="",
                transformed_prompt="",
                transformed_negative_prompt=user_negative_prompt,
                transform_status="skipped_empty",
                provider=self.provider_name,
                latency_ms=0,
            )

        should_transform = self.enabled if use_prompt_transform is None else (self.enabled and use_prompt_transform)
        if not should_transform:
            self.logger.info("Prompt transform disabled for request: transform_id=%s", transform_id)
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=prompt_clean,
                transformed_negative_prompt=user_negative_prompt,
                transform_status="disabled",
                provider=self.provider_name,
                latency_ms=0,
            )

        slot_gen = self._try_acquire_transform_slot()
        if not slot_gen:
            self.logger.info(
                "Prompt transform rejected because previous request is still running: transform_id=%s",
                transform_id,
            )
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt="",
                transformed_negative_prompt=user_negative_prompt,
                transform_status="busy",
                provider=self.provider_name,
                latency_ms=0,
                error="Prompt transformer is busy with a previous request.",
            )

        started = time.perf_counter()
        worker_started = threading.Event()

        def run_transform_call() -> dict[str, Any]:
            worker_started.set()
            self.logger.info("Prompt transform worker started: transform_id=%s", transform_id)
            try:
                return self.adapter.run_transform(prompt_clean, context)
            finally:
                # Generation guard: if timeout already released this slot and a newer
                # request grabbed it, this call is a no-op.
                self._release_transform_slot(slot_gen)
                self.logger.info("Prompt transform worker finished: transform_id=%s", transform_id)

        try:
            # Model loading happens outside the transform timeout: the first
            # call may need to read a multi-GB GGUF from disk, and that must
            # not be mistaken for a slow inference.
            await asyncio.to_thread(self.adapter.ensure_ready)
            raw_payload = await asyncio.wait_for(
                asyncio.to_thread(run_transform_call),
                timeout=max(0.1, self.timeout_ms / 1000.0),
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            payload = _normalize_llm_payload(raw_payload)
            positive_prompt = payload["positive_prompt"]
            if payload["style_tags"]:
                style_tags = ", ".join(payload["style_tags"])
                positive_prompt = f"{positive_prompt}, {style_tags}"
            transformed_negative_prompt = _merge_negative_prompts(
                user_negative_prompt,
                payload["negative_prompt_extra"],
                self.negative_merge_policy,
            )
            self.logger.info(
                "Prompt transform completed successfully: transform_id=%s latency_ms=%s transformed_len=%s negative_len=%s style_tags=%s",
                transform_id,
                latency_ms,
                len(positive_prompt),
                len(transformed_negative_prompt),
                len(payload["style_tags"]),
            )

            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=positive_prompt,
                transformed_negative_prompt=transformed_negative_prompt,
                transform_status="success",
                provider=self.provider_name,
                latency_ms=latency_ms,
            )
        except Exception as exc:
            # On timeout the background thread is still running and will call
            # _release_transform_slot(slot_gen) when done — but that could take
            # many seconds. Release immediately so the next request isn't blocked.
            # The generation guard prevents the thread's later release from
            # accidentally clearing a slot owned by a newer request.
            if not worker_started.is_set() or isinstance(exc, asyncio.TimeoutError):
                self._release_transform_slot(slot_gen)
            latency_ms = int((time.perf_counter() - started) * 1000)
            if isinstance(exc, asyncio.TimeoutError):
                error_message = f"Prompt transform timed out after {self.timeout_ms} ms."
            else:
                error_message = str(exc) or type(exc).__name__
            self.logger.warning(
                "Prompt transform fallback: transform_id=%s latency_ms=%s error=%s",
                transform_id,
                latency_ms,
                error_message,
            )
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt="",
                transformed_negative_prompt=user_negative_prompt,
                transform_status="fallback_error",
                provider=self.provider_name,
                latency_ms=latency_ms,
                error=error_message,
            )
        finally:
            if self.unload_after_call and self.adapter.should_unload_after_call():
                try:
                    self.logger.info("Prompt transform requesting adapter unload: transform_id=%s", transform_id)
                    self.adapter.unload()
                except Exception as e:
                    self.logger.warning("Failed to unload adapter: %s", e)
            else:
                self.logger.info("Prompt transform leaving adapter loaded in memory: transform_id=%s", transform_id)

    #_____________апдейт_______ Health for operational checks
    def health(self) -> dict[str, Any]:
        data = {
            "enabled": self.enabled,
            "provider": self.provider_name,
            "timeout_ms": self.timeout_ms,
            "negative_merge_policy": self.negative_merge_policy,
            "unload_after_call": self.unload_after_call,
            "busy": self._is_transform_busy(),
        }
        try:
            data["adapter"] = self.adapter.health()
        except Exception as exc:
            data["adapter"] = {
                "status": "error",
                "error": str(exc),
            }
        return data


#_____________апдейт_______ Singleton used by FastAPI handlers
prompt_transformer = PromptTransformer(
    enabled=settings.PROMPT_TRANSFORM_ENABLED,
    timeout_ms=settings.PROMPT_TRANSFORM_TIMEOUT_MS,
    provider_name=settings.PROMPT_TRANSFORM_PROVIDER,
    negative_merge_policy=settings.PROMPT_NEGATIVE_MERGE_POLICY,
    unload_after_call=settings.PROMPT_TRANSFORM_UNLOAD_AFTER_CALL,
)
