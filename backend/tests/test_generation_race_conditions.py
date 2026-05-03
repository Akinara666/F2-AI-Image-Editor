import threading
import time
import types
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

from core.prompt_transformer import PromptTransformResult
from tests.app_test_bootstrap import load_app_main


class SlowPipe:
    def __init__(self, started_event):
        self.started_event = started_event
        self._interrupt = False

    def __call__(self, **kwargs):
        callback = kwargs.get("callback_on_step_end")
        self.started_event.set()
        for step in range(50):
            if callback:
                callback(self, step, 0, {})
            if self._interrupt:
                break
            time.sleep(0.01)
        return types.SimpleNamespace(images=[Image.new("RGB", (64, 64), "white")])


class GenerationRaceConditionsTests(unittest.TestCase):
    def setUp(self):
        self.main = load_app_main()
        self.main.generation_state["cancel_requested"] = False
        self.original_strict = self.main.settings.PROMPT_TRANSFORM_STRICT
        self.main.settings.PROMPT_TRANSFORM_STRICT = True
        self.transform_ok = PromptTransformResult(
            raw_prompt="test",
            transformed_prompt="test",
            transformed_negative_prompt="low quality",
            transform_status="success",
            provider="stub",
            latency_ms=0,
        )

    def tearDown(self):
        self.main.settings.PROMPT_TRANSFORM_STRICT = self.original_strict
        self.main.generation_state["cancel_requested"] = False

    def _form(self, prompt):
        return {
            "prompt": prompt,
            "negative_prompt": "low quality",
            "width": "64",
            "height": "64",
            "steps": "20",
            "cfg": "7.5",
            "seed": "42",
            "mode": "auto",
            "model_id": "runwayml/stable-diffusion-v1-5",
            "sampler": "Euler a",
            "use_prompt_transform": "true",
        }

    def test_cancel_during_generation_returns_499(self):
        started = threading.Event()
        pipe = SlowPipe(started)
        result_holder = {}

        with patch.object(
            self.main.prompt_transformer,
            "transform_prompt",
            new=AsyncMock(return_value=self.transform_ok),
        ), patch.object(
            self.main.model_manager,
            "get_model",
            new=AsyncMock(return_value=pipe),
        ), patch.object(
            self.main,
            "save_image_with_metadata",
            return_value="fake.png",
        ):
            def run_generate():
                with TestClient(self.main.app) as thread_client:
                    result_holder["response"] = thread_client.post(
                        "/generate",
                        data=self._form("cancel me"),
                    )

            generate_thread = threading.Thread(target=run_generate)
            generate_thread.start()
            started.wait(timeout=2)
            with TestClient(self.main.app) as control_client:
                cancel_response = control_client.post("/cancel")
            generate_thread.join(timeout=5)

        response = result_holder["response"]
        self.assertEqual(cancel_response.status_code, 200)
        self.assertEqual(cancel_response.json()["status"], "cancelled")
        self.assertEqual(response.status_code, 499)
        self.assertIn("cancelled", response.json()["detail"].lower())

    def test_parallel_generate_requests_complete_without_cancel(self):
        responses = []
        lock = threading.Lock()

        async def get_pipe(*args, **kwargs):
            return SlowPipe(threading.Event())

        with patch.object(
            self.main.prompt_transformer,
            "transform_prompt",
            new=AsyncMock(return_value=self.transform_ok),
        ), patch.object(
            self.main.model_manager,
            "get_model",
            new=AsyncMock(side_effect=get_pipe),
        ), patch.object(
            self.main,
            "save_image_with_metadata",
            return_value="fake.png",
        ):
            def run_request(prompt):
                with TestClient(self.main.app) as thread_client:
                    resp = thread_client.post("/generate", data=self._form(prompt))
                with lock:
                    responses.append(resp)

            t1 = threading.Thread(target=run_request, args=("p1",))
            t2 = threading.Thread(target=run_request, args=("p2",))
            t1.start()
            t2.start()
            t1.join(timeout=10)
            t2.join(timeout=10)

        self.assertEqual(len(responses), 2)
        self.assertEqual(sorted([r.status_code for r in responses]), [200, 200])


if __name__ == "__main__":
    unittest.main()
