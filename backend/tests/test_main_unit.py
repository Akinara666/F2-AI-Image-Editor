import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from fastapi import HTTPException

from core.config import settings
from main import (
    MAX_GENERATION_PIXELS,
    _append_token_to_url,
    _build_quick_select_mask,
    _normalize_model_family,
    _parse_selection_points,
    _resolve_output_path_from_url,
    _resolve_preview_method,
    _validate_generation_inputs,
)


class TestPreviewMethodResolution(unittest.TestCase):
    def test_server_default_delegates_to_preview_decoder(self):
        with patch('main.preview_decoder.normalize_method', return_value='approx_nn') as normalize_method:
            result = _resolve_preview_method('server_default')

        self.assertEqual(result, 'approx_nn')
        normalize_method.assert_called_once()

    def test_explicit_preview_method_is_returned_as_is(self):
        self.assertEqual(_resolve_preview_method('taesd'), 'taesd')

    def test_invalid_preview_method_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            _resolve_preview_method('broken-preview')

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('preview_method must be one of', ctx.exception.detail)


class TestModelAndGenerationValidation(unittest.TestCase):
    def test_normalize_model_family_accepts_uppercase_with_spaces(self):
        self.assertEqual(_normalize_model_family(' SDXL '), 'sdxl')

    def test_normalize_model_family_rejects_unknown_value(self):
        with self.assertRaises(HTTPException) as ctx:
            _normalize_model_family('anime')

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('model_family must be one of', ctx.exception.detail)

    def test_validate_generation_inputs_returns_normalized_payload(self):
        allowed_models = {
            'model-alpha': {
                'id': 'model-alpha',
                'label': 'Model Alpha',
                'family': 'sdxl',
            }
        }

        with patch('main._get_allowed_model_map', return_value=allowed_models):
            payload = _validate_generation_inputs(
                width=512,
                height=512,
                steps=20,
                cfg=7.5,
                seed=42,
                model_id='model-alpha',
                model_family=' SDXL ',
                sampler='Euler a',
                mode='auto',
                style_preset=None,
                denoising_strength=0.75,
                mask_blur=4,
                mask_padding=32,
            )

        self.assertEqual(payload['model_id'], 'model-alpha')
        self.assertEqual(payload['model_family'], 'sdxl')
        self.assertEqual(payload['width'], 512)
        self.assertEqual(payload['height'], 512)
        self.assertEqual(payload['steps'], 20)

    def test_validate_generation_inputs_rejects_family_mismatch(self):
        allowed_models = {
            'model-alpha': {
                'id': 'model-alpha',
                'label': 'Model Alpha',
                'family': 'sdxl',
            }
        }

        with patch('main._get_allowed_model_map', return_value=allowed_models):
            with self.assertRaises(HTTPException) as ctx:
                _validate_generation_inputs(
                    width=512,
                    height=512,
                    steps=20,
                    cfg=7.5,
                    seed=42,
                    model_id='model-alpha',
                    model_family='sd',
                    sampler='Euler a',
                    mode='auto',
                    style_preset=None,
                    denoising_strength=0.75,
                    mask_blur=4,
                    mask_padding=32,
                )

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('does not match selected model family', ctx.exception.detail)

    def test_validate_generation_inputs_rejects_oversized_area(self):
        allowed_models = {
            'model-alpha': {
                'id': 'model-alpha',
                'label': 'Model Alpha',
                'family': 'sd',
            }
        }

        with patch('main._get_allowed_model_map', return_value=allowed_models):
            with self.assertRaises(HTTPException) as ctx:
                _validate_generation_inputs(
                    width=2048,
                    height=2048,
                    steps=20,
                    cfg=7.5,
                    seed=42,
                    model_id='model-alpha',
                    model_family='sd',
                    sampler='Euler a',
                    mode='auto',
                    style_preset=None,
                    denoising_strength=0.75,
                    mask_blur=4,
                    mask_padding=32,
                )

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn(str(MAX_GENERATION_PIXELS), ctx.exception.detail)

    def test_validate_generation_inputs_rejects_unknown_sampler(self):
        allowed_models = {
            'model-alpha': {
                'id': 'model-alpha',
                'label': 'Model Alpha',
                'family': 'sd',
            }
        }

        with patch('main._get_allowed_model_map', return_value=allowed_models):
            with self.assertRaises(HTTPException) as ctx:
                _validate_generation_inputs(
                    width=512,
                    height=512,
                    steps=20,
                    cfg=7.5,
                    seed=42,
                    model_id='model-alpha',
                    model_family='sd',
                    sampler='Unknown Sampler',
                    mode='auto',
                    style_preset=None,
                    denoising_strength=0.75,
                    mask_blur=4,
                    mask_padding=32,
                )

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('Unsupported sampler', ctx.exception.detail)


class TestQuickSelectionHelpers(unittest.TestCase):
    def test_parse_selection_points_accepts_arrays_and_dicts(self):
        points = _parse_selection_points(
            '[[1, 2], {"x": 3, "y": 4}, [5, 6, 999]]',
            width=32,
            height=32,
        )

        self.assertEqual(points, [(1, 2), (3, 4), (5, 6)])

    def test_parse_selection_points_rejects_invalid_json(self):
        with self.assertRaises(HTTPException) as ctx:
            _parse_selection_points('not-json', width=32, height=32)

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('valid JSON', ctx.exception.detail)

    def test_parse_selection_points_rejects_out_of_bounds_points(self):
        with self.assertRaises(HTTPException) as ctx:
            _parse_selection_points('[[1, 2], [3, 4], [99, 99]]', width=32, height=32)

        self.assertEqual(ctx.exception.status_code, 422)
        self.assertIn('inside image bounds', ctx.exception.detail)

    def test_build_quick_select_mask_clamps_selection_to_canvas_bounds(self):
        mask = _build_quick_select_mask(
            width=32,
            height=32,
            selection_left=28,
            selection_top=28,
            selection_width=10,
            selection_height=10,
        )

        self.assertEqual(mask.size, (32, 32))
        self.assertEqual(mask.getpixel((31, 31)), 255)
        self.assertEqual(mask.getpixel((0, 0)), 0)

    def test_build_quick_select_mask_supports_feathering(self):
        mask = _build_quick_select_mask(
            width=64,
            height=64,
            selection_left=16,
            selection_top=16,
            selection_width=24,
            selection_height=24,
            feather=4,
        )

        histogram = mask.histogram()
        self.assertTrue(any(count > 0 for count in histogram[1:255]))


class TestUrlAndPathHelpers(unittest.TestCase):
    def test_append_token_to_url_adds_new_query_parameter(self):
        url = _append_token_to_url('https://example.com/model', 'secret-token')
        query = parse_qs(urlparse(url).query)

        self.assertEqual(query['token'], ['secret-token'])

    def test_append_token_to_url_preserves_existing_query_parameters(self):
        url = _append_token_to_url('https://example.com/model?type=full&token=old', 'new-token')
        query = parse_qs(urlparse(url).query)

        self.assertEqual(query['type'], ['full'])
        self.assertEqual(query['token'], ['new-token'])

    def test_resolve_output_path_from_url_supports_query_string(self):
        path = _resolve_output_path_from_url('/outputs/nested/file.png?ts=123')

        self.assertEqual(path, (settings.OUTPUT_DIR / 'nested/file.png').resolve())

    def test_resolve_output_path_from_url_rejects_directory_escape(self):
        with self.assertRaises(HTTPException) as ctx:
            _resolve_output_path_from_url('/outputs/../secret.txt')

        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn('escapes OUTPUT_DIR', ctx.exception.detail)


if __name__ == '__main__':
    unittest.main()
