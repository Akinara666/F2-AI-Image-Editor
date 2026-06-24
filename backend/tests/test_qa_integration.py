"""
METHOD 4 — Integration tests: component interactions across module boundaries.
Verifies that subsystems work correctly together end-to-end.
"""
import asyncio
import io
import time
import unittest

from PIL import Image

from core.generation_preview import GenerationPreviewStore
from core.llm_adapter import BasePromptLLMAdapter, StubPromptLLMAdapter
from core.negative_prompt_transformer import NegativePromptTransformer
from core.prompt_transformer import PromptTransformer


# ── GenerationPreviewStore lifecycle ────────────────────────────────────────

class TestGenerationPreviewStoreLifecycle(unittest.TestCase):
    def _small_image(self, color=(120, 80, 200)):
        return Image.new("RGB", (16, 16), color)

    def test_start_then_get_returns_pending_record(self):
        store = GenerationPreviewStore()
        store.start("req-1", total_steps=20)
        record = store.get("req-1")
        self.assertIsNotNone(record)
        self.assertEqual(record["total_steps"], 20)
        self.assertEqual(record["step"], 0)
        self.assertEqual(record["status"], "pending")

    def test_update_increments_step_and_embeds_image(self):
        store = GenerationPreviewStore()
        store.start("req-2", total_steps=10)
        store.update("req-2", step=5, total_steps=10, image=self._small_image(), status="running")
        record = store.get("req-2")
        self.assertEqual(record["step"], 5)
        self.assertEqual(record["status"], "running")
        self.assertTrue(str(record["image_data_url"]).startswith("data:image/jpeg;base64,"))

    def test_mark_changes_status_only(self):
        store = GenerationPreviewStore()
        store.start("req-3", total_steps=5)
        store.update("req-3", step=3, total_steps=5, image=self._small_image())
        store.mark("req-3", status="cancelled")
        record = store.get("req-3")
        self.assertEqual(record["status"], "cancelled")
        self.assertEqual(record["step"], 3)

    def test_get_nonexistent_returns_none(self):
        store = GenerationPreviewStore()
        self.assertIsNone(store.get("no-such-request"))

    def test_clear_removes_record(self):
        store = GenerationPreviewStore()
        store.start("req-4", total_steps=10)
        store.clear("req-4")
        self.assertIsNone(store.get("req-4"))

    def test_progress_fraction_calculated_correctly(self):
        store = GenerationPreviewStore()
        store.start("req-5", total_steps=10)
        store.update("req-5", step=7, total_steps=10, image=self._small_image())
        record = store.get("req-5")
        self.assertAlmostEqual(record["progress"], 0.7)

    def test_ttl_prunes_expired_records(self):
        store = GenerationPreviewStore(ttl_seconds=0)
        store.start("req-6", total_steps=5)
        # Force expiry: set updated_at to past
        with store._lock:
            store._records["req-6"].updated_at = time.time() - 1
        # next get() triggers prune
        self.assertIsNone(store.get("req-6"))

    def test_update_without_prior_start_creates_record(self):
        store = GenerationPreviewStore()
        store.update("req-7", step=1, total_steps=5, image=self._small_image())
        record = store.get("req-7")
        self.assertIsNotNone(record)
        self.assertEqual(record["step"], 1)


# ── PromptTransformer + NegativePromptTransformer pipeline ──────────────────

class PosAndNegAdapter(BasePromptLLMAdapter):
    """Adapter that returns structured positive + negative payloads."""
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {
            "positive_prompt": f"enhanced::{prompt}",
            "negative_prompt_extra": "extra_bad",
            "style_tags": ["photorealistic"],
        }


class NegOnlyAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> dict:
        return {"negative_prompt": f"neg::{prompt}"}


