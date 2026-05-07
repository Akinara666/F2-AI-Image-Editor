"""
METHOD 1 — Functional (black-box) tests for HTTP endpoints.
Tests endpoints as a consumer would: only observing inputs/outputs, no internals.
"""
import io
import unittest

from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

from main import app


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


if __name__ == "__main__":
    unittest.main()
