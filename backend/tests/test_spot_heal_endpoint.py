import io
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image

import main as app_main


def _png_bytes(size=(64, 64), color=(128, 128, 128, 255)) -> bytes:
    image = Image.new("RGBA", size, color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class SpotHealEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app_main.app)

    def test_spot_heal_success_with_init_and_mask(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake-spot-heal.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
            "mask_image": ("mask.png", _png_bytes(color=(255, 255, 255, 255)), "image/png"),
        }
        data = {
            "width": "64",
            "height": "64",
            "prompt": "clean blemish",
            "negative_prompt": "artifact",
        }

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/spot-heal", data=data, files=files)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("status"), "success")
        self.assertEqual(len(captured_calls), 1)
        self.assertEqual(captured_calls[0]["active_tool"], "spot_heal")
        self.assertIsNotNone(captured_calls[0]["init_image"])
        self.assertIsNotNone(captured_calls[0]["mask_image"])

    def test_spot_heal_requires_mask_image(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            return {"status": "success", "url": "/outputs/fake-spot-heal.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
        }
        data = {"width": "64", "height": "64"}

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/spot-heal", data=data, files=files)

        self.assertEqual(response.status_code, 422)
        self.assertEqual(len(captured_calls), 0)

    def test_spot_heal_rejects_invalid_mask_image(self):
        captured_calls = []

        async def fake_generate_image(**kwargs):
            captured_calls.append(kwargs)
            if kwargs["mask_image"].filename.endswith(".txt"):
                raise HTTPException(status_code=422, detail="Invalid mask image format.")
            return {"status": "success", "url": "/outputs/fake-spot-heal.png"}

        files = {
            "init_image": ("init.png", _png_bytes(), "image/png"),
            "mask_image": ("mask.txt", b"not-an-image", "text/plain"),
        }
        data = {"width": "64", "height": "64"}

        with patch.object(app_main, "generate_image", new=fake_generate_image):
            response = self.client.post("/spot-heal", data=data, files=files)

        self.assertEqual(response.status_code, 422)
        self.assertEqual(len(captured_calls), 1)
        self.assertIn("Invalid mask image format", str(response.json().get("detail", "")))


if __name__ == "__main__":
    unittest.main()
