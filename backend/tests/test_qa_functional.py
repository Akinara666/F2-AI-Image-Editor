"""
METHOD 1 — Functional (black-box) tests for HTTP endpoints.
Tests endpoints as a consumer would: only observing inputs/outputs, no internals.
"""
import io
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

from main import app
from core.config import settings
from core.generation_preview import generation_preview_store


def _rgb_png(size=(64, 64), color=(100, 150, 200)) -> bytes:
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _rgba_png(size=(64, 64)) -> bytes:
    img = Image.new("RGBA", size, (100, 150, 200, 128))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _mask_png(size=(64, 64)) -> bytes:
    img = Image.new("L", size, 0)
    draw = ImageDraw.Draw(img)
    draw.ellipse((10, 10, 50, 50), fill=255)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestHealthEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_returns_ok(self):
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok"})

    def test_root_returns_message(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("message", r.json())

    def test_models_returns_list(self):
        r = self.client.get("/models")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("models", body)
        self.assertIsInstance(body["models"], list)

    def test_models_merges_cloud_managed_and_local_entries(self):
        managed_entries = [
            {"id": "managed:test-model", "label": "Managed Test", "family": "sdxl"}
        ]
        local_entries = [
            {"id": "/tmp/local-model.safetensors", "label": "Local Test", "family": "sd"}
        ]

        with patch('main._get_managed_model_entries', return_value=managed_entries), patch(
            'main._get_local_model_entries',
            return_value=local_entries,
        ):
            response = self.client.get('/models')

        self.assertEqual(response.status_code, 200)
        models = response.json()['models']
        model_ids = [model['id'] for model in models]
        self.assertIn('managed:test-model', model_ids)
        self.assertIn('/tmp/local-model.safetensors', model_ids)
        self.assertIn('runwayml/stable-diffusion-v1-5', model_ids)

    def test_models_returns_cloud_models_when_managed_and_local_are_empty(self):
        with patch('main._get_managed_model_entries', return_value=[]), patch(
            'main._get_local_model_entries',
            return_value=[],
        ):
            response = self.client.get('/models')

        self.assertEqual(response.status_code, 200)
        models = response.json()['models']
        self.assertEqual(models, [
            {"id": "runwayml/stable-diffusion-v1-5", "label": "SD v1.5 Base (Cloud)", "family": "sd"},
            {"id": "stabilityai/stable-diffusion-xl-base-1.0", "label": "SDXL Base 1.0 (Cloud)", "family": "sdxl"},
        ])

    def test_prompt_health_returns_status(self):
        r = self.client.get("/prompt/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "success")
        self.assertIn("data", body)


class TestCancelEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_cancel_valid_request_id(self):
        r = self.client.post("/cancel", json={"request_id": "test-req-001"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "cancelling")
        self.assertEqual(body.get("request_id"), "test-req-001")

    def test_cancel_empty_request_id_rejected(self):
        r = self.client.post("/cancel", json={"request_id": "   "})
        self.assertEqual(r.status_code, 400)

    def test_cancel_missing_request_id_rejected(self):
        r = self.client.post("/cancel", json={})
        self.assertIn(r.status_code, (400, 422))


class TestHistoryDeleteEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_delete_nonexistent_url_returns_404(self):
        r = self.client.post(
            "/history/delete",
            json={"url": "/outputs/nonexistent_file_abc123.png"},
        )
        self.assertEqual(r.status_code, 404)

    def test_delete_without_url_returns_400(self):
        r = self.client.post("/history/delete", json={})
        self.assertEqual(r.status_code, 400)

    def test_delete_non_outputs_path_returns_400(self):
        r = self.client.post(
            "/history/delete",
            json={"url": "/etc/passwd"},
        )
        self.assertEqual(r.status_code, 400)

    def test_delete_path_traversal_returns_400(self):
        r = self.client.post(
            "/history/delete",
            json={"url": "/outputs/../etc/passwd"},
        )
        self.assertEqual(r.status_code, 400)

    def test_delete_accepts_urls_list(self):
        r = self.client.post(
            "/history/delete",
            json={"urls": ["/outputs/fake1.png", "/outputs/fake2.png"]},
        )
        self.assertIn(r.status_code, (404, 200))

    def test_delete_existing_file_returns_deleted_url(self):
        save_response = self.client.post(
            "/history/save",
            data={"prompt": "delete me"},
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        self.assertEqual(save_response.status_code, 200)
        payload = save_response.json()
        output_path = Path(settings.OUTPUT_DIR) / payload["filename"]
        self.assertTrue(output_path.exists())

        try:
            delete_response = self.client.post(
                "/history/delete",
                json={"url": payload["url"]},
            )
            self.assertEqual(delete_response.status_code, 200)
            delete_payload = delete_response.json()
            self.assertEqual(delete_payload.get("status"), "success")
            self.assertEqual(delete_payload.get("deleted_urls"), [payload["url"]])
            self.assertEqual(delete_payload.get("missing_urls"), [])
            self.assertFalse(output_path.exists())
        finally:
            if output_path.exists():
                output_path.unlink()

    def test_delete_mixed_existing_and_missing_urls_reports_both(self):
        save_response = self.client.post(
            "/history/save",
            data={"prompt": "mixed delete"},
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        self.assertEqual(save_response.status_code, 200)
        payload = save_response.json()
        output_path = Path(settings.OUTPUT_DIR) / payload["filename"]
        missing_url = "/outputs/definitely_missing_for_delete_test.png"

        try:
            delete_response = self.client.post(
                "/history/delete",
                json={"urls": [payload["url"], missing_url]},
            )
            self.assertEqual(delete_response.status_code, 200)
            delete_payload = delete_response.json()
            self.assertEqual(delete_payload.get("deleted_urls"), [payload["url"]])
            self.assertEqual(delete_payload.get("missing_urls"), [missing_url])
            self.assertFalse(output_path.exists())
        finally:
            if output_path.exists():
                output_path.unlink()


class TestHistorySaveEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_save_snapshot_with_prompt(self):
        r = self.client.post(
            "/history/save",
            data={"prompt": "a red apple", "seed": "42"},
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "success")
        self.assertTrue(str(body.get("url", "")).startswith("/outputs/"))

    def test_save_snapshot_without_prompt(self):
        """BUG-01: None prompt must not crash save_image_with_metadata."""
        r = self.client.post(
            "/history/save",
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        # Should succeed — no prompt is a valid use-case
        self.assertEqual(r.status_code, 200)

    def test_save_empty_image_returns_400(self):
        r = self.client.post(
            "/history/save",
            files={"image": ("snap.png", b"", "image/png")},
        )
        self.assertEqual(r.status_code, 400)

    def test_save_invalid_image_bytes_returns_400(self):
        r = self.client.post(
            "/history/save",
            files={"image": ("snap.png", b"not_an_image", "image/png")},
        )
        self.assertEqual(r.status_code, 400)

    def test_save_with_active_tool(self):
        r = self.client.post(
            "/history/save",
            data={"active_tool": "sketch"},
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        self.assertEqual(r.status_code, 200)

    def test_save_persists_metadata_fields(self):
        response = self.client.post(
            "/history/save",
            data={
                "prompt": "metadata prompt",
                "raw_prompt": "raw metadata prompt",
                "negative_prompt": "bad anatomy",
                "seed": "123",
                "active_tool": "  QUICK_SELECT  ",
                "generated_url": "/outputs/generated-source.png",
            },
            files={"image": ("snap.png", _rgb_png(), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        output_path = Path(settings.OUTPUT_DIR) / payload["filename"]

        try:
            with Image.open(output_path) as saved:
                self.assertEqual(saved.info.get("prompt"), "metadata prompt")
                self.assertEqual(saved.info.get("raw_prompt"), "raw metadata prompt")
                self.assertEqual(saved.info.get("negative_prompt"), "bad anatomy")
                self.assertEqual(saved.info.get("seed"), "123")
                self.assertEqual(saved.info.get("active_tool"), "quick_select")
                self.assertEqual(saved.info.get("generated_url"), "/outputs/generated-source.png")
                self.assertEqual(saved.info.get("history_kind"), "document_snapshot")
        finally:
            if output_path.exists():
                output_path.unlink()


class TestUpscaleEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_upscale_valid_2x(self):
        r = self.client.post(
            "/upscale",
            data={"scale_factor": "2.0"},
            files={"image": ("img.png", _rgb_png(size=(32, 32)), "image/png")},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("status"), "success")

    def test_upscale_zero_scale_factor_rejected(self):
        """BUG-02: scale_factor=0 must be rejected with 4xx, not crash with 500."""
        r = self.client.post(
            "/upscale",
            data={"scale_factor": "0"},
            files={"image": ("img.png", _rgb_png(), "image/png")},
        )
        self.assertIn(r.status_code, (400, 422))

    def test_upscale_negative_scale_factor_rejected(self):
        """BUG-02: Negative scale_factor must be rejected."""
        r = self.client.post(
            "/upscale",
            data={"scale_factor": "-1.0"},
            files={"image": ("img.png", _rgb_png(), "image/png")},
        )
        self.assertIn(r.status_code, (400, 422))

    def test_upscale_extreme_scale_factor_rejected(self):
        """BUG-02: Huge scale_factor risks OOM and must be capped."""
        r = self.client.post(
            "/upscale",
            data={"scale_factor": "500.0"},
            files={"image": ("img.png", _rgb_png(), "image/png")},
        )
        self.assertIn(r.status_code, (400, 422))


class TestPromptTransformEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_transform_returns_success_with_stub_provider(self):
        r = self.client.post(
            "/prompt/transform",
            json={
                "prompt": "a cat sitting on a chair",
                "use_prompt_transform": False,
            },
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "success")

    def test_transform_empty_prompt_accepted(self):
        """BUG-03 regression: empty prompt must return 200 (skipped_empty) even in strict mode."""
        r = self.client.post(
            "/prompt/transform",
            json={"prompt": ""},
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body.get("status"), "success")

    def test_transform_invalid_preview_method_rejected(self):
        r = self.client.post(
            "/prompt/transform",
            json={"prompt": "a cat", "use_prompt_transform": None},
        )
        # Any valid JSON payload must not crash
        self.assertIn(r.status_code, (200, 422))


class TestGenerationPreviewEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_preview_nonexistent_request_returns_404(self):
        r = self.client.get("/generate/preview/nonexistent-req-999")
        self.assertEqual(r.status_code, 404)

    def test_preview_existing_request_returns_payload(self):
        request_id = "preview-success-functional-001"
        preview_image = Image.new("RGB", (24, 24), (255, 0, 0))
        generation_preview_store.start(request_id, total_steps=12)
        generation_preview_store.update(
            request_id,
            step=4,
            total_steps=12,
            image=preview_image,
            status="running",
        )

        try:
            response = self.client.get(f"/generate/preview/{request_id}")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload.get("status"), "success")
            data = payload.get("data", {})
            self.assertEqual(data.get("request_id"), request_id)
            self.assertEqual(data.get("status"), "running")
            self.assertEqual(data.get("step"), 4)
            self.assertEqual(data.get("total_steps"), 12)
            self.assertAlmostEqual(data.get("progress"), 4 / 12)
            self.assertTrue(str(data.get("image_data_url", "")).startswith("data:image/jpeg;base64,"))
        finally:
            generation_preview_store.clear(request_id)


class TestGenerateEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_generate_returns_503_without_ai_runtime(self):
        response = self.client.post(
            "/generate",
            data={"prompt": "a futuristic city"},
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("AI runtime is unavailable", response.json().get("detail", ""))


if __name__ == "__main__":
    unittest.main()
