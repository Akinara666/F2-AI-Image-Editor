import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

from core.config import settings


#_____________апдейт_______ Prompt transformer result contract
@dataclass
class PromptTransformResult:
    raw_prompt: str
    transformed_prompt: str
    transform_status: str
    provider: str
    latency_ms: int
    error: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "raw_prompt": self.raw_prompt,
            "transformed_prompt": self.transformed_prompt,
            "transform_status": self.transform_status,
            "provider": self.provider,
            "latency_ms": self.latency_ms,
        }
        if self.error:
            data["error"] = self.error
        return data


#_____________апдейт_______ LLM adapter interface (swap with local Qwen later)
class BasePromptLLMAdapter:
    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> str:
        raise NotImplementedError


#_____________апдейт_______ Safe default adapter
class StubPromptLLMAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context: Optional[dict[str, Any]] = None) -> str:
        # Keep behavior deterministic and safe until real local LLM is plugged in.
        return " ".join(prompt.strip().split())


#_____________апдейт_______ Prompt transformer service
class PromptTransformer:
    def __init__(
        self,
        enabled: bool,
        timeout_ms: int,
        provider_name: str,
        adapter: Optional[BasePromptLLMAdapter] = None,
        logger: Optional[logging.Logger] = None,
    ):
        self.enabled = enabled
        self.timeout_ms = timeout_ms
        self.provider_name = provider_name
        self.adapter = adapter or StubPromptLLMAdapter()
        self.logger = logger or logging.getLogger("PromptTransformer")

    async def transform_prompt(
        self,
        raw_prompt: str,
        use_prompt_transform: Optional[bool] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> PromptTransformResult:
        prompt_clean = " ".join((raw_prompt or "").strip().split())
        if not prompt_clean:
            return PromptTransformResult(
                raw_prompt="",
                transformed_prompt="",
                transform_status="skipped_empty",
                provider=self.provider_name,
                latency_ms=0,
            )

        should_transform = self.enabled if use_prompt_transform is None else (self.enabled and use_prompt_transform)
        if not should_transform:
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=prompt_clean,
                transform_status="disabled",
                provider=self.provider_name,
                latency_ms=0,
            )

        started = time.perf_counter()
        try:
            transformed = await asyncio.wait_for(
                asyncio.to_thread(self.adapter.transform_to_sd, prompt_clean, context or {}),
                timeout=max(0.1, self.timeout_ms / 1000.0),
            )
            latency_ms = int((time.perf_counter() - started) * 1000)
            transformed_clean = " ".join((transformed or "").strip().split())

            if not transformed_clean:
                return PromptTransformResult(
                    raw_prompt=prompt_clean,
                    transformed_prompt="",
                    transform_status="fallback_empty_output",
                    provider=self.provider_name,
                    latency_ms=latency_ms,
                    error="Transformer returned empty output.",
                )

            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=transformed_clean,
                transform_status="success",
                provider=self.provider_name,
                latency_ms=latency_ms,
            )
        except Exception as exc:
            latency_ms = int((time.perf_counter() - started) * 1000)
            self.logger.warning("Prompt transform fallback: %s", exc)
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt="",
                transform_status="fallback_error",
                provider=self.provider_name,
                latency_ms=latency_ms,
                error=str(exc),
            )


#_____________апдейт_______ Singleton used by FastAPI handlers
prompt_transformer = PromptTransformer(
    enabled=settings.PROMPT_TRANSFORM_ENABLED,
    timeout_ms=settings.PROMPT_TRANSFORM_TIMEOUT_MS,
    provider_name=settings.PROMPT_TRANSFORM_PROVIDER,
)
