from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import os
import random
from typing import Optional
from pathlib import Path
import math
import json
import uvicorn
import io
import asyncio
import traceback
import uuid
import shutil
import threading
from time import monotonic
from urllib.request import Request as UrlRequest, urlopen
from urllib.parse import parse_qsl, urlencode, urlparse, unquote, urlunparse
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

try:
    import torch
except ModuleNotFoundError:
    torch = None

from pydantic import BaseModel
try:
    # ImportError (not just ModuleNotFoundError): older compel releases lack
    # these wrappers, and a failed name import must not crash the whole app.
    from compel import CompelForSD, CompelForSDXL
except ImportError:
    CompelForSD = None
    CompelForSDXL = None

# Import core modules
from core.utils import (
    save_image_with_metadata,
    process_mask_for_inpainting,
    prepare_image_for_outpainting,
    feather_blend,
    merge_generation_masks,
)
from core.config import STYLE_PRESETS, settings
from core.config_schema import SETTINGS_SCHEMA, ALLOWLIST, coerce_value, is_secret
from core.prompt_transformer import prompt_transformer
from core.safety_checker import nsfw_safety_checker
from core.negative_prompt_transformer import negative_prompt_transformer
from core.generation_preview import generation_preview_store
from core.model_downloads import (
    ModelDownloadError,
    ModelDownloadManager,
    list_huggingface_files,
    search_civitai,
    search_huggingface,
)


class _FallbackPreviewDecoder:
    def normalize_method(self, method: Optional[str]) -> str:
        normalized = str(method or settings.LIVE_PREVIEW_METHOD or "full").strip().lower()
        if normalized in LIVE_PREVIEW_METHOD_CHOICES:
            return normalized
        return "full"

    def prepare(self, pipe, model_family: str, method: Optional[str]) -> str:
        return self.normalize_method(method)

    def decode(self, pipe, latents, model_family: str, method: Optional[str]):
        return None


class _FallbackModelManager:
    def __init__(self, import_error: Exception):
        self.device = "cpu"
        self._import_error = import_error

    @staticmethod
    def infer_model_family(model_id: str) -> str:
        lowered = str(model_id or "").lower()
        sdxl_hints = ("stable-diffusion-xl", "sdxl", "juggernautxl", "realvisxl", "pony", "xl")
        return "sdxl" if any(hint in lowered for hint in sdxl_hints) else "sd"

    @staticmethod
    def request_cancel(request_id: str) -> None:
        return None

    @staticmethod
    def is_cancel_requested(request_id: str) -> bool:
        return False

    @staticmethod
    def bind_active_pipeline(request_id: str, pipe) -> None:
        return None

    @asynccontextmanager
    async def generation_session(self, request_id: str):
        yield

    async def get_model(self, *args, **kwargs):
        raise RuntimeError(
            "AI runtime dependencies are unavailable. "
            "Install torch/diffusers/compel and related backend runtime packages."
        ) from self._import_error


AI_RUNTIME_IMPORT_ERROR: Exception | None = None

try:
    from core.manager import model_manager, GenerationBusyError
except Exception as exc:
    AI_RUNTIME_IMPORT_ERROR = exc
    logger.warning("Falling back to lightweight model manager because AI runtime import failed: %s", exc)
    model_manager = _FallbackModelManager(exc)

    class GenerationBusyError(RuntimeError):
        """Placeholder so the 429 handler can register; never raised in fallback
        mode (the fallback manager has no generation lock to overflow)."""

LIVE_PREVIEW_METHOD_CHOICES = ("full", "approx_nn", "approx_cheap", "taesd")
try:
    from core.preview_decoder import LIVE_PREVIEW_METHOD_CHOICES, preview_decoder
except Exception as exc:
    if AI_RUNTIME_IMPORT_ERROR is None:
        AI_RUNTIME_IMPORT_ERROR = exc
    logger.warning("Falling back to lightweight preview decoder because preview runtime import failed: %s", exc)
    preview_decoder = _FallbackPreviewDecoder()

app = FastAPI(title="Local AI Gen Service", version="0.1.0")

allow_all_origins = "*" in settings.CORS_ALLOW_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all_origins else settings.CORS_ALLOW_ORIGINS,
    allow_origin_regex=None if allow_all_origins else settings.CORS_ALLOW_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static folder for outputs
app.mount("/outputs", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="outputs")

@app.exception_handler(GenerationBusyError)
async def generation_busy_handler(request: Request, exc: GenerationBusyError):
    # Backpressure, not an error: the generation wait queue is full. Tell the
    # client to retry. Starlette matches this before the generic Exception handler.
    logger.info("Generation rejected (busy): %s", exc)
    return JSONResponse(status_code=429, content={"detail": str(exc)})

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global Error: {exc}", exc_info=True)
    # Full details stay in the server log; raw exception text can leak
    # filesystem paths and environment internals to the client.
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "type": type(exc).__name__}
    )

# --- Presets & configuration ---
# Imports from core.config

ALLOWED_CLOUD_MODELS = [
    {"id": "runwayml/stable-diffusion-v1-5", "label": "SD v1.5 Base (Cloud)", "family": "sd"},
    {"id": "stabilityai/stable-diffusion-xl-base-1.0", "label": "SDXL Base 1.0 (Cloud)", "family": "sdxl"},
]
MANAGED_DOWNLOADABLE_MODELS = [
    {
        "id": "managed:cyberrealistic-pony-v16",
        "label": "CyberRealistic Pony v16 (Auto-download on Generate)",
        "family": "sdxl",
        "source": "managed_download",
        "requires_auth": True,
        "filename": "CyberRealistic_Pony_v16_fp32.safetensors",
        "download_url": "https://civitai.com/api/download/models/2581228?type=Model&format=SafeTensor&size=full&fp=fp32",
    },
]
MANAGED_MODEL_DOWNLOAD_LOCKS: dict[str, threading.Lock] = {}
# Менеджер пользовательских загрузок моделей (через меню в редакторе).
model_download_manager = ModelDownloadManager(settings.MODELS_DIR)
ALLOWED_SAMPLERS = {
    "Euler a",
    "Euler",
    "DPM++ 2M Karras",
    "DPM++ 2M SDE Karras",
    "DPM++ SDE Karras",
    "DPM2 a Karras",
    "DDIM",
    "DDPM",
    "Heun",
    "UniPC",
    "LMS",
}
# diffusers has no true single-step ancestral DPM++ 2S a; the old entry was
# silently backed by the 2M SDE multistep scheduler. Keep the name as an alias
# for stored client settings / external API callers.
SAMPLER_ALIASES = {
    "DPM++ 2S a Karras": "DPM++ 2M SDE Karras",
}
ALLOWED_GENERATION_MODES = {"auto", "text2img", "img2img", "inpainting"}
LOCAL_MODEL_SUFFIXES = {".safetensors", ".ckpt"}
ALLOWED_MODEL_FAMILIES = {"sd", "sdxl"}
MIN_DIMENSION = 64
MAX_DIMENSION = 2048
# 2 MP: covers native SDXL aspect presets (1024x1024, 896x1152, 1216x832)
# and portrait/landscape HD like 1024x1536 with VRAM still bounded by
# VAE tiling + attention slicing. The old 1 MP cap rejected anything
# larger than the SDXL base square.
MAX_GENERATION_PIXELS = 2 * 1024 * 1024
DIMENSION_MULTIPLE = 8
MIN_STEPS = 1
MAX_STEPS = 150
MIN_CFG = 1.0
MAX_CFG = 20.0
MIN_DENOISING_STRENGTH = 0.0
MAX_DENOISING_STRENGTH = 1.0
MIN_SEED = -1
MAX_SEED = (2**32) - 1
MIN_MASK_BLUR = 0
MAX_MASK_BLUR = 128
MIN_MASK_PADDING = 0
MAX_MASK_PADDING = 128
#_____________апдейт_______ Supported editor tools metadata
ALLOWED_EDITOR_TOOLS = {"none", "sketch", "mask", "hand", "eraser", "clone_stamp", "spot_heal", "quick_select"}


def _validation_error(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _ensure_ai_runtime_available() -> None:
    if AI_RUNTIME_IMPORT_ERROR is None and torch is not None:
        return

    missing_bits = []
    if torch is None:
        missing_bits.append("torch")
    if AI_RUNTIME_IMPORT_ERROR is not None:
        missing_bits.append(type(AI_RUNTIME_IMPORT_ERROR).__name__)

    detail = (
        "AI runtime is unavailable for generation endpoints. "
        f"Missing or failed dependencies: {', '.join(missing_bits)}."
    )
    raise HTTPException(status_code=503, detail=detail)


def _merge_negative_prompt_terms(base_prompt: Optional[str], extra_prompt: Optional[str]) -> str:
    merged_terms: list[str] = []
    seen_terms: set[str] = set()

    for source_prompt in (base_prompt, extra_prompt):
        if not source_prompt:
            continue

        for raw_term in source_prompt.split(","):
            term = raw_term.strip()
            if not term:
                continue

            normalized_term = term.casefold()
            if normalized_term in seen_terms:
                continue

            seen_terms.add(normalized_term)
            merged_terms.append(term)

    return ", ".join(merged_terms)


def _resolve_preview_method(preview_method: Optional[str]) -> str:
    raw_value = str(preview_method or "").strip().lower()
    if not raw_value or raw_value == "server_default":
        return preview_decoder.normalize_method(settings.LIVE_PREVIEW_METHOD)
    if raw_value not in LIVE_PREVIEW_METHOD_CHOICES:
        raise _validation_error(
            f"preview_method must be one of: server_default, {', '.join(LIVE_PREVIEW_METHOD_CHOICES)}."
        )
    return raw_value


#_____________апдейт_______ Normalize optional active tool from frontend
def _normalize_active_tool(active_tool: Optional[str]) -> str:
    value = str(active_tool or "").strip().lower()
    if not value:
        return "none"
    if value in ALLOWED_EDITOR_TOOLS:
        return value
    return "none"


#_____________апдейт_______ Build rectangular selection mask for quick-select refine
def _build_quick_select_mask(
    *,
    width: int,
    height: int,
    selection_left: int,
    selection_top: int,
    selection_width: int,
    selection_height: int,
    feather: int = 0,
) -> Image.Image:
    left = max(0, min(width - 1, int(selection_left)))
    top = max(0, min(height - 1, int(selection_top)))
    right = max(left + 1, min(width, left + max(1, int(selection_width))))
    bottom = max(top + 1, min(height, top + max(1, int(selection_height))))

    if right <= left or bottom <= top:
        raise _validation_error("Selection bounds are invalid for quick-select refine.")

    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle([left, top, right, bottom], fill=255)
    if feather > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(radius=feather))
    return mask


