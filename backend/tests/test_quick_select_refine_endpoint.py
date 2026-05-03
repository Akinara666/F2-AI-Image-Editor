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


class QuickSelectRefineEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app_main.app)

    def test_quick_select_refine_accepts_mask_image_without_selection_fields(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
            "mask_image": ("mask.png", _png_bytes(color=(255, 255, 255, 255)), "image/png"),
        }
        data = {"width": "64", "height": "64", "prompt": "refine object"}

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/quick-select/refine", data=data, files=files)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("status"), "success")
        self.assertEqual(len(captured_calls), 1)
        self.assertEqual(captured_calls[0]["active_tool"], "quick_select")
        self.assertIsNotNone(captured_calls[0]["mask_image"])
        self.assertEqual(captured_calls[0]["mask_image"].filename, "mask.png")

    def test_quick_select_refine_uses_rect_fallback_when_mask_missing(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
        }
        data = {
            "width": "64",
            "height": "64",
            "selection_left": "8",
            "selection_top": "8",
            "selection_width": "24",
            "selection_height": "20",
        }

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/quick-select/refine", data=data, files=files)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("status"), "success")
        self.assertEqual(len(captured_calls), 1)
        generated_mask_upload = captured_calls[0]["mask_image"]
        self.assertIsNotNone(generated_mask_upload)
        self.assertEqual(generated_mask_upload.filename, "quick-select-mask.png")
        generated_mask_upload.file.seek(0)
        self.assertGreater(len(generated_mask_upload.file.read()), 0)

    def test_quick_select_refine_rejects_when_no_mask_and_no_selection(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
        }
        data = {"width": "64", "height": "64"}

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/quick-select/refine", data=data, files=files)

        self.assertEqual(response.status_code, 422)
        self.assertEqual(len(captured_calls), 0)
        self.assertIn("requires either mask_image", str(response.json().get("detail", "")))

    def test_quick_select_refine_rejects_invalid_selection_bounds(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
        }

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            out_of_bounds_response = self.client.post(
                "/quick-select/refine",
                data={
                    "width": "64",
                    "height": "64",
                    "selection_left": "60",
                    "selection_top": "4",
                    "selection_width": "12",
                    "selection_height": "10",
                },
                files=files,
            )
            zero_size_response = self.client.post(
                "/quick-select/refine",
                data={
                    "width": "64",
                    "height": "64",
                    "selection_left": "4",
                    "selection_top": "4",
                    "selection_width": "0",
                    "selection_height": "12",
                },
                files={
                    "init_image": ("init.png", _png_bytes(), "image/png"),
                },
            )

        self.assertEqual(out_of_bounds_response.status_code, 422)
        self.assertEqual(zero_size_response.status_code, 422)
        self.assertEqual(len(captured_calls), 0)


if __name__ == "__main__":
    unittest.main()
