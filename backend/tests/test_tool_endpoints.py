import io
import unittest

from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

from main import app


class ToolEndpointsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def _png_bytes(self, size=(64, 64), color=(120, 140, 180)):
        image = Image.new("RGB", size, color)
        buff = io.BytesIO()
        image.save(buff, format="PNG")
        return buff.getvalue()

    def _mask_bytes(self, size=(64, 64)):
        image = Image.new("L", size, 0)
        draw = ImageDraw.Draw(image)
        draw.ellipse((20, 20, 44, 44), fill=255)
        buff = io.BytesIO()
        image.save(buff, format="PNG")
        return buff.getvalue()

    def test_spot_heal_accepts_center_without_mask(self):
        response = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "32", "center_y": "32", "radius": "12"},
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "success")
        self.assertTrue(str(payload.get("url", "")).startswith("/outputs/"))

    def test_spot_heal_rejects_without_mask_and_center(self):
        response = self.client.post(
            "/tools/spot-heal",
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 422)

    def test_clone_stamp_success(self):
        response = self.client.post(
            "/tools/clone-stamp",
            data={
                "source_x": "16",
                "source_y": "16",
                "target_x": "40",
                "target_y": "40",
                "radius": "10",
                "feather": "4",
            },
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "success")

    def test_clone_stamp_rejects_out_of_bounds(self):
        response = self.client.post(
            "/tools/clone-stamp",
            data={
                "source_x": "200",
                "source_y": "16",
                "target_x": "40",
                "target_y": "40",
            },
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 422)

    def test_clone_stamp_rejects_non_image_file(self):
        response = self.client.post(
            "/tools/clone-stamp",
            data={
                "source_x": "16",
                "source_y": "16",
                "target_x": "40",
                "target_y": "40",
            },
            files={"init_image": ("init.png", b"not_an_image", "image/png")},
        )
        self.assertEqual(response.status_code, 400)

    def test_quick_select_refine_accepts_mask_image_without_selection_fields(self):
        response = self.client.post(
            "/tools/quick-select/refine",
            files={
                "init_image": ("init.png", self._png_bytes(), "image/png"),
                "mask_image": ("mask.png", self._mask_bytes(), "image/png"),
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "success")

    def test_quick_select_refine_uses_rect_fallback_when_mask_missing(self):
        response = self.client.post(
            "/tools/quick-select/refine",
            data={
                "selection_left": "10",
                "selection_top": "10",
                "selection_width": "20",
                "selection_height": "24",
            },
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "success")

    def test_quick_select_refine_accepts_lasso_points(self):
        response = self.client.post(
            "/tools/quick-select/refine",
            data={"selection_points": "[[10,10],[30,12],[28,30],[12,28]]"},
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload.get("status"), "success")

    def test_quick_select_refine_rejects_when_no_mask_and_no_selection(self):
        response = self.client.post(
            "/tools/quick-select/refine",
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 422)

    def test_quick_select_refine_rejects_invalid_selection_bounds(self):
        response = self.client.post(
            "/tools/quick-select/refine",
            data={
                "selection_left": "60",
                "selection_top": "60",
                "selection_width": "20",
                "selection_height": "24",
            },
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 422)

    def test_quick_select_refine_alias_requires_mask_or_selection(self):
        response = self.client.post(
            "/quick-select/refine",
            data={"width": "64", "height": "64"},
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 422)

    def test_quick_select_refine_alias_returns_503_without_ai_runtime(self):
        response = self.client.post(
            "/quick-select/refine",
            data={
                "width": "64",
                "height": "64",
                "selection_left": "8",
                "selection_top": "8",
                "selection_width": "24",
                "selection_height": "24",
            },
            files={"init_image": ("init.png", self._png_bytes(), "image/png")},
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("AI runtime is unavailable", response.json().get("detail", ""))

    def test_spot_heal_alias_returns_503_without_ai_runtime(self):
        response = self.client.post(
            "/spot-heal",
            data={"width": "64", "height": "64"},
            files={
                "init_image": ("init.png", self._png_bytes(), "image/png"),
                "mask_image": ("mask.png", self._mask_bytes(), "image/png"),
            },
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("AI runtime is unavailable", response.json().get("detail", ""))


if __name__ == "__main__":
    unittest.main()
