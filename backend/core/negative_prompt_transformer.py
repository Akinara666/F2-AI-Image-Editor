import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from core.config import settings
from core.llm_adapter import BasePromptLLMAdapter, build_llm_adapter


@dataclass
class NegativePromptTransformResult:
    raw_negative_prompt: str
    transformed_negative_prompt: str
    transform_status: str
    provider: str
    latency_ms: int
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "raw_negative_prompt": self.raw_negative_prompt,
            "transformed_negative_prompt": self.transformed_negative_prompt,
            "transform_status": self.transform_status,
            "provider": self.provider,
            "latency_ms": self.latency_ms,
        }
        if self.error:
            data["error"] = self.error
        return data


def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _extract_negative_prompt(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise RuntimeError("LLM adapter must return dict payload.")

    if "negative_prompt" in payload:
        value = _clean_text(payload.get("negative_prompt"))
        if value:
            return value

    if "negative_prompt_extra" in payload:
        value = _clean_text(payload.get("negative_prompt_extra"))
        if value:
            return value

    if "positive_prompt" in payload:
        value = _clean_text(payload.get("positive_prompt"))
        if value:
            return value

    raise RuntimeError("LLM payload has empty negative prompt.")


class NegativePromptTransformer:
    def __init__(
        self,
        enabled: bool,
        timeout_ms: int,
        provider_name: str,
        unload_after_call: bool = True,
        queue_mode: str = "wait",
        max_wait_ms: int = 20000,
        adapter: Optional[BasePromptLLMAdapter] = None,
        logger: Optional[logging.Logger] = None,
    ):
        self.enabled = enabled
        self.timeout_ms = timeout_ms
        self.provider_name = provider_name
        self.unload_after_call = unload_after_call
        self.queue_mode = (queue_mode or "wait").strip().lower()
        self.max_wait_ms = max(0, int(max_wait_ms))
        self.adapter = adapter or build_llm_adapter(provider_name)
        self.logger = logger or logging.getLogger("NegativePromptTransformer")
        self._slot_condition = threading.Condition()
        self._transform_inflight = False

    def _is_transform_busy(self) -> bool:
        with self._slot_condition:
            return self._transform_inflight

    def _release_transform_slot(self) -> None:
        with self._slot_condition:
            self._transform_inflight = False
            self._slot_condition.notify()

    def _acquire_transform_slot(self) -> tuple[bool, Optional[str]]:
        mode = "busy" if self.queue_mode == "busy" else "wait"
        with self._slot_condition:
            if not self._transform_inflight:
                self._transform_inflight = True
                return True, None

            if mode == "busy":
                return False, "Negative prompt transformer is busy with a previous request."

            if self.max_wait_ms <= 0:
                return False, "Negative prompt transformer wait timeout expired."

            deadline = time.perf_counter() + (self.max_wait_ms / 1000.0)
            while self._transform_inflight:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return False, "Negative prompt transformer wait timeout expired."
                self._slot_condition.wait(timeout=remaining)

            self._transform_inflight = True
            return True, None

    async def transform_negative_prompt(
        self,
        raw_negative_prompt: str,
        use_negative_prompt_transform: Optional[bool] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> NegativePromptTransformResult:
        transform_id = uuid.uuid4().hex[:8]
        negative_clean = _clean_text(raw_negative_prompt)
        context = context or {}

        self.logger.info(
            "Negative transform request received: transform_id=%s provider=%s negative_len=%s timeout_ms=%s busy=%s queue_mode=%s",
            transform_id,
            self.provider_name,
            len(negative_clean),
            self.timeout_ms,
            self._is_transform_busy(),
            self.queue_mode,
        )

        if not negative_clean:
            return NegativePromptTransformResult(
                raw_negative_prompt="",
                transformed_negative_prompt="",
                transform_status="skipped_empty",
                provider=self.provider_name,
                latency_ms=0,
            )

        should_transform = (
            self.enabled
            if use_negative_prompt_transform is None
            else (self.enabled and use_negative_prompt_transform)
        )
        if not should_transform:
            return NegativePromptTransformResult(
                raw_negative_prompt=negative_clean,
                transformed_negative_prompt=negative_clean,
                transform_status="disabled",
                provider=self.provider_name,
                latency_ms=0,
            )

        acquired, wait_error = self._acquire_transform_slot()
        if not acquired:
            return NegativePromptTransformResult(
                raw_negative_prompt=negative_clean,
                transformed_negative_prompt="",
                transform_status="busy",
                provider=self.provider_name,
                latency_ms=0,
                error=wait_error,
            )

        started = time.perf_counter()
        worker_started = threading.Event()

        def run_transform_call() -> dict[str, Any]:
            worker_started.set()
            self.logger.info("Negative transform worker started: transform_id=%s", transform_id)
            try:
                return self.adapter.run_transform(negative_clean, context)
            finally:
                self._release_transform_slot()
                self.logger.info("Negative transform worker finished: transform_id=%s", transform_id)

        try:
            raw_payload = await asyncio.wait_for(
                asyncio.to_thread(run_transform_call),
                timeout=max(0.1, self.timeout_ms / 1000.0),
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            transformed_negative_prompt = _extract_negative_prompt(raw_payload)
            return NegativePromptTransformResult(
                raw_negative_prompt=negative_clean,
                transformed_negative_prompt=transformed_negative_prompt,
                transform_status="success",
                provider=self.provider_name,
                latency_ms=latency_ms,
            )
        except Exception as exc:
            if not worker_started.is_set():
                self._release_transform_slot()
            latency_ms = int((time.perf_counter() - started) * 1000)
            if isinstance(exc, asyncio.TimeoutError):
                error_message = f"Negative prompt transform timed out after {self.timeout_ms} ms."
            else:
                error_message = str(exc) or type(exc).__name__
            return NegativePromptTransformResult(
                raw_negative_prompt=negative_clean,
                transformed_negative_prompt="",
                transform_status="fallback_error",
                provider=self.provider_name,
                latency_ms=latency_ms,
                error=error_message,
            )
        finally:
            if self.unload_after_call and self.adapter.should_unload_after_call():
                try:
                    self.adapter.unload()
                except Exception as exc:
                    self.logger.warning("Failed to unload adapter: %s", exc)
            elif self.unload_after_call:
                self.logger.info(
                    "Skipping adapter unload: keeping resident model loaded (no resource freed by unload)."
                )

    def health(self) -> dict[str, Any]:
        data = {
            "enabled": self.enabled,
            "provider": self.provider_name,
            "timeout_ms": self.timeout_ms,
            "unload_after_call": self.unload_after_call,
            "queue_mode": self.queue_mode,
            "max_wait_ms": self.max_wait_ms,
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


negative_prompt_transformer = NegativePromptTransformer(
    enabled=settings.NEG_PROMPT_TRANSFORM_ENABLED,
    timeout_ms=settings.NEG_PROMPT_TRANSFORM_TIMEOUT_MS,
    provider_name=settings.NEG_PROMPT_TRANSFORM_PROVIDER,
    unload_after_call=settings.NEG_PROMPT_TRANSFORM_UNLOAD_AFTER_CALL,
    queue_mode=settings.PROMPT_TRANSFORM_QUEUE_MODE,
    max_wait_ms=settings.PROMPT_TRANSFORM_MAX_WAIT_MS,
)
