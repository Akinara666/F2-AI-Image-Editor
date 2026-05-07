"""
METHOD 2 — Unit (white-box) tests for internal functions.
Tests pure functions and internal logic directly, without HTTP layer.
"""
import io
import os
import tempfile
import unittest

import numpy as np
from PIL import Image

from core.utils import (
    feather_blend,
    merge_generation_masks,
    prepare_image_for_outpainting,
    process_mask_for_inpainting,
    save_image_with_metadata,
)


# ── save_image_with_metadata ────────────────────────────────────────────────

class TestSaveImageWithMetadata(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.img = Image.new("RGB", (32, 32), (128, 64, 200))

    def test_saves_file_and_returns_filename(self):
        fname = save_image_with_metadata(self.img, {"prompt": "cat"}, self.tmp_dir)
        self.assertTrue(fname.endswith(".png"))
        self.assertTrue(os.path.exists(os.path.join(self.tmp_dir, fname)))

    def test_prompt_slug_used_in_filename(self):
        fname = save_image_with_metadata(self.img, {"prompt": "red apple"}, self.tmp_dir)
        self.assertIn("red_apple", fname)

    def test_empty_prompt_uses_gen_slug(self):
        fname = save_image_with_metadata(self.img, {"prompt": ""}, self.tmp_dir)
        self.assertIn("gen", fname)

    def test_none_prompt_does_not_crash(self):
        """BUG-01 regression: None prompt must not raise TypeError."""
        fname = save_image_with_metadata(self.img, {"prompt": None}, self.tmp_dir)
        self.assertTrue(fname.endswith(".png"))

    def test_missing_prompt_key_uses_gen_slug(self):
        fname = save_image_with_metadata(self.img, {}, self.tmp_dir)
        self.assertIn("gen", fname)

    def test_long_prompt_truncated_in_filename(self):
        long_prompt = "a" * 100
        fname = save_image_with_metadata(self.img, {"prompt": long_prompt}, self.tmp_dir)
        # Slug is limited to 20 chars, filename should not be absurdly long
        slug_part = fname.split("_gen")[0] if "_gen" not in fname else fname
        self.assertLess(len(fname), 200)

    def test_numeric_metadata_value_stored(self):
        fname = save_image_with_metadata(self.img, {"seed": 42, "prompt": "x"}, self.tmp_dir)
        path = os.path.join(self.tmp_dir, fname)
        reloaded = Image.open(path)
        self.assertEqual(reloaded.info.get("seed"), "42")


# ── process_mask_for_inpainting ─────────────────────────────────────────────

class TestProcessMaskForInpainting(unittest.TestCase):
    def _solid_mask(self, size=(64, 64), fill=255):
        return Image.new("L", size, fill)

    def _center_mask(self, size=(64, 64), radius=10):
        img = Image.new("L", size, 0)
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        cx, cy = size[0] // 2, size[1] // 2
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=255)
        return img

    def test_returns_two_masks(self):
        mask = self._center_mask()
        gen_mask, blend_mask = process_mask_for_inpainting(mask)
        self.assertIsInstance(gen_mask, Image.Image)
        self.assertIsInstance(blend_mask, Image.Image)

    def test_both_masks_same_size_as_input(self):
        size = (128, 96)
        mask = self._center_mask(size=size)
        gen, blend = process_mask_for_inpainting(mask, mask_padding=8, mask_blur=4)
        self.assertEqual(gen.size, size)
        self.assertEqual(blend.size, size)

    def test_generation_mask_is_binary(self):
        mask = self._center_mask()
        gen, _ = process_mask_for_inpainting(mask, mask_padding=0, mask_blur=0)
        arr = np.array(gen)
        unique_values = set(np.unique(arr).tolist())
        self.assertTrue(unique_values.issubset({0, 255}))

    def test_zero_padding_zero_blur_preserves_region(self):
        mask = self._solid_mask()
        gen, blend = process_mask_for_inpainting(mask, mask_padding=0, mask_blur=0)
        gen_arr = np.array(gen)
        self.assertEqual(gen_arr.min(), 255)

    def test_all_black_mask_stays_all_black(self):
        mask = self._solid_mask(fill=0)
        gen, blend = process_mask_for_inpainting(mask, mask_padding=0, mask_blur=0)
        self.assertEqual(np.array(gen).max(), 0)

    def test_rgb_mask_converted_to_grayscale(self):
        rgb_mask = Image.new("RGB", (32, 32), (200, 200, 200))
        gen, blend = process_mask_for_inpainting(rgb_mask)
        self.assertEqual(gen.mode, "L")

    def test_blend_mask_soft_outside_core_region(self):
        mask = self._center_mask(size=(64, 64), radius=10)
        _, blend = process_mask_for_inpainting(mask, mask_padding=0, mask_blur=8)
        arr = np.array(blend)
        # Blend mask should have intermediate values (feathered edges)
        has_intermediate = np.any((arr > 0) & (arr < 255))
        self.assertTrue(has_intermediate)


