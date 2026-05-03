import io
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from tests.app_test_bootstrap import load_app_main

app_main = load_app_main()


def _png_bytes(size=(64, 64), color=(128, 128, 128, 255)) -> bytes:
    image = Image.new("RGBA", size, color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class GenerationLifecycleEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app_main.app)

    def test_cancel_generation_returns_cancelling_and_request_id(self):
        with patch.object(app_main.model_manager, "request_cancel") as request_cancel:
            response = self.client.post("/cancel", json={"request_id": "req-123"})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "cancelling")
        self.assertEqual(payload.get("request_id"), "req-123")
        request_cancel.assert_called_once_with("req-123")

    def test_cancel_generation_rejects_empty_request_id(self):
        with patch.object(app_main.model_manager, "request_cancel") as request_cancel:
            response = self.client.post("/cancel", json={"request_id": "   "})

        self.assertEqual(response.status_code, 400)
        self.assertIn("request_id is required", str(response.json().get("detail", "")))
        request_cancel.assert_not_called()

    def test_spot_heal_forwards_request_id_to_generation_flow(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png", "request_id": kwargs.get("request_id")}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
            "mask_image": ("mask.png", _png_bytes(color=(255, 255, 255, 255)), "image/png"),
        }
        data = {
            "request_id": "spot-req-1",
            "width": "64",
            "height": "64",
        }

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/spot-heal", data=data, files=files)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("status"), "success")
        self.assertEqual(len(captured_calls), 1)
        self.assertEqual(captured_calls[0].get("request_id"), "spot-req-1")

    def test_quick_select_refine_forwards_request_id_to_generation_flow(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png", "request_id": kwargs.get("request_id")}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
            "mask_image": ("mask.png", _png_bytes(color=(255, 255, 255, 255)), "image/png"),
        }
        data = {
            "request_id": "quick-req-1",
            "width": "64",
            "height": "64",
        }

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/quick-select/refine", data=data, files=files)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("status"), "success")
        self.assertEqual(len(captured_calls), 1)
        self.assertEqual(captured_calls[0].get("request_id"), "quick-req-1")


if __name__ == "__main__":
    unittest.main()
