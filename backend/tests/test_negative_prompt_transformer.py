import asyncio
import threading
import time
import unittest

from core.llm_adapter import BasePromptLLMAdapter
from core.negative_prompt_transformer import NegativePromptTransformer


class StructuredNegativeAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {
            "negative_prompt": f"neg::{prompt}",
        }


class ExtraOnlyNegativeAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {
            "negative_prompt_extra": f"extra::{prompt}",
        }


class InvalidPayloadAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None):
        return "not a dict"


class ErrorAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        raise RuntimeError("adapter failed")


class SlowAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        time.sleep(0.2)
        return {
            "negative_prompt": f"slow::{prompt}",
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
            "negative_prompt": f"slow::{prompt}",
        }

    def _unload_now_locked(self) -> None:
        if self._active_calls > 0:
            self.unloaded_while_active = True
        self.unload_count += 1


class NegativePromptTransformerTests(unittest.TestCase):
    def test_disabled_transformer_returns_raw_negative(self):
        transformer = NegativePromptTransformer(
            enabled=False,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredNegativeAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_negative_prompt, "low quality")

    def test_success_transform_uses_negative_prompt_field(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredNegativeAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(result.transformed_negative_prompt, "neg::low quality")

    def test_success_transform_uses_negative_prompt_extra_fallback(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=ExtraOnlyNegativeAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "blurry",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(result.transformed_negative_prompt, "extra::blurry")

    def test_request_level_opt_out(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredNegativeAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=False,
            )
        )

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_negative_prompt, "low quality")

    def test_empty_prompt_is_skipped(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredNegativeAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "   ",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "skipped_empty")
        self.assertEqual(result.transformed_negative_prompt, "")

    def test_invalid_payload_returns_fallback_error(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=InvalidPayloadAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_negative_prompt, "")

    def test_adapter_error_returns_fallback_error(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=ErrorAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_negative_prompt, "")

    def test_timeout_returns_fallback_error(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=30,
            provider_name="stub",
            adapter=SlowAdapter(),
        )
        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_negative_prompt, "")

    def test_timeout_defers_unload_until_background_call_finishes(self):
        adapter = SlowUnloadAwareAdapter()
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=30,
            provider_name="stub",
            adapter=adapter,
        )

        result = asyncio.run(
            transformer.transform_negative_prompt(
                "low quality",
                use_negative_prompt_transform=True,
            )
        )

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertIn(adapter.unload_count, {0, 1})
        self.assertFalse(adapter.unloaded_while_active)

        self.assertTrue(adapter.finished.wait(timeout=1.0))
        time.sleep(0.05)

        self.assertEqual(adapter.unload_count, 1)
        self.assertFalse(adapter.unloaded_while_active)

    def test_busy_mode_rejects_when_slot_is_occupied(self):
        transformer = NegativePromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=StructuredNegativeAdapter(),
            queue_mode="busy",
            max_wait_ms=500,
        )

        self.assertTrue(transformer._acquire_transform_slot()[0])
        try:
            result = asyncio.run(
                transformer.transform_negative_prompt(
                    "low quality",
                    use_negative_prompt_transform=True,
                )
            )
        finally:
            transformer._release_transform_slot()

        self.assertEqual(result.transform_status, "busy")
        self.assertEqual(result.transformed_negative_prompt, "")
        self.assertEqual(result.error, "Negative prompt transformer is busy with a previous request.")


if __name__ == "__main__":
    unittest.main()
