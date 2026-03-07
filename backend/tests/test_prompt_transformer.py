import asyncio
import time
import unittest

from core.prompt_transformer import BasePromptLLMAdapter, PromptTransformer


class PrefixAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> str:
        return f"sd::{prompt}"


class ErrorAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> str:
        raise RuntimeError("adapter failed")


class SlowAdapter(BasePromptLLMAdapter):
    def transform_to_sd(self, prompt: str, context=None) -> str:
        time.sleep(0.2)
        return f"slow::{prompt}"


class PromptTransformerTests(unittest.TestCase):
    def test_disabled_transformer_returns_raw_prompt(self):
        transformer = PromptTransformer(
            enabled=False,
            timeout_ms=1000,
            provider_name="stub",
            adapter=PrefixAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_prompt, "hello world")

    def test_success_transform(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=PrefixAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "success")
        self.assertEqual(result.transformed_prompt, "sd::hello world")

    def test_request_level_opt_out(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=PrefixAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=False))

        self.assertEqual(result.transform_status, "disabled")
        self.assertEqual(result.transformed_prompt, "hello world")

    def test_adapter_error_returns_no_transformed_prompt(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=1000,
            provider_name="stub",
            adapter=ErrorAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_prompt, "")

    def test_timeout_returns_no_transformed_prompt(self):
        transformer = PromptTransformer(
            enabled=True,
            timeout_ms=30,
            provider_name="stub",
            adapter=SlowAdapter(),
        )
        result = asyncio.run(transformer.transform_prompt("hello world", use_prompt_transform=True))

        self.assertEqual(result.transform_status, "fallback_error")
        self.assertEqual(result.transformed_prompt, "")


if __name__ == "__main__":
    unittest.main()