def _resolve_clip_skip_for_diffusers() -> tuple[int, Optional[int]]:
    configured_clip_skip = max(1, int(settings.CLIP_SKIP))
    # Use A1111/WebUI semantics in .env:
    # 1 = default behavior, 2 = one layer earlier, etc.
    diffusers_clip_skip = None if configured_clip_skip <= 1 else configured_clip_skip - 1
    return configured_clip_skip, diffusers_clip_skip


def _publish_generation_preview(
    pipe,
    request_id: str,
    latents: Optional[torch.Tensor],
    step_index: int,
    total_steps: int,
    *,
    model_family: str,
    preview_method: str,
) -> None:
    if latents is None or latents.ndim != 4:
        return

    preview_image = preview_decoder.decode(pipe, latents, model_family, preview_method)
    if preview_image is None:
        return

    generation_preview_store.update(
        request_id,
        step=step_index + 1,
        total_steps=total_steps,
        image=preview_image,
        status="running",
    )


def _get_local_model_entries() -> list[dict[str, str]]:
    models_dir = settings.MODELS_DIR
    if not models_dir.exists():
        return []

    resolved_models_dir = models_dir.resolve()
    managed_local_paths = {
        Path(entry["local_path"]).resolve()
        for entry in _get_managed_model_entries()
    }
    entries: list[dict[str, str]] = []
    nested_model_count = 0
    try:
        for file in sorted(models_dir.iterdir()):
            if file.is_dir():
                # Checkpoints are only picked up from the top level; count nested
                # ones so users who organize models in subfolders get a hint.
                nested_model_count += sum(
                    1 for nested in file.rglob("*")
                    if nested.is_file() and nested.suffix.lower() in LOCAL_MODEL_SUFFIXES
                )
                continue
            if not file.is_file() or file.suffix.lower() not in LOCAL_MODEL_SUFFIXES:
                continue

            resolved_file = file.resolve()
            if resolved_file.parent != resolved_models_dir:
                logger.warning("Skipping local model outside MODELS_DIR: %s", resolved_file)
                continue
            if resolved_file in managed_local_paths:
                continue
            if resolved_file.stat().st_size <= 0:
                # 0-byte placeholders / interrupted copies can never be loaded.
                logger.warning("Skipping empty local model file: %s", resolved_file)
                continue

            entries.append({
                "id": str(resolved_file),
                "label": f"{resolved_file.name} (Local)",
                "family": model_manager.infer_model_family(str(resolved_file)),
                "source": "local",
                "filename": resolved_file.name,
                "downloaded": True,
                "size_mb": round(resolved_file.stat().st_size / (1024 * 1024), 1),
            })
    except Exception as e:
        logger.error(f"Failed to scan models directory: {e}")

    if nested_model_count:
        logger.warning(
            "Found %s checkpoint file(s) in subfolders of %s. Only top-level files are listed — "
            "move them up one level to use them.",
            nested_model_count,
            models_dir,
        )

    return entries


def _get_managed_model_entries() -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for entry in MANAGED_DOWNLOADABLE_MODELS:
        local_path = (settings.MODELS_DIR / entry["filename"]).resolve()
        entries.append({
            **entry,
            "local_path": str(local_path),
            "downloaded": local_path.exists() and local_path.is_file(),
            "auto_download": True,
        })
    return entries


def _get_allowed_model_map() -> dict[str, dict[str, str]]:
    entries = ALLOWED_CLOUD_MODELS + _get_managed_model_entries() + _get_local_model_entries()
    return {entry["id"]: entry for entry in entries}


def _append_token_to_url(url: str, token: str) -> str:
    parsed = urlparse(url)
    query_params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query_params["token"] = token
    return urlunparse(parsed._replace(query=urlencode(query_params)))


def _download_managed_model_sync(model_entry: dict[str, object]) -> tuple[str, bool]:
    model_id = str(model_entry["id"])
    target_path = Path(str(model_entry["local_path"])).resolve()
    download_url = str(model_entry["download_url"])
    requires_auth = bool(model_entry.get("requires_auth"))
    lock = MANAGED_MODEL_DOWNLOAD_LOCKS.setdefault(model_id, threading.Lock())

    with lock:
        if target_path.exists() and target_path.is_file() and target_path.stat().st_size > 0:
            logger.info("Managed model already available locally: id=%s path=%s", model_id, target_path)
            return str(target_path), False

        target_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = target_path.with_suffix(f"{target_path.suffix}.part")
        if temp_path.exists():
            temp_path.unlink()

        request_headers = {"User-Agent": settings.PROJECT_NAME}
        request_url = download_url
        if requires_auth:
            if not settings.CIVITAI_API_TOKEN:
                raise RuntimeError(
                    "CIVITAI_API_TOKEN is required to download this model. "
                    "Add it to backend/.env and restart the backend."
                )
            request_url = _append_token_to_url(download_url, settings.CIVITAI_API_TOKEN)

        logger.info("Downloading managed model: id=%s path=%s requires_auth=%s", model_id, target_path, requires_auth)
        request = UrlRequest(request_url, headers=request_headers)
        started_at = monotonic()
        try:
            with urlopen(request, timeout=900) as response, temp_path.open("wb") as output_file:
                total_bytes = int(response.headers.get("Content-Length", "0") or "0")
                logger.info(
                    "Managed model response opened: id=%s status=%s content_length_bytes=%s content_length_mb=%.2f",
                    model_id,
                    getattr(response, "status", "<unknown>"),
                    total_bytes or "<unknown>",
                    (total_bytes / (1024 * 1024)) if total_bytes else 0.0,
                )

                downloaded_bytes = 0
                chunk_size = 1024 * 1024
                last_logged_bytes = 0
                progress_log_step = 100 * 1024 * 1024

                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break

                    output_file.write(chunk)
                    downloaded_bytes += len(chunk)

                    if (
                        downloaded_bytes == len(chunk)
                        or downloaded_bytes - last_logged_bytes >= progress_log_step
                        or (total_bytes and downloaded_bytes >= total_bytes)
                    ):
                        elapsed = max(monotonic() - started_at, 0.001)
                        speed_mb_s = (downloaded_bytes / (1024 * 1024)) / elapsed
                        if total_bytes:
                            progress_pct = (downloaded_bytes / total_bytes) * 100
                            logger.info(
                                "Managed model download progress: id=%s downloaded_mb=%.2f total_mb=%.2f progress=%.1f%% speed_mb_s=%.2f",
                                model_id,
                                downloaded_bytes / (1024 * 1024),
                                total_bytes / (1024 * 1024),
                                progress_pct,
                                speed_mb_s,
                            )
                        else:
                            logger.info(
                                "Managed model download progress: id=%s downloaded_mb=%.2f speed_mb_s=%.2f",
                                model_id,
                                downloaded_bytes / (1024 * 1024),
                                speed_mb_s,
                            )
                        last_logged_bytes = downloaded_bytes
            temp_path.replace(target_path)
        except Exception:
            if temp_path.exists():
                temp_path.unlink()
            raise

        elapsed = max(monotonic() - started_at, 0.001)
        final_size_mb = target_path.stat().st_size / (1024 * 1024)
        logger.info(
            "Managed model download completed: id=%s path=%s size_mb=%.2f elapsed_s=%.2f avg_speed_mb_s=%.2f",
            model_id,
            target_path,
            final_size_mb,
            elapsed,
            final_size_mb / elapsed,
        )
        return str(target_path), True


async def _prepare_model_for_runtime(
    selected_model_id: str,
    allowed_model_entry: dict[str, object],
) -> tuple[str, bool]:
    if allowed_model_entry.get("source") != "managed_download":
        return selected_model_id, False

    logger.info("Preparing managed model for runtime: id=%s", selected_model_id)
    return await asyncio.to_thread(_download_managed_model_sync, allowed_model_entry)


def _normalize_model_family(model_family: Optional[str]) -> Optional[str]:
    if model_family is None:
        return None

    normalized_family = model_family.strip().lower()
    if not normalized_family:
        return None
    if normalized_family not in ALLOWED_MODEL_FAMILIES:
        raise _validation_error(
            f"model_family must be one of: {', '.join(sorted(ALLOWED_MODEL_FAMILIES))}."
        )
    return normalized_family


def _validate_int_field(name: str, value: int, low: int, high: int) -> int:
    if value < low or value > high:
        raise _validation_error(f"{name} must be between {low} and {high}.")
    return value


def _validate_float_field(name: str, value: float, low: float, high: float) -> float:
    if not math.isfinite(value):
        raise _validation_error(f"{name} must be a finite number.")
    if value < low or value > high:
        raise _validation_error(f"{name} must be between {low} and {high}.")
    return value


def _validate_dimension(name: str, value: int) -> int:
    _validate_int_field(name, value, MIN_DIMENSION, MAX_DIMENSION)
    if value % DIMENSION_MULTIPLE != 0:
        raise _validation_error(f"{name} must be a multiple of {DIMENSION_MULTIPLE}.")
    return value


