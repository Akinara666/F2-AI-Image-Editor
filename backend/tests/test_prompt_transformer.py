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


class ResidentAdapter(BasePromptLLMAdapter):
    """Adapter that gains nothing from per-call unloading (e.g. CPU-only)."""

    def __init__(self):
        super().__init__()
        self.unload_count = 0

    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {
            "positive_prompt": f"resident::{prompt}",
            "negative_prompt_extra": "",
            "style_tags": [],
        }

    def should_unload_after_call(self) -> bool:
        return False

    def _unload_now_locked(self) -> None:
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
        self.assertIn(adapter.unload_count, {0, 1})
        self.assertFalse(adapter.unloaded_while_active)

        self.assertTrue(adapter.finished.wait(timeout=1.0))
        time.sleep(0.05)

        self.assertEqual(adapter.unload_count, 1)
        self.assertFalse(adapter.unloaded_while_active)

    def test_busy_transform_requests_are_rejected_while_slot_is_occupied(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=5000,
            provider_name="stub",
            adapter=StructuredAdapter(),
        )
        gen = transformer._try_acquire_transform_slot()
        self.assertGreater(gen, 0)
        try:
            result = asyncio.run(transformer.transform_prompt("second", use_prompt_transform=True))
        finally:
            transformer._release_transform_slot(gen)

        self.assertEqual(result.transform_status, "busy")
        self.assertEqual(result.transformed_prompt, "")
        self.assertEqual(result.error, "Prompt transformer is busy with a previous request.")

    def test_resident_adapter_is_not_unloaded_even_when_unload_after_call(self):
        adapter = ResidentAdapter()
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=adapter,
            unload_after_call=True,
        )

        result = asyncio.run(transformer.transform_prompt("hello", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(adapter.unload_count, 0)


class QwenInferenceLockTests(unittest.TestCase):
    """llama.cpp is not thread-safe: concurrent create_chat_completion on the
    same Llama object segfaults. The adapter must serialise inference so a retry
    after a timeout never races into native code while the old call still runs."""

    def test_inference_is_serialised_on_shared_llama(self):
        from core.llm_adapter import QwenGGUFLoraAdapter

        concurrency = {"current": 0, "max": 0}
        guard = threading.Lock()

        class FakeLlama:
            def create_chat_completion(self, **kwargs):
                with guard:
                    concurrency["current"] += 1
                    concurrency["max"] = max(concurrency["max"], concurrency["current"])
                time.sleep(0.1)
                with guard:
                    concurrency["current"] -= 1
                return {"choices": [{"message": {"content":
                    '{"positive_prompt":"x","negative_prompt_extra":"","style_tags":[]}'}}]}

        adapter = QwenGGUFLoraAdapter(model_path="dummy")
        adapter._llm = FakeLlama()  # bypass real model load (ensure_loaded sees it set)

        errors = []

        def worker():
            try:
                adapter.run_transform("hello")
            except Exception as exc:  # pragma: no cover - surface unexpected failure
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        # Without the lock, several inferences would overlap (max > 1) and crash
        # llama.cpp. The lock must keep it strictly sequential.
        self.assertEqual(concurrency["max"], 1)


if __name__ == "__main__":
    unittest.main()
