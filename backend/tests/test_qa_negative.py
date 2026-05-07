"""
METHOD 3 — Negative tests: boundary values, invalid inputs, attack vectors.
Every test verifies that the system rejects bad input gracefully (no 500 crashes).
"""
import io
import unittest

from PIL import Image
from fastapi.testclient import TestClient

from main import app, _merge_negative_prompt_terms, _normalize_active_tool


def _png(size=(64, 64), mode="RGB", color=(100, 100, 100)) -> bytes:
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class TestValidationBoundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    # ── /tools/spot-heal ────────────────────────────────────────────────────

    def test_spot_heal_negative_center_rejected(self):
        r = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "-1", "center_y": "10"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_spot_heal_out_of_bounds_center_rejected(self):
        r = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "9999", "center_y": "9999"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_spot_heal_zero_radius_rejected(self):
        r = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "32", "center_y": "32", "radius": "0"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_spot_heal_oversized_mask_blur_rejected(self):
        r = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "32", "center_y": "32", "mask_blur": "999"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_spot_heal_non_image_file_rejected(self):
        r = self.client.post(
            "/tools/spot-heal",
            data={"center_x": "32", "center_y": "32"},
            files={"init_image": ("i.png", b"not_an_image", "image/png")},
        )
        self.assertEqual(r.status_code, 400)

    # ── /tools/clone-stamp ──────────────────────────────────────────────────

    def test_clone_stamp_negative_source_rejected(self):
        r = self.client.post(
            "/tools/clone-stamp",
            data={"source_x": "-5", "source_y": "10", "target_x": "30", "target_y": "30"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_clone_stamp_oversized_radius_rejected(self):
        r = self.client.post(
            "/tools/clone-stamp",
            data={
                "source_x": "10", "source_y": "10",
                "target_x": "30", "target_y": "30",
                "radius": "9999",
            },
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_clone_stamp_missing_target_rejected(self):
        r = self.client.post(
            "/tools/clone-stamp",
            data={"source_x": "10", "source_y": "10"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    # ── /tools/quick-select/refine ──────────────────────────────────────────

    def test_quick_select_negative_width_rejected(self):
        r = self.client.post(
            "/tools/quick-select/refine",
            data={
                "selection_left": "10", "selection_top": "10",
                "selection_width": "-5", "selection_height": "20",
            },
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_quick_select_zero_height_rejected(self):
        r = self.client.post(
            "/tools/quick-select/refine",
            data={
                "selection_left": "10", "selection_top": "10",
                "selection_width": "20", "selection_height": "0",
            },
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_quick_select_invalid_lasso_json_rejected(self):
        r = self.client.post(
            "/tools/quick-select/refine",
            data={"selection_points": "not-valid-json"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_quick_select_too_few_lasso_points_rejected(self):
        r = self.client.post(
            "/tools/quick-select/refine",
            data={"selection_points": "[[10,10],[20,20]]"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    def test_quick_select_out_of_bounds_lasso_point_rejected(self):
        r = self.client.post(
            "/tools/quick-select/refine",
            data={"selection_points": "[[1000,1000],[1001,1001],[1002,1002]]"},
            files={"init_image": ("i.png", _png(), "image/png")},
        )
        self.assertEqual(r.status_code, 422)

    # ── /upscale ────────────────────────────────────────────────────────────

    def test_upscale_non_image_bytes_rejected(self):
        r = self.client.post(
            "/upscale",
            data={"scale_factor": "2.0"},
            files={"image": ("i.png", b"garbage", "image/png")},
        )
        self.assertIn(r.status_code, (400, 422, 500))

    # ── /history/delete ─────────────────────────────────────────────────────

    def test_history_delete_path_traversal_url_encoded(self):
        r = self.client.post(
            "/history/delete",
            json={"url": "/outputs/%2e%2e%2fetc%2fpasswd"},
        )
        self.assertEqual(r.status_code, 400)

    def test_history_delete_absolute_path_rejected(self):
        r = self.client.post(
            "/history/delete",
            json={"url": "/etc/shadow"},
        )
        self.assertEqual(r.status_code, 400)

    # ── /cancel ─────────────────────────────────────────────────────────────

    def test_cancel_whitespace_only_request_id_rejected(self):
        r = self.client.post("/cancel", json={"request_id": "   "})
        self.assertEqual(r.status_code, 400)


class TestMergeNegativePromptTermsPure(unittest.TestCase):
    """Pure unit tests for the merge helper — no HTTP."""

    def test_empty_base_and_extra_returns_empty(self):
        self.assertEqual(_merge_negative_prompt_terms(None, None), "")

    def test_base_only_returns_base_terms(self):
        result = _merge_negative_prompt_terms("low quality, blurry", None)
        self.assertEqual(result, "low quality, blurry")

    def test_extra_only_returns_extra_terms(self):
        result = _merge_negative_prompt_terms(None, "artifact, noise")
        self.assertEqual(result, "artifact, noise")

    def test_duplicates_deduplicated_case_insensitive(self):
        result = _merge_negative_prompt_terms("Low Quality, blurry", "Blurry, artifact")
        terms = [t.strip() for t in result.split(",")]
        lower_terms = [t.lower() for t in terms]
        self.assertEqual(len(lower_terms), len(set(lower_terms)), "Duplicates found: " + result)

    def test_order_base_before_extra(self):
        result = _merge_negative_prompt_terms("aaa", "bbb")
        self.assertIn("aaa", result)
        self.assertIn("bbb", result)
        self.assertLess(result.index("aaa"), result.index("bbb"))

    def test_whitespace_only_terms_ignored(self):
        result = _merge_negative_prompt_terms("  ,  ,  ", "  ,  ")
        self.assertEqual(result, "")


class TestNormalizeActiveTool(unittest.TestCase):
    def test_valid_tools_returned_as_is(self):
        for tool in ("sketch", "mask", "hand", "eraser", "clone_stamp", "spot_heal", "quick_select"):
            self.assertEqual(_normalize_active_tool(tool), tool)

    def test_unknown_tool_returns_none(self):
        self.assertEqual(_normalize_active_tool("flying_saucer"), "none")

    def test_none_returns_none(self):
        self.assertEqual(_normalize_active_tool(None), "none")

    def test_empty_string_returns_none(self):
        self.assertEqual(_normalize_active_tool(""), "none")

    def test_uppercase_tool_normalized(self):
        self.assertEqual(_normalize_active_tool("SKETCH"), "sketch")

    def test_extra_whitespace_stripped(self):
        self.assertEqual(_normalize_active_tool("  mask  "), "mask")


if __name__ == "__main__":
    unittest.main()