def _validate_generation_inputs(
    *,
    width: int,
    height: int,
    steps: int,
    cfg: float,
    seed: int,
    model_id: str,
    model_family: Optional[str],
    sampler: str,
    mode: str,
    style_preset: Optional[str],
    denoising_strength: float,
    mask_blur: int,
    mask_padding: int,
) -> dict[str, object]:
    width = _validate_dimension("width", width)
    height = _validate_dimension("height", height)
    if width * height > MAX_GENERATION_PIXELS:
        raise _validation_error(
            f"Requested image area {width}x{height} exceeds limit of {MAX_GENERATION_PIXELS} pixels."
        )

    steps = _validate_int_field("steps", steps, MIN_STEPS, MAX_STEPS)
    seed = _validate_int_field("seed", seed, MIN_SEED, MAX_SEED)
    cfg = _validate_float_field("cfg", cfg, MIN_CFG, MAX_CFG)
    denoising_strength = _validate_float_field(
        "denoising_strength",
        denoising_strength,
        MIN_DENOISING_STRENGTH,
        MAX_DENOISING_STRENGTH,
    )
    mask_blur = _validate_int_field("mask_blur", mask_blur, MIN_MASK_BLUR, MAX_MASK_BLUR)
    mask_padding = _validate_int_field("mask_padding", mask_padding, MIN_MASK_PADDING, MAX_MASK_PADDING)

    if sampler in SAMPLER_ALIASES:
        normalized_sampler = SAMPLER_ALIASES[sampler]
        logger.warning("Sampler %r is a legacy alias; using %r.", sampler, normalized_sampler)
        sampler = normalized_sampler
    if sampler not in ALLOWED_SAMPLERS:
        raise _validation_error(f"Unsupported sampler: {sampler}")

    if mode not in ALLOWED_GENERATION_MODES:
        raise _validation_error(f"Unsupported mode: {mode}")

    if style_preset and style_preset not in STYLE_PRESETS:
        raise _validation_error(f"Unsupported style_preset: {style_preset}")

    allowed_models = _get_allowed_model_map()
    normalized_model_id = str(Path(model_id).resolve()) if model_id not in allowed_models and Path(model_id).is_absolute() else model_id
    allowed_model_entry = allowed_models.get(normalized_model_id)
    if allowed_model_entry is None:
        raise _validation_error("Unsupported model_id.")

    requested_model_family = _normalize_model_family(model_family)
    allowed_model_family = allowed_model_entry.get("family")
    if requested_model_family and allowed_model_family and requested_model_family != allowed_model_family:
        raise _validation_error(
            f"model_family={requested_model_family} does not match selected model family={allowed_model_family}."
        )
    resolved_model_family = (
        requested_model_family
        or allowed_model_family
        or model_manager.infer_model_family(normalized_model_id)
    )

    return {
        "width": width,
        "height": height,
        "steps": steps,
        "cfg": cfg,
        "seed": seed,
        "model_id": normalized_model_id,
        "model_entry": allowed_model_entry,
        "model_family": resolved_model_family,
        "sampler": sampler,
        "mode": mode,
        "style_preset": style_preset,
        "denoising_strength": denoising_strength,
        "mask_blur": mask_blur,
        "mask_padding": mask_padding,
    }

def _get_compel_for_pipe(pipe, model_family: Optional[str]):
    """Return a Compel wrapper bound to ``pipe``, reusing it across calls.

    Compel wraps the pipeline's tokenizer/text-encoder, so a fresh instance per
    generation just re-builds the same bindings. Cache it on the pipe object so
    its lifetime follows the pipeline (the entry disappears when the bundle is
    evicted) without keeping the pipe alive via a side cache.
    """
    cached = getattr(pipe, "_cached_compel_wrapper", None)
    if cached is not None:
        return cached

    if model_family == "sdxl":
        if CompelForSDXL is None:
            raise RuntimeError("compel is not installed.")
        compel = CompelForSDXL(pipe=pipe)
    else:
        if CompelForSD is None:
            raise RuntimeError("compel is not installed.")
        compel = CompelForSD(pipe=pipe)

    try:
        pipe._cached_compel_wrapper = compel
    except Exception:
        # Some pipeline objects may reject attribute assignment; fall back to
        # rebuilding per call rather than failing.
        pass
    return compel


def _process_prompt_with_compel(pipe, prompt: Optional[str], negative_prompt: Optional[str], model_family: Optional[str]) -> dict:
    prompt = prompt or ""
    negative_prompt = negative_prompt or ""

    compel = _get_compel_for_pipe(pipe, model_family)
    # CompelForSD/SDXL return a LabelledConditioning dataclass (not a tuple).
    # Encoding positive and negative prompts in one call also lets compel pad
    # both embeddings to the same length (separate calls can mismatch on long prompts).
    conditioning = compel(prompt, negative_prompt=negative_prompt)
    if model_family == "sdxl":
        return {
            "prompt_embeds": conditioning.embeds,
            "pooled_prompt_embeds": conditioning.pooled_embeds,
            "negative_prompt_embeds": conditioning.negative_embeds,
            "negative_pooled_prompt_embeds": conditioning.negative_pooled_embeds,
        }
    return {
        "prompt_embeds": conditioning.embeds,
        "negative_prompt_embeds": conditioning.negative_embeds,
    }


async def _read_upload_image(upload: UploadFile, *, mode: str) -> Image.Image:
    content = await upload.read()
    try:
        image = Image.open(io.BytesIO(content))
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid image in field: {upload.filename or 'upload'}")
    return image.convert(mode)


def _build_circle_mask(width: int, height: int, cx: int, cy: int, radius: int) -> Image.Image:
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=255)
    return mask


def _parse_selection_points(raw_points: str, width: int, height: int) -> list[tuple[int, int]]:
    try:
        payload = json.loads(raw_points)
    except Exception:
        raise _validation_error("selection_points must be valid JSON.")

    if not isinstance(payload, list) or len(payload) < 3:
        raise _validation_error("selection_points must contain at least 3 points.")

    points: list[tuple[int, int]] = []
    for point in payload:
        try:
            if isinstance(point, dict):
                x = int(point.get("x"))
                y = int(point.get("y"))
            elif isinstance(point, (list, tuple)) and len(point) >= 2:
                x = int(point[0])
                y = int(point[1])
            else:
                raise _validation_error("selection_points items must be [x,y] or {x,y}.")
        except Exception:
            raise _validation_error("selection_points items must contain integer x and y.")

        if x < 0 or y < 0 or x >= width or y >= height:
            raise _validation_error("selection_points must stay inside image bounds.")
        points.append((x, y))

    return points


def _build_polygon_mask(width: int, height: int, points: list[tuple[int, int]]) -> Image.Image:
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(points, fill=255)
    return mask


def _save_tool_image(image: Image.Image, meta: dict[str, object], prompt_slug: str) -> str:
    tool_meta = dict(meta)
    tool_meta["prompt"] = prompt_slug
    return save_image_with_metadata(image, tool_meta, str(settings.OUTPUT_DIR))

# --- Endpoints ---

class CancelGenerationRequest(BaseModel):
    request_id: str


class DeleteHistoryOutputRequest(BaseModel):
    url: Optional[str] = None
    urls: Optional[list[str]] = None


def _resolve_output_path_from_url(url: str) -> Path:
    raw_url = (url or "").strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="url is required")

    parsed = urlparse(raw_url)
    path_value = parsed.path or raw_url
    if not path_value.startswith("/outputs/"):
        raise HTTPException(status_code=400, detail="Only /outputs files can be deleted")

    relative_path = unquote(path_value.removeprefix("/outputs/")).lstrip("/")
    if not relative_path:
        raise HTTPException(status_code=400, detail="Invalid output path")

    output_dir = settings.OUTPUT_DIR.resolve()
    candidate_path = (output_dir / relative_path).resolve()
    if output_dir not in candidate_path.parents:
        raise HTTPException(status_code=400, detail="Output path escapes OUTPUT_DIR")

    return candidate_path

@app.post("/cancel")
def cancel_generation(payload: CancelGenerationRequest):
    if not payload.request_id.strip():
        raise HTTPException(status_code=400, detail="request_id is required")

    model_manager.request_cancel(payload.request_id)
    return {"status": "cancelling", "request_id": payload.request_id}


@app.post("/history/delete")
def delete_history_output(payload: DeleteHistoryOutputRequest):
    requested_urls: list[str] = []
    if payload.url:
        requested_urls.append(payload.url)
    if payload.urls:
        requested_urls.extend(payload.urls)

    unique_urls = [url for index, url in enumerate(requested_urls) if url and url not in requested_urls[:index]]
    if not unique_urls:
        raise HTTPException(status_code=400, detail="url or urls is required")

    deleted_urls: list[str] = []
    missing_urls: list[str] = []

    for url in unique_urls:
        target_path = _resolve_output_path_from_url(url)
        if not target_path.exists() or not target_path.is_file():
            missing_urls.append(url)
            continue

        try:
            target_path.unlink()
        except Exception as exc:
            logger.error("Failed to delete history output %s: %s", target_path, exc, exc_info=True)
            raise HTTPException(status_code=500, detail="Failed to delete output file")

        logger.info("Deleted history output file: %s", target_path)
        deleted_urls.append(url)

    if not deleted_urls:
        raise HTTPException(status_code=404, detail="Output file not found")

    return {
        "status": "success",
        "deleted_urls": deleted_urls,
        "missing_urls": missing_urls,
    }


