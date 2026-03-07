import asyncio
import logging
import time
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
        adapter: Optional[BasePromptLLMAdapter] = None,
        logger: Optional[logging.Logger] = None,
    ):
        self.enabled = enabled
        self.timeout_ms = timeout_ms
        self.provider_name = provider_name
        self.negative_merge_policy = negative_merge_policy
        self.adapter = adapter or build_llm_adapter(provider_name)
        self.logger = logger or logging.getLogger("PromptTransformer")

    async def transform_prompt(
        self,
        raw_prompt: str,
        use_prompt_transform: Optional[bool] = None,
        context: Optional[dict[str, Any]] = None,
    ) -> PromptTransformResult:
        prompt_clean = _clean_text(raw_prompt)
        user_negative_prompt = _clean_text((context or {}).get("user_negative_prompt"))

        if not prompt_clean:
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
            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=prompt_clean,
                transformed_negative_prompt=user_negative_prompt,
                transform_status="disabled",
                provider=self.provider_name,
                latency_ms=0,
            )

        started = time.perf_counter()
        try:
            raw_payload = await asyncio.wait_for(
                asyncio.to_thread(self.adapter.transform_to_sd, prompt_clean, context or {}),
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

            return PromptTransformResult(
                raw_prompt=prompt_clean,
                transformed_prompt=positive_prompt,
                transformed_negative_prompt=transformed_negative_prompt,
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
                transformed_negative_prompt=user_negative_prompt,
                transform_status="fallback_error",
                provider=self.provider_name,
                latency_ms=latency_ms,
                error=str(exc),
            )

    #_____________апдейт_______ Health for operational checks
    def health(self) -> dict[str, Any]:
        data = {
            "enabled": self.enabled,
            "provider": self.provider_name,
            "timeout_ms": self.timeout_ms,
            "negative_merge_policy": self.negative_merge_policy,
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
)
