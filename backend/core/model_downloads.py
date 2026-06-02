"""Скачивание чекпоинтов моделей с HuggingFace / Civit.ai + поиск по каталогам.

Движок работает поверх stdlib (urllib) — никаких новых зависимостей. Загрузки
идут в фоновых потоках, прогресс/отмена доступны через ModelDownloadManager,
который опрашивает фронтенд (паттерн как у GenerationPreviewStore).
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request as UrlRequest, urlopen

from core.config import settings

logger = logging.getLogger(__name__)

LOCAL_MODEL_SUFFIXES = {".safetensors", ".ckpt"}
_CHUNK_SIZE = 1024 * 1024
_DOWNLOAD_TIMEOUT_S = 900
_SEARCH_TIMEOUT_S = 20


class ModelDownloadError(Exception):
    """Ошибка валидации/постановки загрузки (отдаётся как 4xx)."""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _user_agent() -> str:
    return settings.PROJECT_NAME or "model-downloader"


def _append_query_param(url: str, key: str, value: str) -> str:
    parsed = urlparse(url)
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    params[key] = value
    return urlunparse(parsed._replace(query=urlencode(params)))


def sanitize_filename(filename: str) -> str:
    """Берём только basename и валидируем расширение (защита от path-traversal)."""
    name = Path(str(filename or "")).name.strip()
    if not name:
        raise ModelDownloadError("Filename is required.")
    if Path(name).suffix.lower() not in LOCAL_MODEL_SUFFIXES:
        raise ModelDownloadError("Only .safetensors and .ckpt files are supported.")
    return name


def _family_from_base_model(base_model: Optional[str]) -> str:
    text = str(base_model or "").lower()
    if "xl" in text or "sdxl" in text:
        return "sdxl"
    return "sd"


def _http_get_json(url: str, *, headers: Optional[dict] = None, timeout: int = _SEARCH_TIMEOUT_S) -> dict:
    request_headers = {"User-Agent": _user_agent(), "Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    request = UrlRequest(url, headers=request_headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:  # noqa: PERF203
        raise ModelDownloadError(f"Upstream returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ModelDownloadError(f"Upstream request failed: {exc}.") from exc


# --------------------------------------------------------------------------- #
# download jobs
# --------------------------------------------------------------------------- #
@dataclass
class DownloadJob:
    job_id: str
    model_id: str
    filename: str
    url: str
    status: str = "pending"  # pending | downloading | completed | error | canceled
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    error: Optional[str] = None
    started_at: float = 0.0
    updated_at: float = 0.0
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict[str, object]:
        progress = 0.0
        if self.total_bytes > 0:
            progress = min(1.0, self.downloaded_bytes / self.total_bytes)
        return {
            "job_id": self.job_id,
            "model_id": self.model_id,
            "filename": self.filename,
            "status": self.status,
            "downloaded_bytes": self.downloaded_bytes,
            "total_bytes": self.total_bytes,
            "progress": progress,
            "speed_bps": self.speed_bps,
            "error": self.error,
            "updated_at": self.updated_at,
        }


class ModelDownloadManager:
    def __init__(self, models_dir: Path, ttl_seconds: int = 3600):
        self.models_dir = Path(models_dir)
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._jobs: dict[str, DownloadJob] = {}

    # -- path safety -------------------------------------------------------- #
    def resolve_target(self, filename: str) -> Path:
        name = sanitize_filename(filename)
        models_root = self.models_dir.resolve()
        target = (models_root / name).resolve()
        if target.parent != models_root:
            raise ModelDownloadError("Filename must not contain path separators.")
        return target

    # -- lifecycle ---------------------------------------------------------- #
    def _prune_locked(self) -> None:
        cutoff = time.time() - self.ttl_seconds
        stale = [
            job_id
            for job_id, job in self._jobs.items()
            if job.status in {"completed", "error", "canceled"}
            and job.updated_at
            and job.updated_at < cutoff
        ]
        for job_id in stale:
            self._jobs.pop(job_id, None)

    def start(
        self,
        *,
        url: str,
        filename: str,
        model_id: str,
        auth: str = "none",
    ) -> dict[str, object]:
        if not url or not str(url).lower().startswith(("http://", "https://")):
            raise ModelDownloadError("A valid http(s) download URL is required.")

        target = self.resolve_target(filename)
        if target.exists() and target.is_file() and target.stat().st_size > 0:
            raise ModelDownloadError("Model file already exists locally.")

        request_url, headers = self._apply_auth(url, auth)

        job = DownloadJob(
            job_id=uuid.uuid4().hex,
            model_id=str(model_id or target.name),
            filename=target.name,
            url=url,
            status="pending",
            started_at=time.time(),
            updated_at=time.time(),
        )
        with self._lock:
            self._prune_locked()
            # Не запускаем повторную загрузку того же файла.
            for existing in self._jobs.values():
                if existing.filename == job.filename and existing.status in {"pending", "downloading"}:
                    raise ModelDownloadError("This model is already downloading.")
            self._jobs[job.job_id] = job

        thread = threading.Thread(
            target=self._run,
            args=(job, request_url, headers, target),
            name=f"model-download-{job.job_id[:8]}",
            daemon=True,
        )
        thread.start()
        return job.public()

    def _apply_auth(self, url: str, auth: str) -> tuple[str, dict]:
        headers: dict[str, str] = {"User-Agent": _user_agent()}
        normalized = str(auth or "none").lower()
        if normalized == "civitai" and settings.CIVITAI_API_TOKEN:
            url = _append_query_param(url, "token", settings.CIVITAI_API_TOKEN)
        elif normalized == "huggingface" and settings.HF_TOKEN:
            headers["Authorization"] = f"Bearer {settings.HF_TOKEN}"
        return url, headers

    def _run(self, job: DownloadJob, url: str, headers: dict, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp_path = target.with_suffix(f"{target.suffix}.part")
        if temp_path.exists():
            temp_path.unlink()

        self._set(job, status="downloading")
        logger.info("Model download started: id=%s file=%s", job.model_id, job.filename)
        started = time.monotonic()

        try:
            request = UrlRequest(url, headers=headers)
            with urlopen(request, timeout=_DOWNLOAD_TIMEOUT_S) as response, temp_path.open("wb") as out:
                total = int(response.headers.get("Content-Length", "0") or "0")
                self._set(job, total_bytes=total)
                downloaded = 0
                while True:
                    if job.cancel_event.is_set():
                        raise _DownloadCanceled()
                    chunk = response.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    elapsed = max(time.monotonic() - started, 0.001)
                    self._set(
                        job,
                        downloaded_bytes=downloaded,
                        speed_bps=downloaded / elapsed,
                    )
            temp_path.replace(target)
            self._set(job, status="completed")
            logger.info(
                "Model download completed: id=%s file=%s size_mb=%.2f",
                job.model_id,
                job.filename,
                target.stat().st_size / (1024 * 1024),
            )
        except _DownloadCanceled:
            if temp_path.exists():
                temp_path.unlink()
            self._set(job, status="canceled")
            logger.info("Model download canceled: id=%s file=%s", job.model_id, job.filename)
        except Exception as exc:  # noqa: BLE001
            if temp_path.exists():
                temp_path.unlink()
            self._set(job, status="error", error=str(exc))
            logger.error("Model download failed: id=%s file=%s err=%s", job.model_id, job.filename, exc)

    def _set(self, job: DownloadJob, **changes) -> None:
        with self._lock:
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = time.time()

    # -- queries ------------------------------------------------------------ #
    def get(self, job_id: str) -> Optional[dict[str, object]]:
        with self._lock:
            self._prune_locked()
            job = self._jobs.get(job_id)
            return job.public() if job else None

    def list_jobs(self) -> list[dict[str, object]]:
        with self._lock:
            self._prune_locked()
            return [job.public() for job in self._jobs.values()]

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job.status in {"pending", "downloading"}:
                job.cancel_event.set()
                return True
            return False


class _DownloadCanceled(Exception):
    pass


# --------------------------------------------------------------------------- #
# catalog search (proxy)
# --------------------------------------------------------------------------- #
def _first_image_url(images: Optional[list]) -> Optional[str]:
    for image in images or []:
        url = image.get("url") if isinstance(image, dict) else None
        if url:
            return url
    return None


def search_civitai(query: str, *, limit: int = 24, nsfw: bool = False) -> list[dict[str, object]]:
    params = {
        "limit": max(1, min(int(limit), 60)),
        "types": "Checkpoint",
        "sort": "Highest Rated",
    }
    if query:
        params["query"] = query
    if not nsfw:
        params["nsfw"] = "false"

    headers = {}
    if settings.CIVITAI_API_TOKEN:
        headers["Authorization"] = f"Bearer {settings.CIVITAI_API_TOKEN}"

    data = _http_get_json("https://civitai.com/api/v1/models?" + urlencode(params), headers=headers)

    results: list[dict[str, object]] = []
    for item in data.get("items", []):
        versions = item.get("modelVersions") or []
        version = versions[0] if versions else {}
        files = version.get("files") or []
        primary = next((f for f in files if f.get("primary")), files[0] if files else {})
        download_url = primary.get("downloadUrl")
        filename = primary.get("name")
        if not download_url or not filename:
            continue
        size_kb = primary.get("sizeKB") or 0
        results.append(
            {
                "source": "civitai",
                "id": str(item.get("id")),
                "name": item.get("name"),
                "base_model": version.get("baseModel"),
                "family": _family_from_base_model(version.get("baseModel")),
                "nsfw": bool(item.get("nsfw")),
                "thumbnail": _first_image_url(version.get("images")),
                "download_url": download_url,
                "filename": Path(str(filename)).name,
                "size_bytes": int(size_kb * 1024) if size_kb else 0,
                "auth": "civitai",
            }
        )
    return results


def search_huggingface(query: str, *, limit: int = 24) -> list[dict[str, object]]:
    params = {
        "search": query or "",
        "limit": max(1, min(int(limit), 60)),
        "filter": "diffusers",
        "sort": "downloads",
        "direction": -1,
    }
    headers = {}
    if settings.HF_TOKEN:
        headers["Authorization"] = f"Bearer {settings.HF_TOKEN}"

    data = _http_get_json("https://huggingface.co/api/models?" + urlencode(params), headers=headers)
    # HF возвращает список (а не объект) — _http_get_json вернёт его как есть только
    # если это объект; нормализуем оба случая.
    items = data if isinstance(data, list) else data.get("models", [])

    results: list[dict[str, object]] = []
    for item in items:
        repo = item.get("id") or item.get("modelId")
        if not repo:
            continue
        tags = item.get("tags") or []
        family = "sdxl" if any("xl" in str(t).lower() for t in tags) or "xl" in str(repo).lower() else "sd"
        results.append(
            {
                "source": "huggingface",
                "id": repo,
                "name": repo,
                "family": family,
                "downloads": item.get("downloads", 0),
                "likes": item.get("likes", 0),
            }
        )
    return results


def list_huggingface_files(repo: str) -> list[dict[str, object]]:
    if not repo:
        raise ModelDownloadError("repo is required.")
    headers = {}
    if settings.HF_TOKEN:
        headers["Authorization"] = f"Bearer {settings.HF_TOKEN}"

    data = _http_get_json(f"https://huggingface.co/api/models/{repo}?blobs=true", headers=headers)
    files: list[dict[str, object]] = []
    for sibling in data.get("siblings", []):
        rfilename = sibling.get("rfilename", "")
        if "/" in rfilename:
            continue  # только single-file чекпоинты в корне репозитория
        if Path(rfilename).suffix.lower() not in LOCAL_MODEL_SUFFIXES:
            continue
        files.append(
            {
                "filename": Path(rfilename).name,
                "download_url": f"https://huggingface.co/{repo}/resolve/main/{rfilename}?download=true",
                "size_bytes": int(sibling.get("size") or 0),
                "auth": "huggingface",
            }
        )
    return files