@app.post("/history/save")
async def save_history_snapshot(
    image: UploadFile = File(...),
    prompt: Optional[str] = Form(default=None),
    raw_prompt: Optional[str] = Form(default=None),
    negative_prompt: Optional[str] = Form(default=None),
    seed: Optional[int] = Form(default=None),
    #_____________апдейт_______ Persist active editor tool in history metadata
    active_tool: Optional[str] = Form(default=None),
    generated_url: Optional[str] = Form(default=None),
):
    try:
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="image file is empty")

        with Image.open(io.BytesIO(image_bytes)) as opened_image:
            snapshot_image = opened_image.copy()
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Failed to decode history snapshot upload: %s", exc, exc_info=True)
        raise HTTPException(status_code=400, detail="Invalid history snapshot image")

    meta = {
        "prompt": prompt,
        "raw_prompt": raw_prompt,
        "negative_prompt": negative_prompt,
        "seed": seed,
        #_____________апдейт_______ Keep active tool in saved history png metadata
        "active_tool": _normalize_active_tool(active_tool),
        "generated_url": generated_url,
        "history_kind": "document_snapshot",
    }

    filename = save_image_with_metadata(snapshot_image, meta, str(settings.OUTPUT_DIR))
    url = f"/outputs/{filename}"
    logger.info("Saved history snapshot: %s", url)
    return {
        "status": "success",
        "url": url,
        "filename": filename,
    }

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.get("/")
def read_root():
    # При SERVE_FRONTEND корень отдаёт SPA (явный роут перебивает mount на "/"),
    # иначе — обычная JSON-заглушка API.
    if settings.SERVE_FRONTEND:
        index_file = settings.FRONTEND_DIST_DIR / "index.html"
        if index_file.is_file():
            return FileResponse(str(index_file))
    return {"message": "AI Image Gen API is running. Visit /docs for Swagger UI."}

@app.get("/models")
def list_models():
    return {"models": ALLOWED_CLOUD_MODELS + _get_managed_model_entries() + _get_local_model_entries()}


# --------------------------------------------------------------------------- #
# Панель настроек: чтение/правка backend/.env (правки применяются после рестарта)
# --------------------------------------------------------------------------- #
def _current_config_value(key: str) -> str:
    """Текущее эффективное значение настройки (как загружено на старте)."""
    raw = os.getenv(key)
    if raw is not None:
        return raw
    if key == "USE_CUDA":
        return "true" if settings.DEVICE == "cuda" else "false"
    if hasattr(settings, key):
        val = getattr(settings, key)
        if isinstance(val, bool):
            return "true" if val else "false"
        return str(val)
    return ""


@app.get("/config")
def get_config():
    values: dict[str, object] = {}
    for entry in SETTINGS_SCHEMA:
        key = entry["key"]
        if is_secret(key):
            # Секрет наружу не отдаём — только факт, задан ли он.
            values[key] = {"secret": True, "set": bool(os.getenv(key) or "")}
        else:
            values[key] = _current_config_value(key)
    return {
        "status": "success",
        "data": {
            "schema": SETTINGS_SCHEMA,
            "values": values,
            # editable=true только если на сервере задан админ-токен.
            "editable": bool(settings.SETTINGS_ADMIN_TOKEN),
            "env_file": str(settings.ENV_FILE_PATH),
        },
    }


class ConfigPatchRequest(BaseModel):
    values: dict[str, object]


@app.patch("/config")
def update_config(payload: ConfigPatchRequest, x_admin_token: str = Header(default="")):
    # Гейт: правка только при заданном на сервере SETTINGS_ADMIN_TOKEN и верном токене.
    if not settings.SETTINGS_ADMIN_TOKEN:
        raise HTTPException(
            status_code=403,
            detail="Редактирование выключено: задайте SETTINGS_ADMIN_TOKEN в backend/.env и перезапустите backend.",
        )
    if (x_admin_token or "").strip() != settings.SETTINGS_ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="Неверный админ-токен.")

    from dotenv import set_key

    written: list[str] = []
    for key, raw in (payload.values or {}).items():
        if key not in ALLOWLIST:
            raise HTTPException(status_code=422, detail=f"Недопустимый ключ настройки: {key}")
        # Секрет с пустым значением — не затираем существующий.
        if is_secret(key) and (raw is None or str(raw).strip() == ""):
            continue
        try:
            value = coerce_value(key, raw)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        set_key(str(settings.ENV_FILE_PATH), key, value)
        written.append(key)

    logger.info("Config updated via panel: keys=%s file=%s", written, settings.ENV_FILE_PATH)
    return {"status": "success", "restart_required": True, "written": written}


# --------------------------------------------------------------------------- #
# Управление моделями: скачивание с HuggingFace / Civit.ai + поиск (меню в UI)
# --------------------------------------------------------------------------- #
class ModelDownloadRequest(BaseModel):
    download_url: str
    filename: str
    model_id: Optional[str] = None
    auth: Optional[str] = "none"


class ModelDeleteRequest(BaseModel):
    filename: Optional[str] = None
    id: Optional[str] = None


@app.post("/models/download")
def start_model_download(payload: ModelDownloadRequest):
    try:
        job = model_download_manager.start(
            url=payload.download_url,
            filename=payload.filename,
            model_id=payload.model_id or payload.filename,
            auth=payload.auth or "none",
        )
    except ModelDownloadError as exc:
        raise _validation_error(str(exc))
    return job


@app.get("/models/downloads")
def list_model_downloads():
    return {"downloads": model_download_manager.list_jobs()}


@app.get("/models/download/{job_id}")
def get_model_download(job_id: str):
    job = model_download_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Download job not found.")
    return job


@app.post("/models/download/{job_id}/cancel")
def cancel_model_download(job_id: str):
    if not model_download_manager.cancel(job_id):
        raise HTTPException(status_code=404, detail="No active download with this id.")
    return {"status": "canceling", "job_id": job_id}


@app.post("/models/delete")
def delete_model(payload: ModelDeleteRequest):
    raw = payload.filename or payload.id
    if not raw:
        raise _validation_error("filename or id is required.")
    try:
        target = model_download_manager.resolve_target(raw)
    except ModelDownloadError as exc:
        raise _validation_error(str(exc))
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Model file not found.")
    try:
        target.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete model: {exc}")
    logger.info("Deleted local model: %s", target.name)
    return {"status": "deleted", "filename": target.name}


@app.get("/models/search/civitai")
def search_models_civitai(query: str = "", nsfw: bool = False, limit: int = 24):
    try:
        results = search_civitai(query, limit=limit, nsfw=nsfw)
    except ModelDownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"results": results}


@app.get("/models/search/huggingface")
def search_models_huggingface(query: str = "", limit: int = 24):
    try:
        results = search_huggingface(query, limit=limit)
    except ModelDownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"results": results}


@app.get("/models/huggingface/files")
def list_models_huggingface_files(repo: str):
    try:
        files = list_huggingface_files(repo)
    except ModelDownloadError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"repo": repo, "files": files}


#_____________апдейт_______ Prompt transformer preview contract
class PromptTransformPreviewRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    use_prompt_transform: Optional[bool] = None
    use_negative_prompt_transform: Optional[bool] = None


#_____________апдейт_______ Prompt transformer preview endpoint
@app.post("/prompt/transform")
async def preview_prompt_transform(payload: PromptTransformPreviewRequest):
    logger.info(
        "Preview prompt transform requested: prompt_len=%s negative_len=%s use_prompt_transform=%s use_negative_prompt_transform=%s",
        len((payload.prompt or "").strip()),
        len((payload.negative_prompt or "").strip()),
        payload.use_prompt_transform,
        payload.use_negative_prompt_transform,
    )
    result = await prompt_transformer.transform_prompt(
        raw_prompt=payload.prompt,
        use_prompt_transform=payload.use_prompt_transform,
        context={"user_negative_prompt": payload.negative_prompt or ""},
    )
    negative_result = await negative_prompt_transformer.transform_negative_prompt(
        raw_negative_prompt=payload.negative_prompt or "",
        use_negative_prompt_transform=payload.use_negative_prompt_transform,
        context={"user_prompt": payload.prompt or ""},
    )
    #_____________апдейт_______ Strict validation for preview endpoint
    transform_required = settings.PROMPT_TRANSFORM_ENABLED if payload.use_prompt_transform is None else payload.use_prompt_transform
    if transform_required and settings.PROMPT_TRANSFORM_STRICT and result.transform_status not in {"success", "skipped_empty", "disabled"}:
        detail = f"Prompt was not transformed. status={result.transform_status}"
        if result.error:
            detail = f"{detail}. error={result.error}"
        logger.warning(
            "Preview prompt transform failed in strict mode: status=%s error=%s",
            result.transform_status,
            result.error,
        )
        raise HTTPException(
            status_code=422,
            detail=detail,
        )
    negative_transform_required = (
        settings.NEG_PROMPT_TRANSFORM_ENABLED
        if payload.use_negative_prompt_transform is None
        else payload.use_negative_prompt_transform
    )
    if (
        negative_transform_required
        and settings.NEG_PROMPT_TRANSFORM_STRICT
        and len((payload.negative_prompt or "").strip()) > 0
        and negative_result.transform_status != "success"
    ):
        detail = f"Negative prompt was not transformed. status={negative_result.transform_status}"
        if negative_result.error:
            detail = f"{detail}. error={negative_result.error}"
        logger.warning(
            "Preview negative prompt transform failed in strict mode: status=%s error=%s",
            negative_result.transform_status,
            negative_result.error,
        )
        raise HTTPException(
            status_code=422,
            detail=detail,
        )
    logger.info(
        "Preview prompt transform completed: status=%s provider=%s latency_ms=%s negative_status=%s negative_provider=%s negative_latency_ms=%s",
        result.transform_status,
        result.provider,
        result.latency_ms,
        negative_result.transform_status,
        negative_result.provider,
        negative_result.latency_ms,
    )
    data = result.to_dict()
    data["negative_prompt_transform"] = negative_result.to_dict()
    return {"status": "success", "data": data}


