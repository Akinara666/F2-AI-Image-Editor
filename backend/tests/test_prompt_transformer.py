import asyncio
import time
import threading
import unittest

from core.llm_adapter import BasePromptLLMAdapter
from core.prompt_transformer import PromptTransformer


class StructuredAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {
            "positive_prompt": f"sd::{prompt}",
            "negative_prompt_extra": "extra_bad, blurry",
            "style_tags": ["cinematic", "sharp focus"],
        }


class InvalidPayloadAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None):  # noqa: ANN201
        return "not a dict"


class ErrorAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        raise RuntimeError("adapter failed")


class SlowAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        time.sleep(0.2)
        return {
            "positive_prompt": f"slow::{prompt}",
            "negative_prompt_extra": "",
            "style_tags": [],
        }


class SlowUnloadAwareAdapter(BasePromptLLMAdapter):
    def __init__(self):
        super().__init__()
        self.finished = threading.Event()
        self.unload_count = 0
        self.unloaded_while_active = False

    def transform_to_sd(self, prompt: str, context=None) -> dict:
        time.sleep(0.2)
        self.finished.set()
        return {
            "positive_prompt": f"slow::{prompt}",
            "negative_prompt_extra": "",
            "style_tags": [],
        }

    def _unload_now_locked(self) -> None:
        if self._active_calls > 0:
            self.unloaded_while_active = True
        self.unload_count += 1


class PromptTransformerTests(unittest.TestCase):
    def test_disabled_transformer_returns_raw_prompt_and_user_negative(self):
        transformer = PromptTransformer(
            enabled=False,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredAdapter(),
        )
        result = asyncio.run(
            transformer.transform_prompt(
                "hello world",
                use_prompt_transform=True,
                context={"user_negative_prompt": "low quality"},
            )
        )

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_prompt, "hello world")
        self.assertEqual(result.transformed_negative_prompt, "low quality")

    def test_success_transform_appends_style_and_negative(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredAdapter(),
            negative_merge_policy="append",
        )
        result = asyncio.run(
            transformer.transform_prompt(
                "hello world",
                use_prompt_transform=True,
                context={"user_negative_prompt": "low quality, blurry"},
            )
        )

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(result.transformed_prompt, "sd::hello world, cinematic, sharp focus")
        self.assertEqual(result.transformed_negative_prompt, "low quality, blurry, extra_bad")

    def test_negative_merge_policy_replace(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredAdapter(),
            negative_merge_policy="replace",
        )
        result = asyncio.run(
            transformer.transform_prompt(
                "hello world",
                use_prompt_transform=True,
                context={"user_negative_prompt": "low quality"},
            )
        )

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(result.transformed_negative_prompt, "extra_bad, blurry")

    def test_request_level_opt_out(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredAdapter(),
        )
        result = asyncio.run(
            transformer.transform_prompt("hello world", use_prompt_transform=False)
        )

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_prompt, "hello world")

    def test_invalid_payload_returns_error(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=InvalidPayloadAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_prompt, "")

    def test_adapter_error_returns_no_transformed_prompt(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=ErrorAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_prompt, "")

    def test_timeout_returns_no_transformed_prompt(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=30,
            provider_name="stub",
            adapter=SlowAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_prompt, "")

    def test_timeout_defers_unload_until_background_call_finishes(self):
        adapter = SlowUnloadAwareAdapter()
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=30,
            provider_name="stub",
            adapter=adapter,
        )

        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(adapter.unload_count, 0)
        self.assertFalse(adapter.unloaded_while_active)

        self.assertTrue(adapter.finished.wait(timeout=1.0))
        time.sleep(0.05)

        self.assertEqual(adapter.unload_count, 1)
        self.assertFalse(adapter.unloaded_while_active)


if __name__ == "__main__":
    unittest.main()
