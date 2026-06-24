import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import core.model_downloads as md
from core.model_downloads import ModelDownloadError, ModelDownloadManager
from main import app


class _FakeResponse:
    """Имитация ответа urlopen: читается кусками, опционально с задержкой."""

    def __init__(self, data: bytes, *, total=None, chunk_cap=4096, delay=0.0):
        self._buf = data
        self._pos = 0
        self._cap = chunk_cap
        self._delay = delay
        self.headers = {"Content-Length": str(total if total is not None else len(data))}

    def read(self, _n=-1):
        if self._delay:
            time.sleep(self._delay)
        if self._pos >= len(self._buf):
            return b""
        chunk = self._buf[self._pos:self._pos + self._cap]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _wait_status(manager, job_id, statuses, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = manager.get(job_id)
        if job and job["status"] in statuses:
            return job
        time.sleep(0.03)
    return manager.get(job_id)


class ModelDownloadManagerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.models_dir = Path(self._tmp.name)
        self.manager = ModelDownloadManager(self.models_dir)

    def tearDown(self):
        self._tmp.cleanup()

    def test_resolve_target_strips_path_components(self):
        target = self.manager.resolve_target("../../evil.safetensors")
        self.assertEqual(target.parent, self.models_dir.resolve())
        self.assertEqual(target.name, "evil.safetensors")

    def test_resolve_target_rejects_bad_suffix(self):
        with self.assertRaises(ModelDownloadError):
            self.manager.resolve_target("notamodel.txt")

    def test_download_completes_and_writes_file(self):
        payload = b"x" * 9000
        with patch.object(md, "urlopen", return_value=_FakeResponse(payload)):
            job = self.manager.start(
                url="https://example.com/model.safetensors",
                filename="model.safetensors",
                model_id="Cool Model",
            )
            done = _wait_status(self.manager, job["job_id"], {"completed", "error"})
        self.assertEqual(done["status"], "completed")
        target = self.models_dir / "model.safetensors"
        self.assertTrue(target.is_file())
        self.assertEqual(target.stat().st_size, len(payload))

    def test_cancel_stops_download_and_removes_partial(self):
        payload = b"y" * (200 * 1024)
        with patch.object(md, "urlopen", return_value=_FakeResponse(payload, chunk_cap=1024, delay=0.02)):
            job = self.manager.start(
                url="https://example.com/big.safetensors",
                filename="big.safetensors",
                model_id="Big",
            )
            _wait_status(self.manager, job["job_id"], {"downloading"})
            self.assertTrue(self.manager.cancel(job["job_id"]))
            done = _wait_status(self.manager, job["job_id"], {"canceled", "completed"})
        self.assertEqual(done["status"], "canceled")
        self.assertFalse((self.models_dir / "big.safetensors").exists())
        self.assertFalse((self.models_dir / "big.safetensors.part").exists())

    def test_duplicate_active_download_rejected(self):
        payload = b"z" * (50 * 1024)
        with patch.object(md, "urlopen", return_value=_FakeResponse(payload, chunk_cap=1024, delay=0.02)):
            self.manager.start(url="https://e/x.safetensors", filename="dup.safetensors", model_id="d")
            with self.assertRaises(ModelDownloadError):
                self.manager.start(url="https://e/x.safetensors", filename="dup.safetensors", model_id="d")

    def test_existing_file_rejected(self):
        (self.models_dir / "have.safetensors").write_bytes(b"already")
        with self.assertRaises(ModelDownloadError):
            self.manager.start(url="https://e/x.safetensors", filename="have.safetensors", model_id="h")


CIVITAI_JSON = {
    "items": [
        {
            "id": 123,
            "name": "CoolXL",
            "nsfw": False,
            "modelVersions": [
                {
                    "id": 9,
                    "baseModel": "SDXL 1.0",
                    "images": [{"url": "http://img/x.jpg"}],
                    "files": [
                        {"name": "coolxl.safetensors", "primary": True, "downloadUrl": "http://dl/cool", "sizeKB": 2048},
                    ],
                }
            ],
        }
    ]
}

HF_SEARCH_JSON = [
    {"id": "org/sdxl-model", "tags": ["diffusers", "stable-diffusion-xl"], "downloads": 100, "likes": 5},
]

HF_FILES_JSON = {
    "siblings": [
        {"rfilename": "model.safetensors", "size": 1048576},
        {"rfilename": "nested/other.safetensors", "size": 10},
        {"rfilename": "README.md", "size": 1},
    ]
}


class ModelEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_download_rejects_invalid_filename(self):
        response = self.client.post(
            "/models/download",
            json={"download_url": "https://example.com/x", "filename": "bad.txt"},
        )
        self.assertEqual(response.status_code, 422)

    def test_download_rejects_non_http_url(self):
        response = self.client.post(
            "/models/download",
            json={"download_url": "ftp://example.com/x", "filename": "m.safetensors"},
        )
        self.assertEqual(response.status_code, 422)

    def test_download_status_unknown_job_404(self):
        self.assertEqual(self.client.get("/models/download/nope").status_code, 404)

    def test_cancel_unknown_job_404(self):
        self.assertEqual(self.client.post("/models/download/nope/cancel").status_code, 404)

    def test_delete_requires_identifier(self):
        self.assertEqual(self.client.post("/models/delete", json={}).status_code, 422)

    def test_delete_missing_file_404(self):
        response = self.client.post("/models/delete", json={"filename": "ghost.safetensors"})
        self.assertEqual(response.status_code, 404)

    def test_search_civitai_normalizes_results(self):
        with patch.object(md, "_http_get_json", return_value=CIVITAI_JSON):
            response = self.client.get("/models/search/civitai", params={"query": "xl"})
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertEqual(len(results), 1)
        item = results[0]
        self.assertEqual(item["family"], "sdxl")
        self.assertEqual(item["filename"], "coolxl.safetensors")
        self.assertEqual(item["download_url"], "http://dl/cool")
        self.assertEqual(item["size_bytes"], 2048 * 1024)
        self.assertEqual(item["auth"], "civitai")

    def test_search_huggingface_normalizes_results(self):
        with patch.object(md, "_http_get_json", return_value=HF_SEARCH_JSON):
            response = self.client.get("/models/search/huggingface", params={"query": "sdxl"})
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertEqual(results[0]["id"], "org/sdxl-model")
        self.assertEqual(results[0]["family"], "sdxl")

    def test_huggingface_files_only_top_level_checkpoints(self):
        with patch.object(md, "_http_get_json", return_value=HF_FILES_JSON):
            response = self.client.get("/models/huggingface/files", params={"repo": "org/sdxl-model"})
        self.assertEqual(response.status_code, 200)
        files = response.json()["files"]
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["filename"], "model.safetensors")
        self.assertIn("resolve/main/model.safetensors", files[0]["download_url"])
        self.assertEqual(files[0]["auth"], "huggingface")


if __name__ == "__main__":
    unittest.main()