#_____________апдейт_______ Prompt transformer health endpoint
@app.get("/prompt/health")
def prompt_transform_health():
    data = prompt_transformer.health()
    data["negative_prompt_transform"] = negative_prompt_transformer.health()
    return {"status": "success", "data": data}


@app.get("/generate/preview/{request_id}")
def get_generation_preview(request_id: str):
    preview = generation_preview_store.get(request_id)
    if preview is None:
        raise HTTPException(status_code=404, detail="Generation preview not found")
    return {"status": "success", "data": preview}


@app.post("/generate")
async def generate_image(
    prompt: str = Form(...),
    request_id: Optional[str] = Form(default=None),
    raw_prompt: Optional[str] = Form(default=None),
    use_prompt_transform: Optional[bool] = Form(default=None),
    use_negative_prompt_transform: Optional[bool] = Form(default=None),
    negative_prompt: str = Form(default="low quality, bad anatomy, ugly"),
    width: int = Form(default=512),
    height: int = Form(default=512),
    steps: int = Form(default=20),
    cfg: float = Form(default=7.5),
    seed: int = Form(default=-1),
    model_id: str = Form(default=settings.DEFAULT_MODEL_ID),
    model_family: Optional[str] = Form(default=None),
    sampler: str = Form(default="Euler a"),
    mode: str = Form(default="auto"), # auto, txt2img, img2img, inpainting
    style_preset: Optional[str] = Form(None),
    preview_method: Optional[str] = Form(default=None),
    denoising_strength: float = Form(default=0.75),
    mask_blur: int = Form(default=4),
    mask_padding: int = Form(default=32),
    #_____________апдейт_______ Active editor tool from frontend for traceability
    active_tool: Optional[str] = Form(default=None),
    init_image: UploadFile = File(None),
    mask_image: UploadFile = File(None),
):
    try:
        _ensure_ai_runtime_available()
        request_id = (request_id or "").strip() or uuid.uuid4().hex
        #_____________апдейт_______ Normalize active tool once per request
        active_tool = _normalize_active_tool(active_tool)

        validated = _validate_generation_inputs(
            width=width,
            height=height,
            steps=steps,
            cfg=cfg,
            seed=seed,
            model_id=model_id,
            model_family=model_family,
            sampler=sampler,
            mode=mode,
            style_preset=style_preset,
            denoising_strength=denoising_strength,
            mask_blur=mask_blur,
            mask_padding=mask_padding,
        )
        width = validated["width"]
        height = validated["height"]
        steps = validated["steps"]
        cfg = validated["cfg"]
        seed = validated["seed"]
        model_id = validated["model_id"]
        model_entry = validated["model_entry"]
        model_family = validated["model_family"]
        sampler = validated["sampler"]
        mode = validated["mode"]
        style_preset = validated["style_preset"]
        denoising_strength = validated["denoising_strength"]
        mask_blur = validated["mask_blur"]
        mask_padding = validated["mask_padding"]
        runtime_model_id, downloaded_managed_model = await _prepare_model_for_runtime(model_id, model_entry)

        #_____________апдейт_______ Prompt transform pipeline (raw user text -> SD prompt)
        source_prompt = raw_prompt.strip() if raw_prompt and raw_prompt.strip() else prompt
        transform_result = await prompt_transformer.transform_prompt(
            raw_prompt=source_prompt,
            use_prompt_transform=use_prompt_transform,
            context={
                "mode": mode,
                "model_id": model_id,
                "model_family": model_family,
                "user_negative_prompt": negative_prompt,
            },
        )
        final_prompt = transform_result.transformed_prompt
        final_negative_prompt = transform_result.transformed_negative_prompt
        logger.info(
            "Prompt transform status=%s provider=%s latency_ms=%s",
            transform_result.transform_status,
            transform_result.provider,
            transform_result.latency_ms,
        )
        #_____________апдейт_______ Strict transform gate (no SD run on failed transform)
        transform_required = settings.PROMPT_TRANSFORM_ENABLED if use_prompt_transform is None else use_prompt_transform
        if transform_required and settings.PROMPT_TRANSFORM_STRICT and transform_result.transform_status != "success":
            detail = f"Prompt was not transformed. status={transform_result.transform_status}"
            if transform_result.error:
                detail = f"{detail}. error={transform_result.error}"
            raise HTTPException(status_code=422, detail=detail)
        #_____________апдейт_______ Non-strict fallback still preserves SD run
        if transform_result.transform_status != "success":
            final_prompt = source_prompt
            final_negative_prompt = negative_prompt

        negative_transform_source = final_negative_prompt
        negative_transform_result = await negative_prompt_transformer.transform_negative_prompt(
            raw_negative_prompt=negative_transform_source,
            use_negative_prompt_transform=use_negative_prompt_transform,
            context={
                "mode": mode,
                "model_id": model_id,
                "model_family": model_family,
                "user_prompt": source_prompt,
            },
        )
        logger.info(
            "Negative prompt transform status=%s provider=%s latency_ms=%s",
            negative_transform_result.transform_status,
            negative_transform_result.provider,
            negative_transform_result.latency_ms,
        )
        negative_transform_required = (
            settings.NEG_PROMPT_TRANSFORM_ENABLED
            if use_negative_prompt_transform is None
            else use_negative_prompt_transform
        )
        if (
            negative_transform_required
            and settings.NEG_PROMPT_TRANSFORM_STRICT
            and negative_transform_result.transform_status not in {"success", "skipped_empty"}
        ):
            detail = (
                "Negative prompt was not transformed. "
                f"status={negative_transform_result.transform_status}"
            )
            if negative_transform_result.error:
                detail = f"{detail}. error={negative_transform_result.error}"
            raise HTTPException(status_code=422, detail=detail)
        if negative_transform_result.transform_status == "success":
            final_negative_prompt = negative_transform_result.transformed_negative_prompt
        else:
            final_negative_prompt = negative_transform_source

        # 0. Apply Preset
        if style_preset:
            final_prompt = f"{final_prompt}, {STYLE_PRESETS[style_preset]}"

        nsfw_filter_active = settings.NSFW_FILTER_ENABLED
        nsfw_negative_prompt_extra = (settings.NSFW_NEGATIVE_PROMPT or "").strip()
        resolved_preview_method = _resolve_preview_method(preview_method)
        preview_interval_steps = settings.LIVE_PREVIEW_INTERVAL_STEPS
        configured_clip_skip, diffusers_clip_skip = _resolve_clip_skip_for_diffusers()
        #_____________апдейт_______ Spot-heal profile flag (tool-aware generation behavior)
        spot_heal_profile_applied = False
        #_____________апдейт_______ Quick-select profile flag (selection blend refinement)
        quick_select_profile_applied = False
        nsfw_negative_prompt_applied = False
        if nsfw_filter_active and nsfw_negative_prompt_extra:
            merged_negative_prompt = _merge_negative_prompt_terms(
                final_negative_prompt,
                nsfw_negative_prompt_extra,
            )
            nsfw_negative_prompt_applied = merged_negative_prompt != (final_negative_prompt or "").strip()
            final_negative_prompt = merged_negative_prompt
        logger.info(
            "Generation request policies: request_id=%s nsfw_enabled=%s nsfw_applied=%s nsfw_extra_len=%s preview_method=%s preview_interval=%s clip_skip=%s diffusers_clip_skip=%s",
            request_id,
            nsfw_filter_active,
            nsfw_negative_prompt_applied,
            len(nsfw_negative_prompt_extra),
            resolved_preview_method,
            preview_interval_steps,
            configured_clip_skip,
            diffusers_clip_skip,
        )
             
        # Detect Mode & Process Inputs Early
        
        image_input = None
        generation_mask_input = None
        blend_mask_input = None
        has_transparency = False
        outpaint_ready_image = None
        outpaint_generation_mask = None
        outpaint_blend_mask = None
        
        # Load Init Image
        if init_image:
            img_bytes = await init_image.read()
            # Open as RGBA to preserve transparency
            image_input = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
            # Resize
            image_input = image_input.resize((width, height))
            alpha = image_input.getchannel("A")
            has_transparency = alpha.getextrema()[0] < 255
            
        # Load Mask Image (Manual)
        if mask_image:
            mask_bytes = await mask_image.read()
            raw_mask = Image.open(io.BytesIO(mask_bytes))
            generation_mask, blend_mask = process_mask_for_inpainting(
                raw_mask,
                mask_padding=mask_padding,
                mask_blur=mask_blur
            )
            generation_mask_input = generation_mask.resize((width, height), Image.Resampling.NEAREST)
            blend_mask_input = blend_mask.resize((width, height), Image.Resampling.BICUBIC)
            logger.info(
                "Prepared manual inpaint mask: blur=%s padding=%s generation_extrema=%s blend_extrema=%s size=%sx%s",
                mask_blur,
                mask_padding,
                generation_mask_input.getextrema(),
                blend_mask_input.getextrema(),
                width,
                height,
            )

        # Prepare outpaint context whenever transparency exists.
        if image_input and has_transparency:
            outpaint_ready_image, outpaint_generation_mask, outpaint_blend_mask = prepare_image_for_outpainting(
                image_input,
                mask_padding=mask_padding,
                mask_blur=mask_blur
            )

        # 1. Determine Actual Mode & Prepare for Outpainting
        actual_mode = mode
        
        if mode == "auto":
             if generation_mask_input:
                 actual_mode = "inpainting"
             elif image_input:
                 if has_transparency:
                     actual_mode = "inpainting"
                     logger.info("Auto-detected Transparency -> Outpainting Mode")
                 else:
                     actual_mode = "img2img"
             else:
                 actual_mode = "text2img"

        #_____________апдейт_______ Spot-heal tool profile for small-defect retouch
        if active_tool == "spot_heal" and actual_mode == "inpainting":
            final_negative_prompt = _merge_negative_prompt_terms(
                final_negative_prompt,
                "acne, pimples, dust, scratches, blemish, stain, artifact",
            )
            denoising_strength = min(denoising_strength, 0.55)
            spot_heal_profile_applied = True

        #_____________апдейт_______ Quick-select refine profile for pasted-object seam cleanup
        if active_tool == "quick_select" and actual_mode == "inpainting":
            final_negative_prompt = _merge_negative_prompt_terms(
                final_negative_prompt,
                "cutout edge, hard seam, duplicate artifact, mismatched texture, ghosting",
            )
            denoising_strength = max(denoising_strength, 0.62)
            quick_select_profile_applied = True

        # 2. Load Model
        pipeline_type = actual_mode
        if actual_mode not in ["text2img", "img2img", "inpainting", "controlnet"]:
            pipeline_type = "text2img" # fallback

        if model_manager.is_cancel_requested(request_id):
            raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

        generation_preview_store.start(request_id, steps)

        async with model_manager.generation_session(request_id):
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

            # NSFW-фильтр включён → safety-checker нужен ПЕРЕД генерацией:
            # подгружаем (скачивается при первом разе) и fail-fast, чтобы не
            # тратить SD-прогон, если классификатор недоступен.
            if settings.NSFW_FILTER_ENABLED:
                checker_ready = await asyncio.to_thread(nsfw_safety_checker.is_available)
                if not checker_ready:
                    generation_preview_store.clear(request_id)
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "NSFW-фильтр включён, но safety-checker не загрузился "
                            f"('{settings.NSFW_SAFETY_CHECKER_MODEL}'). Проверьте доступ к "
                            "модели или отключите фильтр: NSFW_FILTER_ENABLED=false."
                        ),
                    )

            pipe = await model_manager.get_model(
                runtime_model_id,
                model_family=model_family,
                pipeline_type=pipeline_type,
                sampler_name=sampler
            )
            model_manager.bind_active_pipeline(request_id, pipe)
            resolved_preview_method = preview_decoder.prepare(pipe, model_family, resolved_preview_method)
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

            if seed == -1:
                seed = random.randint(0, 2**32 - 1)

            generator = torch.Generator(device=model_manager.device).manual_seed(seed)
            if diffusers_clip_skip is not None:
                # compel has no clip-skip support, so honoring CLIP_SKIP>1 requires
                # the plain diffusers parser (A1111 prompt weights are unavailable).
                logger.info(
                    "CLIP_SKIP=%s configured; using diffusers prompt parser instead of Compel.",
                    configured_clip_skip,
                )
                prompt_call_kwargs = {
                    "prompt": final_prompt,
                    "negative_prompt": final_negative_prompt,
                    "clip_skip": diffusers_clip_skip,
                }
            else:
                try:
                    # Use Compel to process the prompts with A1111 weights
                    embeds_kwargs = _process_prompt_with_compel(
                        pipe,
                        final_prompt,
                        final_negative_prompt,
                        model_family
                    )
                    prompt_call_kwargs = {
                        **embeds_kwargs
                    }
                except Exception as e:
                    logger.warning(f"Compel prompt processing failed: {e}. Falling back to default diffusers parser.")
                    prompt_call_kwargs = {
                        "prompt": final_prompt,
                        "negative_prompt": final_negative_prompt,
                        "clip_skip": diffusers_clip_skip,
                    }

            result_image = None
            logger.info(
                "Starting Generation: request_id=%s family=%s Mode=%s Size=%sx%s Seed=%s nsfw_filter=%s nsfw_negative_applied=%s",
                request_id,
                model_family,
                actual_mode,
                width,
                height,
                seed,
                nsfw_filter_active,
                nsfw_negative_prompt_applied,
            )

            def step_callback(pipeline, step_index, timestep, callback_kwargs):
                if model_manager.is_cancel_requested(request_id):
                    logger.info("Interrupting pipeline request_id=%s at step %s", request_id, step_index)
                    pipeline._interrupt = True

                should_publish_preview = (
                    step_index == 0
                    or (step_index + 1) % preview_interval_steps == 0
                    or (step_index + 1) >= steps
                )
                if should_publish_preview:
                    try:
                        _publish_generation_preview(
                            pipeline,
                            request_id,
                            callback_kwargs.get("latents"),
                            step_index,
                            steps,
                            model_family=model_family,
                            preview_method=resolved_preview_method,
                        )
                    except Exception as preview_error:
                        logger.warning(
                            "Failed to publish generation preview: request_id=%s step=%s error=%s",
                            request_id,
                            step_index + 1,
                            preview_error,
                        )
                return callback_kwargs

            # 4. Generate
            if actual_mode == "text2img":
                result = await asyncio.to_thread(
                    pipe,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    generator=generator,
                    callback_on_step_end=step_callback,
                    callback_on_step_end_tensor_inputs=["latents"],
                    **prompt_call_kwargs,
                )
                result_image = result.images[0]

            elif actual_mode == "img2img":
                if not image_input:
                    raise HTTPException(status_code=400, detail="Img2Img requires init_image")
                if image_input.mode == "RGBA":
                    image_input = image_input.convert("RGB")

                result = await asyncio.to_thread(
                    pipe,
                    image=image_input,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    strength=denoising_strength,
                    generator=generator,
                    callback_on_step_end=step_callback,
                    callback_on_step_end_tensor_inputs=["latents"],
                    **prompt_call_kwargs,
                )
                result_image = result.images[0]

            elif actual_mode == "inpainting":
                if image_input is None:
                    image_input = Image.new("RGB", (width, height), (0, 0, 0))

                if has_transparency and outpaint_ready_image is not None:
                    image_input = outpaint_ready_image
                    generation_mask_input, blend_mask_input = merge_generation_masks(
                        generation_mask_input,
                        blend_mask_input,
                        outpaint_generation_mask,
                        outpaint_blend_mask,
                    )
                    # Outpainting needs strong rewrite in transparent areas.
                    denoising_strength = max(denoising_strength, 0.95)
                elif image_input.mode == "RGBA":
                    image_input = image_input.convert("RGB")

                if generation_mask_input is None:
                    raise HTTPException(status_code=400, detail="Inpainting requires mask_image or transparent init_image")
                logger.info(
                    "Using inpaint masks: generation_extrema=%s blend_extrema=%s blur=%s padding=%s",
                    generation_mask_input.getextrema(),
                    blend_mask_input.getextrema() if blend_mask_input is not None else None,
                    mask_blur,
                    mask_padding,
                )

                result = await asyncio.to_thread(
                    pipe,
                    image=image_input,
                    mask_image=generation_mask_input,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    strength=denoising_strength,
                    generator=generator,
                    callback_on_step_end=step_callback,
                    callback_on_step_end_tensor_inputs=["latents"],
                    **prompt_call_kwargs,
                )
                result_image = result.images[0]

                # COMPOSITING
                # Essential for "Inpainting" to preserve unmasked pixels bit-perfectly.
                # Essential for "Outpainting" to keep the original context sharp (not VAE-reconstructed).
                if image_input and blend_mask_input and result_image.size == image_input.size == blend_mask_input.size:
                    blend_background = image_input
                    if (
                        has_transparency
                        and outpaint_generation_mask is not None
                        and outpaint_generation_mask.size == result_image.size
                    ):
                        # Для outpaint фон блендинга должен быть ЧИСТЫМ: резкий
                        # оригинал там, где он есть, и сгенерированный результат
                        # в дыре. Иначе перо шва подмешивает blur-заливку с шумом
                        # (которой засеяна дыра) → шумный стык. Подменяем дыру
                        # результатом до растушёвки.
                        blend_background = image_input.copy()
                        blend_background.paste(result_image, mask=outpaint_generation_mask)
                    # Use feather_blend logic for seamless edges
                    result_image = feather_blend(
                        blend_background,
                        result_image,
                        blend_mask_input,
                    )

            # 4.5 Check for cancellation
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

        # 4.6 NSFW gate. Когда фильтр включён, каждая готовая картинка проходит
        # классификатор (модель уже подгружена выше). Fail-closed: если он вдруг
        # недоступен — картинку НЕ отдаём.
        if result_image is not None and settings.NSFW_FILTER_ENABLED:
            verdict = await asyncio.to_thread(nsfw_safety_checker.is_nsfw, result_image)
            if verdict is None:
                logger.error(
                    "NSFW gate: safety checker unavailable — blocking output (request_id=%s)",
                    request_id,
                )
                generation_preview_store.clear(request_id)
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "NSFW-фильтр недоступен (safety-checker не загрузился). "
                        "Картинка заблокирована. Проверьте доступ к модели "
                        f"'{settings.NSFW_SAFETY_CHECKER_MODEL}' или отключите фильтр: "
                        "NSFW_FILTER_ENABLED=false."
                    ),
                )
            if verdict is True:
                logger.warning("NSFW gate: blocked flagged image (request_id=%s)", request_id)
                generation_preview_store.clear(request_id)
                raise HTTPException(
                    status_code=422,
                    detail="Результат заблокирован NSFW-фильтром.",
                )

        # 5. Save & Return
        if result_image:
            generation_preview_store.update(
                request_id,
                step=steps,
                total_steps=steps,
                image=result_image,
                status="completed",
            )
            # Metadata dict
            meta = {
                "prompt": final_prompt,
                "negative_prompt": final_negative_prompt,
                "raw_negative_prompt": negative_prompt,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "model_id": model_id,
                "runtime_model_id": runtime_model_id if runtime_model_id != model_id else "",
                "model_family": model_family,
                "model_auto_download": bool(model_entry.get("auto_download")),
                "model_downloaded_now": downloaded_managed_model,
                "mode": actual_mode,
                #_____________апдейт_______ Prompt transformation trace
                "raw_prompt": transform_result.raw_prompt,
                "transformed_prompt": transform_result.transformed_prompt,
                "transformed_negative_prompt": final_negative_prompt,
                "transformed_negative_prompt_from_positive": transform_result.transformed_negative_prompt,
                "prompt_transform_status": transform_result.transform_status,
                "prompt_transform_provider": transform_result.provider,
                "prompt_transform_latency_ms": transform_result.latency_ms,
                "prompt_transform_strict": settings.PROMPT_TRANSFORM_STRICT,
                "negative_prompt_transform_source": negative_transform_source,
                "negative_prompt_transform_status": negative_transform_result.transform_status,
                "negative_prompt_transform_provider": negative_transform_result.provider,
                "negative_prompt_transform_latency_ms": negative_transform_result.latency_ms,
                "negative_prompt_transform_strict": settings.NEG_PROMPT_TRANSFORM_STRICT,
                "nsfw_filter_active": nsfw_filter_active,
                "nsfw_negative_prompt_applied": nsfw_negative_prompt_applied,
                "nsfw_negative_prompt_extra": nsfw_negative_prompt_extra if nsfw_filter_active else "",
                "clip_skip": configured_clip_skip,
                "diffusers_clip_skip": diffusers_clip_skip,
                "preview_method": resolved_preview_method,
                "preview_interval_steps": preview_interval_steps,
                #_____________апдейт_______ Active editor tool trace from frontend
                "active_tool": active_tool,
                #_____________апдейт_______ Spot-heal profile telemetry
                "spot_heal_profile_applied": spot_heal_profile_applied,
                #_____________апдейт_______ Quick-select profile telemetry
                "quick_select_profile_applied": quick_select_profile_applied,
            }
            #_____________апдейт_______ Keep error details only when fallback happened
            if transform_result.error:
                meta["prompt_transform_error"] = transform_result.error
            if negative_transform_result.error:
                meta["negative_prompt_transform_error"] = negative_transform_result.error
            
            filename = save_image_with_metadata(result_image, meta, str(settings.OUTPUT_DIR))
            return {
                "status": "success",
                "url": f"/outputs/{filename}",
                "request_id": request_id,
                "meta": meta
            }
            
    except HTTPException as e:
        # request_id is a Form parameter, so it is always bound here.
        if request_id:
            generation_preview_store.mark(
                request_id,
                status="cancelled" if e.status_code == 499 else "error",
            )
        raise
    except GenerationBusyError:
        # Backpressure, not a generation failure: never reached the lock, so no
        # partial work to clean up. Let the dedicated 429 handler answer.
        if request_id:
            generation_preview_store.mark(request_id, status="error")
        raise
    except Exception as e:
        if request_id:
            generation_preview_store.mark(request_id, status="error")
        logger.error(f"Generation failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tools/spot-heal")