class TestPromptAndNegativeTransformerPipeline(unittest.TestCase):
    """Verify the two transformers work correctly in sequence (as in /generate)."""

    def _run(self, coro):
        return asyncio.run(coro)

    def test_both_disabled_pass_through_originals(self):
        pos_transformer = PromptTransformer(
            enabled=False, timeout_ms=1000, provider_name="stub",
            adapter=PosAndNegAdapter(),
        )
        neg_transformer = NegativePromptTransformer(
            enabled=False, timeout_ms=1000, provider_name="stub",
            adapter=NegOnlyAdapter(),
        )
        pos_result = self._run(pos_transformer.transform_prompt("a cat"))
        neg_result = self._run(neg_transformer.transform_negative_prompt("blurry"))
        self.assertEqual(pos_result.transform_status, "disabled")
        self.assertEqual(neg_result.transform_status, "disabled")
        self.assertEqual(pos_result.transformed_prompt, "a cat")
        self.assertEqual(neg_result.transformed_negative_prompt, "blurry")

    def test_both_enabled_chain_produces_enhanced_prompts(self):
        pos_transformer = PromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=PosAndNegAdapter(),
            negative_merge_policy="append",
        )
        neg_transformer = NegativePromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=NegOnlyAdapter(),
        )
        pos_result = self._run(
            pos_transformer.transform_prompt(
                "a cat", use_prompt_transform=True,
                context={"user_negative_prompt": "low quality"},
            )
        )
        self.assertEqual(pos_result.transform_status, "success")
        self.assertIn("enhanced::a cat", pos_result.transformed_prompt)
        self.assertIn("photorealistic", pos_result.transformed_prompt)

        neg_result = self._run(
            neg_transformer.transform_negative_prompt(
                pos_result.transformed_negative_prompt,
                use_negative_prompt_transform=True,
            )
        )
        self.assertEqual(neg_result.transform_status, "success")
        self.assertTrue(neg_result.transformed_negative_prompt.startswith("neg::"))

    def test_positive_failure_does_not_prevent_negative_transform(self):
        class AlwaysFailAdapter(BasePromptLLMAdapter):
            def transform_to_sd(self, prompt, context=None):
                raise RuntimeError("forced failure")

        pos_transformer = PromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=AlwaysFailAdapter(),
        )
        neg_transformer = NegativePromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=NegOnlyAdapter(),
        )
        pos_result = self._run(pos_transformer.transform_prompt("a cat", use_prompt_transform=True))
        self.assertEqual(pos_result.transform_status, "fallback_error")

        # neg transformer should still work independently
        neg_result = self._run(
            neg_transformer.transform_negative_prompt("low quality", use_negative_prompt_transform=True)
        )
        self.assertEqual(neg_result.transform_status, "success")

    def test_stub_adapter_is_identity_and_never_fails(self):
        stub = StubPromptLLMAdapter()
        result = stub.run_transform("hello world", {})
        self.assertEqual(result["positive_prompt"], "hello world")
        self.assertEqual(result["negative_prompt_extra"], "")
        self.assertEqual(result["style_tags"], [])

    def test_empty_prompt_pipeline_produces_skipped_status(self):
        pos_transformer = PromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=PosAndNegAdapter(),
        )
        neg_transformer = NegativePromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=NegOnlyAdapter(),
        )
        pos_result = self._run(pos_transformer.transform_prompt(""))
        neg_result = self._run(neg_transformer.transform_negative_prompt(""))
        self.assertEqual(pos_result.transform_status, "skipped_empty")
        self.assertEqual(neg_result.transform_status, "skipped_empty")


# ── GenerationPreviewStore + prompt pipeline integration ─────────────────────

class TestPreviewStoreWithPromptPipeline(unittest.TestCase):
    """Simulate the full flow: start preview → transform → update preview."""

    def _run(self, coro):
        return asyncio.run(coro)

    def test_full_request_lifecycle(self):
        store = GenerationPreviewStore()
        transformer = PromptTransformer(
            enabled=True, timeout_ms=1000, provider_name="stub",
            adapter=PosAndNegAdapter(),
        )
        request_id = "full-test-001"
        steps = 10

        # Phase 1: Start preview
        store.start(request_id, total_steps=steps)
        record = store.get(request_id)
        self.assertEqual(record["status"], "pending")

        # Phase 2: Transform prompt (simulates the transform pipeline in /generate)
        result = self._run(
            transformer.transform_prompt("sunset over ocean", use_prompt_transform=True)
        )
        self.assertEqual(result.transform_status, "success")

        # Phase 3: Mid-generation update
        img = Image.new("RGB", (8, 8), (80, 120, 200))
        store.update(request_id, step=5, total_steps=steps, image=img, status="running")
        record = store.get(request_id)
        self.assertEqual(record["step"], 5)
        self.assertEqual(record["status"], "running")

        # Phase 4: Completion
        store.update(request_id, step=steps, total_steps=steps, image=img, status="completed")
        record = store.get(request_id)
        self.assertEqual(record["status"], "completed")
        self.assertAlmostEqual(record["progress"], 1.0)


if __name__ == "__main__":
    unittest.main()
