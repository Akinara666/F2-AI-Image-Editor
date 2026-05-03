import types
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

from core.prompt_transformer import PromptTransformResult
from tests.app_test_bootstrap import load_app_main


class _FakePipe:
    #_____________апдейт_______ Captures generate() kwargs to validate prompt contract
    def __init__(self):
        self.last_kwargs = None

    def __call__(self, **kwargs):
        self.last_kwargs = kwargs
        return types.SimpleNamespace(images=[Image.new("RGB", (64, 64), "white")])


class GeneratePromptTransformContractTests(unittest.TestCase):
    def setUp(self):
        self.main = load_app_main()
        self.client = TestClient(self.main.app)
        self.original_strict = self.main.settings.PROMPT_TRANSFORM_STRICT

    def tearDown(self):
        self.main.settings.PROMPT_TRANSFORM_STRICT = self.original_strict

    def _base_form(self) -> dict[str, str]:
        return {
            "prompt": "city skyline",
            "negative_prompt": "low quality",
            "width": "512",
            "height": "512",
            "steps": "20",
            "cfg": "7.5",
            "seed": "123",
            "mode": "auto",
            "model_id": "runwayml/stable-diffusion-v1-5",
            "sampler": "Euler a",
        }

    def test_generate_strict_mode_blocks_when_transform_failed(self):
        #_____________апдейт_______ Contract: strict+requested transform returns 422 on fallback_error
        self.main.settings.PROMPT_TRANSFORM_STRICT = True
        transform_result = PromptTransformResult(
            raw_prompt="city skyline",
            transformed_prompt="",
            transformed_negative_prompt="low quality",
            transform_status="fallback_error",
            provider="stub",
            latency_ms=1,
            error="adapter failed",
        )
        fake_pipe = _FakePipe()

        with patch.object(
            self.main.prompt_transformer,
            "transform_prompt",
            new=AsyncMock(return_value=transform_result),
        ), patch.object(
            self.main.model_manager,
            "get_model",
            new=AsyncMock(return_value=fake_pipe),
        ):
            response = self.client.post(
                "/generate",
                data={**self._base_form(), "use_prompt_transform": "true"},
            )

        self.assertEqual(response.status_code, 422)
        self.assertIn("Prompt was not transformed", response.json()["detail"])
        self.assertIsNone(fake_pipe.last_kwargs)

    def test_generate_non_strict_fallback_runs_with_raw_prompt(self):
        #_____________апдейт_______ Contract: non-strict fallback keeps generation with raw prompt
        self.main.settings.PROMPT_TRANSFORM_STRICT = False
        transform_result = PromptTransformResult(
            raw_prompt="city skyline",
            transformed_prompt="",
            transformed_negative_prompt="low quality",
            transform_status="fallback_error",
            provider="stub",
            latency_ms=2,
            error="timeout",
        )
        fake_pipe = _FakePipe()

        with patch.object(
            self.main.prompt_transformer,
            "transform_prompt",
            new=AsyncMock(return_value=transform_result),
        ), patch.object(
            self.main.model_manager,
            "get_model",
            new=AsyncMock(return_value=fake_pipe),
        ), patch.object(
            self.main,
            "save_image_with_metadata",
            return_value="fake.png",
        ):
            response = self.client.post(
                "/generate",
                data={**self._base_form(), "use_prompt_transform": "true"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "success")
        self.assertEqual(fake_pipe.last_kwargs["prompt"], "city skyline")
        self.assertEqual(fake_pipe.last_kwargs["negative_prompt"], "low quality")
        self.assertEqual(response.json()["meta"]["prompt_transform_status"], "fallback_error")

    def test_generate_uses_transformed_prompt_and_negative(self):
        #_____________апдейт_______ Contract: SD call must receive transformed prompt fields on success
        self.main.settings.PROMPT_TRANSFORM_STRICT = True
        transform_result = PromptTransformResult(
            raw_prompt="city skyline",
            transformed_prompt="masterpiece city skyline, cinematic",
            transformed_negative_prompt="blurry, noisy",
            transform_status="success",
            provider="stub",
            latency_ms=3,
        )
        fake_pipe = _FakePipe()

        with patch.object(
            self.main.prompt_transformer,
            "transform_prompt",
            new=AsyncMock(return_value=transform_result),
        ), patch.object(
            self.main.model_manager,
            "get_model",
            new=AsyncMock(return_value=fake_pipe),
        ), patch.object(
            self.main,
            "save_image_with_metadata",
            return_value="fake.png",
        ):
            response = self.client.post(
                "/generate",
                data={**self._base_form(), "use_prompt_transform": "true"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fake_pipe.last_kwargs["prompt"], "masterpiece city skyline, cinematic")
        self.assertEqual(fake_pipe.last_kwargs["negative_prompt"], "blurry, noisy")
        meta = response.json()["meta"]
        self.assertEqual(meta["raw_prompt"], "city skyline")
        self.assertEqual(meta["transformed_prompt"], "masterpiece city skyline, cinematic")
        self.assertEqual(meta["transformed_negative_prompt"], "blurry, noisy")
        self.assertEqual(meta["prompt_transform_provider"], "stub")
        self.assertEqual(meta["prompt_transform_latency_ms"], 3)


if __name__ == "__main__":
    unittest.main()