async def tool_spot_heal(
    init_image: UploadFile = File(...),
    mask_image: UploadFile = File(default=None),
    center_x: Optional[int] = Form(default=None),
    center_y: Optional[int] = Form(default=None),
    radius: int = Form(default=20),
    mask_blur: int = Form(default=8),
    mask_padding: int = Form(default=4),
):
    source = await _read_upload_image(init_image, mode="RGB")
    radius = _validate_int_field("radius", radius, 1, 512)
    mask_blur = _validate_int_field("mask_blur", mask_blur, 0, 128)
    mask_padding = _validate_int_field("mask_padding", mask_padding, 0, 128)

    if mask_image is not None:
        raw_mask = await _read_upload_image(mask_image, mode="L")
        raw_mask = raw_mask.resize(source.size, Image.Resampling.NEAREST)
    else:
        if center_x is None or center_y is None:
            raise _validation_error("Provide mask_image or center_x/center_y.")
        if center_x < 0 or center_y < 0 or center_x >= source.width or center_y >= source.height:
            raise _validation_error("center_x/center_y must be inside image bounds.")
        raw_mask = _build_circle_mask(source.width, source.height, center_x, center_y, radius)

    generation_mask, blend_mask = process_mask_for_inpainting(
        raw_mask,
        mask_padding=mask_padding,
        mask_blur=mask_blur,
    )
    healed = source.filter(ImageFilter.MedianFilter(size=5)).filter(ImageFilter.GaussianBlur(radius=1.4))
    result = feather_blend(source, healed, blend_mask)

    filename = _save_tool_image(
        result,
        {
            "tool": "spot_heal",
            "mask_blur": mask_blur,
            "mask_padding": mask_padding,
            "radius": radius,
        },
        "tool_spot_heal",
    )
    return {
        "status": "success",
        "url": f"/outputs/{filename}",
        "meta": {
            "tool": "spot_heal",
            "width": source.width,
            "height": source.height,
            "mask_blur": mask_blur,
            "mask_padding": mask_padding,
        },
    }