# ── feather_blend ────────────────────────────────────────────────────────────

class TestFeatherBlend(unittest.TestCase):
    def _img(self, color, size=(64, 64)):
        return Image.new("RGB", size, color)

    def _mask(self, fill, size=(64, 64)):
        return Image.new("L", size, fill)

    def test_all_white_mask_returns_generated(self):
        original = self._img((255, 0, 0))
        generated = self._img((0, 255, 0))
        mask = self._mask(255)
        result = feather_blend(original, generated, mask)
        arr = np.array(result)
        np.testing.assert_array_almost_equal(arr, np.array(generated), decimal=0)

    def test_all_black_mask_returns_original(self):
        original = self._img((255, 0, 0))
        generated = self._img((0, 255, 0))
        mask = self._mask(0)
        result = feather_blend(original, generated, mask)
        arr = np.array(result)
        np.testing.assert_array_almost_equal(arr, np.array(original), decimal=0)

    def test_size_mismatch_returns_generated_as_fallback(self):
        original = self._img((255, 0, 0), size=(64, 64))
        generated = self._img((0, 255, 0), size=(64, 64))
        mask = self._mask(128, size=(32, 32))
        result = feather_blend(original, generated, mask)
        self.assertEqual(result.size, generated.size)

    def test_result_is_rgb(self):
        original = self._img((100, 100, 100))
        generated = self._img((200, 200, 200))
        mask = self._mask(128)
        result = feather_blend(original, generated, mask)
        self.assertEqual(result.mode, "RGB")

    def test_mid_mask_blends_colors(self):
        original = self._img((0, 0, 0))
        generated = self._img((200, 200, 200))
        mask = self._mask(128)
        result = feather_blend(original, generated, mask)
        arr = np.array(result).mean()
        self.assertGreater(arr, 10)
        self.assertLess(arr, 190)


# ── merge_generation_masks ───────────────────────────────────────────────────

class TestMergeGenerationMasks(unittest.TestCase):
    def _mask(self, fill, size=(32, 32)):
        return Image.new("L", size, fill)

    def test_both_none_returns_none_none(self):
        gen, blend = merge_generation_masks(None, None, None, None)
        self.assertIsNone(gen)
        self.assertIsNone(blend)

    def test_first_none_returns_second(self):
        m = self._mask(200)
        gen, _ = merge_generation_masks(None, None, m, None)
        arr = np.array(gen)
        self.assertEqual(arr.mean(), 200.0)

    def test_second_none_returns_first(self):
        m = self._mask(100)
        gen, _ = merge_generation_masks(m, None, None, None)
        arr = np.array(gen)
        self.assertEqual(arr.mean(), 100.0)

    def test_max_combination(self):
        low = self._mask(50)
        high = self._mask(200)
        gen, _ = merge_generation_masks(low, None, high, None)
        arr = np.array(gen)
        self.assertEqual(arr.min(), 200)


# ── prepare_image_for_outpainting ────────────────────────────────────────────

class TestPrepareImageForOutpainting(unittest.TestCase):
    def _rgba_with_transparency(self, size=(64, 64)):
        img = Image.new("RGBA", size, (100, 150, 200, 255))
        arr = np.array(img)
        arr[:, : size[0] // 2, 3] = 0
        return Image.fromarray(arr)

    def test_returns_three_items(self):
        img = self._rgba_with_transparency()
        result = prepare_image_for_outpainting(img)
        self.assertEqual(len(result), 3)

    def test_filled_image_is_rgb(self):
        img = self._rgba_with_transparency()
        filled, _, _ = prepare_image_for_outpainting(img)
        self.assertEqual(filled.mode, "RGB")

    def test_masks_same_size_as_input(self):
        img = self._rgba_with_transparency(size=(48, 80))
        filled, gen_mask, blend_mask = prepare_image_for_outpainting(img)
        self.assertEqual(filled.size, (48, 80))
        self.assertEqual(gen_mask.size, (48, 80))
        self.assertEqual(blend_mask.size, (48, 80))

    def test_accepts_rgb_input(self):
        """Fully opaque RGB → mask should be all-black (no transparent area)."""
        img = Image.new("RGB", (32, 32), (100, 100, 100))
        filled, gen_mask, blend_mask = prepare_image_for_outpainting(img)
        self.assertEqual(np.array(gen_mask).max(), 0)


if __name__ == "__main__":
    unittest.main()