@app.post("/tools/clone-stamp")
async def tool_clone_stamp(
    init_image: UploadFile = File(...),
    source_x: int = Form(...),
    source_y: int = Form(...),
    target_x: int = Form(...),
    target_y: int = Form(...),
    radius: int = Form(default=24),
    feather: int = Form(default=8),
):
    source = await _read_upload_image(init_image, mode="RGB")
    radius = _validate_int_field("radius", radius, 1, 512)
    feather = _validate_int_field("feather", feather, 0, 128)

    for field_name, x_value, y_value in (
        ("source", source_x, source_y),
        ("target", target_x, target_y),
    ):
        if x_value < 0 or y_value < 0 or x_value >= source.width or y_value >= source.height:
            raise _validation_error(f"{field_name}_x/{field_name}_y must be inside image bounds.")

    crop_box = (
        max(0, source_x - radius),
        max(0, source_y - radius),
        min(source.width, source_x + radius + 1),
        min(source.height, source_y + radius + 1),
    )
    patch = source.crop(crop_box)
    patch_layer = Image.new("RGB", source.size, (0, 0, 0))
    patch_presence = Image.new("L", source.size, 0)

    target_left = target_x - patch.width // 2
    target_top = target_y - patch.height // 2
    patch_layer.paste(patch, (target_left, target_top))
    patch_presence.paste(255, (target_left, target_top, target_left + patch.width, target_top + patch.height))

    circle_mask = _build_circle_mask(source.width, source.height, target_x, target_y, radius)
    composed_mask = ImageChops.multiply(circle_mask, patch_presence)
    if feather > 0:
        composed_mask = composed_mask.filter(ImageFilter.GaussianBlur(radius=feather))

    result = Image.composite(patch_layer, source, composed_mask)
    filename = _save_tool_image(
        result,
        {
            "tool": "clone_stamp",
            "radius": radius,
            "feather": feather,
            "source_x": source_x,
            "source_y": source_y,
            "target_x": target_x,
            "target_y": target_y,
        },
        "tool_clone_stamp",
    )
    return {
        "status": "success",
        "url": f"/outputs/{filename}",
        "meta": {
            "tool": "clone_stamp",
            "width": source.width,
            "height": source.height,
            "radius": radius,
            "feather": feather,
        },
    }


@app.post("/tools/quick-select/refine")
async def tool_quick_select_refine(
    init_image: UploadFile = File(...),
    mask_image: UploadFile = File(default=None),
    selection_points: Optional[str] = Form(default=None),
    selection_left: Optional[int] = Form(default=None),
    selection_top: Optional[int] = Form(default=None),
    selection_width: Optional[int] = Form(default=None),
    selection_height: Optional[int] = Form(default=None),
    expand: int = Form(default=6),
    feather: int = Form(default=8),
):
    source = await _read_upload_image(init_image, mode="RGB")
    expand = _validate_int_field("expand", expand, 0, 128)
    feather = _validate_int_field("feather", feather, 0, 128)

    if mask_image is not None:
        raw_mask = await _read_upload_image(mask_image, mode="L")
        raw_mask = raw_mask.resize(source.size, Image.Resampling.NEAREST)
    elif selection_points:
        points = _parse_selection_points(selection_points, source.width, source.height)
        raw_mask = _build_polygon_mask(source.width, source.height, points)
    elif (
        selection_left is not None
        and selection_top is not None
        and selection_width is not None
        and selection_height is not None
    ):
        if selection_width <= 0 or selection_height <= 0:
            raise _validation_error("selection_width and selection_height must be > 0.")
        if selection_left < 0 or selection_top < 0:
            raise _validation_error("selection_left and selection_top must be >= 0.")
        if selection_left + selection_width > source.width or selection_top + selection_height > source.height:
            raise _validation_error("selection rectangle must stay inside image bounds.")
        raw_mask = Image.new("L", source.size, 0)
        draw = ImageDraw.Draw(raw_mask)
        draw.rectangle(
            (
                selection_left,
                selection_top,
                selection_left + selection_width,
                selection_top + selection_height,
            ),
            fill=255,
        )
    else:
        raise _validation_error(
            "Provide mask_image, selection_points, or selection_left/top/width/height."
        )

    generation_mask, blend_mask = process_mask_for_inpainting(
        raw_mask,
        mask_padding=expand,
        mask_blur=feather,
    )
    bbox = generation_mask.getbbox()

    generation_filename = _save_tool_image(
        generation_mask,
        {
            "tool": "quick_select_refine_generation_mask",
            "expand": expand,
            "feather": feather,
        },
        "tool_quick_select_generation_mask",
    )
    blend_filename = _save_tool_image(
        blend_mask,
        {
            "tool": "quick_select_refine_blend_mask",
            "expand": expand,
            "feather": feather,
        },
        "tool_quick_select_blend_mask",
    )

    return {
        "status": "success",
        "data": {
            "generation_mask_url": f"/outputs/{generation_filename}",
            "blend_mask_url": f"/outputs/{blend_filename}",
            "bbox": {
                "left": int(bbox[0]) if bbox else 0,
                "top": int(bbox[1]) if bbox else 0,
                "right": int(bbox[2]) if bbox else 0,
                "bottom": int(bbox[3]) if bbox else 0,
            },
            "width": source.width,
            "height": source.height,
            "expand": expand,
            "feather": feather,
        },
    }


#_____________апдейт_______ Fast quick-select refine endpoint (selection -> local inpaint)
@app.post("/quick-select/refine")
async def quick_select_refine(
    init_image: UploadFile = File(...),
    mask_image: UploadFile = File(None),
    request_id: Optional[str] = Form(default=None),
    prompt: Optional[str] = Form(default=None),
    negative_prompt: Optional[str] = Form(default=None),
    width: int = Form(default=512),
    height: int = Form(default=512),
    steps: int = Form(default=16),
    cfg: float = Form(default=7.0),
    seed: int = Form(default=-1),
    model_id: str = Form(default=settings.DEFAULT_MODEL_ID),
    model_family: Optional[str] = Form(default=None),
    sampler: str = Form(default="Euler a"),
    denoising_strength: float = Form(default=0.62),
    mask_blur: int = Form(default=12),
    mask_padding: int = Form(default=20),
    selection_left: Optional[int] = Form(default=None),
    selection_top: Optional[int] = Form(default=None),
    selection_width: Optional[int] = Form(default=None),
    selection_height: Optional[int] = Form(default=None),
    selection_feather: int = Form(default=10),
):
    #_____________апдейт_______ Quick-select prompt defaults and safety caps
    quick_prompt = (prompt or "").strip() or (
        "blend duplicated object naturally, preserve scene lighting, preserve perspective, seamless composition"
    )
    quick_negative_prompt = (negative_prompt or "").strip() or (
        "hard seam, cutout edge, duplicate artifact, ghosting, blurry edge, mismatch texture"
    )
    quick_steps = max(6, min(28, int(steps)))
    quick_cfg = max(4.0, min(14.0, float(cfg)))
    quick_denoising_strength = max(0.45, min(0.8, float(denoising_strength)))
    quick_mask_blur = max(0, min(96, int(mask_blur)))
    quick_mask_padding = max(0, min(96, int(mask_padding)))
    quick_selection_feather = max(0, min(64, int(selection_feather)))

    #_____________апдейт_______ Build mask from contour upload or rectangle fallback
    if mask_image is not None:
        mask_upload = mask_image
        selection_log = "custom_mask"
    else:
        if None in (selection_left, selection_top, selection_width, selection_height):
            raise _validation_error(
                "quick-select refine requires either mask_image or selection_left/top/width/height."
            )
        selection_mask = _build_quick_select_mask(
            width=width,
            height=height,
            selection_left=selection_left,
            selection_top=selection_top,
            selection_width=selection_width,
            selection_height=selection_height,
            feather=quick_selection_feather,
        )
        mask_buffer = io.BytesIO()
        selection_mask.save(mask_buffer, format="PNG")
        mask_buffer.seek(0)
        mask_upload = UploadFile(filename="quick-select-mask.png", file=mask_buffer)
        selection_log = f"{selection_left},{selection_top},{selection_width},{selection_height}"

    logger.info(
        "Quick-select refine request: request_id=%s model_id=%s size=%sx%s selection=%s steps=%s cfg=%s denoise=%s",
        request_id,
        model_id,
        width,
        height,
        selection_log,
        quick_steps,
        quick_cfg,
        quick_denoising_strength,
    )

    #_____________апдейт_______ Reuse core generation endpoint with forced inpainting profile
    return await generate_image(
        prompt=quick_prompt,
        request_id=request_id,
        raw_prompt=quick_prompt,
        use_prompt_transform=False,
        negative_prompt=quick_negative_prompt,
        width=width,
        height=height,
        steps=quick_steps,
        cfg=quick_cfg,
        seed=seed,
        model_id=model_id,
        model_family=model_family,
        sampler=sampler,
        mode="inpainting",
        style_preset=None,
        preview_method=None,
        denoising_strength=quick_denoising_strength,
        mask_blur=quick_mask_blur,
        mask_padding=quick_mask_padding,
        init_image=init_image,
        mask_image=mask_upload,
        active_tool="quick_select",
    )


#_____________апдейт_______ Fast spot-heal endpoint (click -> instant local inpaint)
@app.post("/spot-heal")
async def spot_heal(
    init_image: UploadFile = File(...),
    mask_image: UploadFile = File(...),
    request_id: Optional[str] = Form(default=None),
    prompt: Optional[str] = Form(default=None),
    negative_prompt: Optional[str] = Form(default=None),
    width: int = Form(default=512),
    height: int = Form(default=512),
    steps: int = Form(default=12),
    cfg: float = Form(default=6.0),
    seed: int = Form(default=-1),
    model_id: str = Form(default=settings.DEFAULT_MODEL_ID),
    model_family: Optional[str] = Form(default=None),
    sampler: str = Form(default="Euler a"),
    denoising_strength: float = Form(default=0.45),
    mask_blur: int = Form(default=8),
    mask_padding: int = Form(default=16),
):
    #_____________апдейт_______ Spot-heal safe defaults with strict caps for responsiveness
    spot_prompt = (prompt or "").strip() or (
        "clean seamless local retouch, preserve original composition, preserve lighting, preserve texture"
    )
    spot_negative_prompt = (negative_prompt or "").strip() or (
        "artifact, blur, smudge, overprocessed, oversmoothed, distorted details"
    )
    spot_steps = max(4, min(24, int(steps)))
    spot_cfg = max(3.0, min(12.0, float(cfg)))
    spot_denoising_strength = max(0.2, min(0.65, float(denoising_strength)))
    spot_mask_blur = max(0, min(64, int(mask_blur)))
    spot_mask_padding = max(0, min(64, int(mask_padding)))

    logger.info(
        "Spot-heal request received: request_id=%s model_id=%s size=%sx%s steps=%s cfg=%s denoise=%s mask_blur=%s mask_padding=%s",
        request_id,
        model_id,
        width,
        height,
        spot_steps,
        spot_cfg,
        spot_denoising_strength,
        spot_mask_blur,
        spot_mask_padding,
    )

    #_____________апдейт_______ Reuse core generation endpoint with forced inpainting profile
    return await generate_image(
        prompt=spot_prompt,
        request_id=request_id,
        raw_prompt=spot_prompt,
        use_prompt_transform=False,
        negative_prompt=spot_negative_prompt,
        width=width,
        height=height,
        steps=spot_steps,
        cfg=spot_cfg,
        seed=seed,
        model_id=model_id,
        model_family=model_family,
        sampler=sampler,
        mode="inpainting",
        style_preset=None,
        preview_method=None,
        denoising_strength=spot_denoising_strength,
        mask_blur=spot_mask_blur,
        mask_padding=spot_mask_padding,
        init_image=init_image,
        mask_image=mask_image,
        active_tool="spot_heal",
    )

MIN_SCALE_FACTOR = 0.1
MAX_SCALE_FACTOR = 16.0
# Cap on the upscaled output area: prevents a large upload x16 from
# allocating a multi-gigabyte PIL buffer and OOM-killing the process.
MAX_UPSCALE_PIXELS = 4096 * 4096


@app.post("/upscale")
async def upscale_image(
    image: UploadFile = File(...),
    scale_factor: float = Form(default=2.0)
):
    """
    Architecture placeholder for Upscaling.
    Currently implements a simple resize, but ready for SwinIR/RealESRGAN integration.
    """
    if not math.isfinite(scale_factor) or scale_factor < MIN_SCALE_FACTOR or scale_factor > MAX_SCALE_FACTOR:
        raise HTTPException(
            status_code=422,
            detail=f"scale_factor must be a finite number between {MIN_SCALE_FACTOR} and {MAX_SCALE_FACTOR}.",
        )
    try:
        content = await image.read()
        pil_image = Image.open(io.BytesIO(content)).convert("RGB")

        # Placeholder implementation: Bicubic resize
        new_width = int(pil_image.width * scale_factor)
        new_height = int(pil_image.height * scale_factor)
        if new_width < 1 or new_height < 1:
            raise HTTPException(
                status_code=422,
                detail="Upscaled image dimensions must be at least 1x1 pixel.",
            )
        if new_width * new_height > MAX_UPSCALE_PIXELS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Upscaled image area {new_width}x{new_height} exceeds the limit "
                    f"of {MAX_UPSCALE_PIXELS} pixels. Reduce scale_factor or input size."
                ),
            )
        upscaled = pil_image.resize((new_width, new_height), Image.BICUBIC)

        filename = save_image_with_metadata(upscaled, {"upscale": scale_factor}, str(settings.OUTPUT_DIR))
        return {"status": "success", "url": f"/outputs/{filename}"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upscale failed: {e}")

# Раздача собранного фронтенда (вариант A: один origin = один публичный URL).
# Монтируется ПОСЛЕ всех API-роутов, поэтому конкретные эндпоинты матчатся
# первыми, а на "/" уже стоит явный read_root (он перебивает этот mount).
# html=True отдаёт index.html для каталога; клиентского роутинга у SPA нет.
if settings.SERVE_FRONTEND:
    if settings.FRONTEND_DIST_DIR.is_dir():
        app.mount(
            "/",
            StaticFiles(directory=str(settings.FRONTEND_DIST_DIR), html=True),
            name="frontend",
        )
        logger.info("Serving frontend SPA from %s", settings.FRONTEND_DIST_DIR)
    else:
        logger.warning(
            "SERVE_FRONTEND=true, но сборка не найдена: %s (соберите фронт)",
            settings.FRONTEND_DIST_DIR,
        )

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
