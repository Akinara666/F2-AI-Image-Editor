from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import random
from typing import Optional
from pathlib import Path
import math
import uvicorn
import io
import asyncio
import traceback
import uuid
from PIL import Image
import torch
from pydantic import BaseModel

# Import core modules
from core.manager import model_manager
from core.utils import (
    save_image_with_metadata,
    process_mask_for_inpainting,
    prepare_image_for_outpainting,
    feather_blend,
    merge_generation_masks,
)
from core.config import STYLE_PRESETS, settings
from core.prompt_transformer import prompt_transformer
import logging

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

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

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global Error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__}
    )

# --- Presets & configuration ---
# Imports from core.config

ALLOWED_CLOUD_MODELS = [
    {"id": "runwayml/stable-diffusion-v1-5", "label": "SD v1.5 Base (Cloud)"},
    {"id": "Lykon/DreamShaper", "label": "DreamShaper (Cloud)"},
    {"id": "prompthero/openjourney-v4", "label": "OpenJourney v4 (Cloud)"},
]
ALLOWED_SAMPLERS = {
    "Euler a",
    "Euler",
    "DPM++ 2M Karras",
    "DPM++ 2S a Karras",
    "DPM++ SDE Karras",
    "DPM2 a Karras",
    "DDIM",
    "DDPM",
    "Heun",
    "UniPC",
    "LMS",
}
ALLOWED_GENERATION_MODES = {"auto", "text2img", "img2img", "inpainting"}
LOCAL_MODEL_SUFFIXES = {".safetensors", ".ckpt"}
MIN_DIMENSION = 64
MAX_DIMENSION = 2048
MAX_GENERATION_PIXELS = 1024 * 1024
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
MAX_MASK_BLUR = 64
MIN_MASK_PADDING = 0
MAX_MASK_PADDING = 128


def _validation_error(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _get_local_model_entries() -> list[dict[str, str]]:
    models_dir = settings.MODELS_DIR
    if not models_dir.exists():
        return []

    resolved_models_dir = models_dir.resolve()
    entries: list[dict[str, str]] = []
    try:
        for file in sorted(models_dir.iterdir()):
            if not file.is_file() or file.suffix.lower() not in LOCAL_MODEL_SUFFIXES:
                continue

            resolved_file = file.resolve()
            if resolved_file.parent != resolved_models_dir:
                logger.warning("Skipping local model outside MODELS_DIR: %s", resolved_file)
                continue

            entries.append({"id": str(resolved_file), "label": f"{resolved_file.name} (Local)"})
    except Exception as e:
        logger.error(f"Failed to scan models directory: {e}")

    return entries


def _get_allowed_model_map() -> dict[str, str]:
    entries = ALLOWED_CLOUD_MODELS + _get_local_model_entries()
    return {entry["id"]: entry["label"] for entry in entries}


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

    if sampler not in ALLOWED_SAMPLERS:
        raise _validation_error(f"Unsupported sampler: {sampler}")

    if mode not in ALLOWED_GENERATION_MODES:
        raise _validation_error(f"Unsupported mode: {mode}")

    if style_preset and style_preset not in STYLE_PRESETS:
        raise _validation_error(f"Unsupported style_preset: {style_preset}")

    allowed_models = _get_allowed_model_map()
    normalized_model_id = str(Path(model_id).resolve()) if model_id not in allowed_models and Path(model_id).is_absolute() else model_id
    if normalized_model_id not in allowed_models:
        raise _validation_error("Unsupported model_id.")

    return {
        "width": width,
        "height": height,
        "steps": steps,
        "cfg": cfg,
        "seed": seed,
        "model_id": normalized_model_id,
        "sampler": sampler,
        "mode": mode,
        "style_preset": style_preset,
        "denoising_strength": denoising_strength,
        "mask_blur": mask_blur,
        "mask_padding": mask_padding,
    }

# --- Endpoints ---

class CancelGenerationRequest(BaseModel):
    request_id: str

@app.post("/cancel")
def cancel_generation(payload: CancelGenerationRequest):
    if not payload.request_id.strip():
        raise HTTPException(status_code=400, detail="request_id is required")

    model_manager.request_cancel(payload.request_id)
    return {"status": "cancelling", "request_id": payload.request_id}

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.get("/")
def read_root():
    return {"message": "AI Image Gen API is running. Visit /docs for Swagger UI."}

@app.get("/models")
def list_models():
    return {"models": ALLOWED_CLOUD_MODELS + _get_local_model_entries()}


#_____________апдейт_______ Prompt transformer preview contract
class PromptTransformPreviewRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    use_prompt_transform: Optional[bool] = None


#_____________апдейт_______ Prompt transformer preview endpoint
@app.post("/prompt/transform")
async def preview_prompt_transform(payload: PromptTransformPreviewRequest):
    result = await prompt_transformer.transform_prompt(
        raw_prompt=payload.prompt,
        use_prompt_transform=payload.use_prompt_transform,
        context={"user_negative_prompt": payload.negative_prompt or ""},
    )
    #_____________апдейт_______ Strict validation for preview endpoint
    transform_required = settings.PROMPT_TRANSFORM_ENABLED if payload.use_prompt_transform is None else payload.use_prompt_transform
    if transform_required and settings.PROMPT_TRANSFORM_STRICT and result.transform_status != "success":
        raise HTTPException(
            status_code=422,
            detail=f"Prompt was not transformed. status={result.transform_status}",
        )
    return {"status": "success", "data": result.to_dict()}


#_____________апдейт_______ Prompt transformer health endpoint
@app.get("/prompt/health")
def prompt_transform_health():
    return {"status": "success", "data": prompt_transformer.health()}


@app.post("/generate")
async def generate_image(
    prompt: str = Form(...),
    request_id: Optional[str] = Form(default=None),
    raw_prompt: Optional[str] = Form(default=None),
    use_prompt_transform: Optional[bool] = Form(default=None),
    negative_prompt: str = Form(default="low quality, bad anatomy, ugly"),
    width: int = Form(default=512),
    height: int = Form(default=512),
    steps: int = Form(default=20),
    cfg: float = Form(default=7.5),
    seed: int = Form(default=-1),
    model_id: str = Form(default=settings.DEFAULT_MODEL_ID),
    sampler: str = Form(default="Euler a"),
    mode: str = Form(default="auto"), # auto, txt2img, img2img, inpainting
    style_preset: Optional[str] = Form(None),
    denoising_strength: float = Form(default=0.75),
    mask_blur: int = Form(default=4),
    mask_padding: int = Form(default=32),
    init_image: UploadFile = File(None),
    mask_image: UploadFile = File(None),
):
    try:
        request_id = (request_id or "").strip() or uuid.uuid4().hex
        validated = _validate_generation_inputs(
            width=width,
            height=height,
            steps=steps,
            cfg=cfg,
            seed=seed,
            model_id=model_id,
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
        sampler = validated["sampler"]
        mode = validated["mode"]
        style_preset = validated["style_preset"]
        denoising_strength = validated["denoising_strength"]
        mask_blur = validated["mask_blur"]
        mask_padding = validated["mask_padding"]

        #_____________апдейт_______ Prompt transform pipeline (raw user text -> SD prompt)
        source_prompt = raw_prompt.strip() if raw_prompt and raw_prompt.strip() else prompt
        transform_result = await prompt_transformer.transform_prompt(
            raw_prompt=source_prompt,
            use_prompt_transform=use_prompt_transform,
            context={
                "mode": mode,
                "model_id": model_id,
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

        # 0. Apply Preset
        if style_preset:
            final_prompt = f"{final_prompt}, {STYLE_PRESETS[style_preset]}"
             
        # Detect Mode & Process Inputs Early
        
        image_input = None
        hard_mask_input = None
        soft_mask_input = None
        has_transparency = False
        outpaint_ready_image = None
        outpaint_hard_mask = None
        outpaint_soft_mask = None
        
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
            # WebUI/Invoke style inpaint mask controls.
            hard_mask, soft_mask = process_mask_for_inpainting(
                raw_mask,
                mask_padding=mask_padding,
                mask_blur=mask_blur
            )
            hard_mask_input = hard_mask.resize((width, height))
            soft_mask_input = soft_mask.resize((width, height))

        # Prepare outpaint context whenever transparency exists.
        if image_input and has_transparency:
            outpaint_ready_image, outpaint_hard_mask, outpaint_soft_mask = prepare_image_for_outpainting(
                image_input,
                mask_padding=mask_padding,
                mask_blur=mask_blur
            )

        # 1. Determine Actual Mode & Prepare for Outpainting
        actual_mode = mode
        
        if mode == "auto":
             if hard_mask_input:
                 actual_mode = "inpainting"
             elif image_input:
                 if has_transparency:
                     actual_mode = "inpainting"
                     logger.info("Auto-detected Transparency -> Outpainting Mode")
                 else:
                     actual_mode = "img2img"
             else:
                 actual_mode = "text2img"

        # 2. Load Model
        pipeline_type = actual_mode
        if actual_mode not in ["text2img", "img2img", "inpainting", "controlnet"]:
            pipeline_type = "text2img" # fallback

        if model_manager.is_cancel_requested(request_id):
            raise HTTPException(status_code=499, detail="Generation was cancelled by user.")
            
        async with model_manager.generation_session(request_id):
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

            pipe = await model_manager.get_model(
                model_id,
                pipeline_type=pipeline_type,
                sampler_name=sampler
            )
            model_manager.bind_active_pipeline(request_id, pipe)
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

            if seed == -1:
                seed = random.randint(0, 2**32 - 1)

            generator = torch.Generator(device=model_manager.device).manual_seed(seed)

            result_image = None

            logger.info(
                "Starting Generation: request_id=%s Mode=%s Size=%sx%s Seed=%s",
                request_id,
                actual_mode,
                width,
                height,
                seed,
            )

            def step_callback(pipeline, step_index, timestep, callback_kwargs):
                if model_manager.is_cancel_requested(request_id):
                    logger.info("Interrupting pipeline request_id=%s at step %s", request_id, step_index)
                    pipeline._interrupt = True
                return callback_kwargs

            # 4. Generate
            if actual_mode == "text2img":
                result = await asyncio.to_thread(
                    pipe,
                    prompt=final_prompt,
                    negative_prompt=final_negative_prompt,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    generator=generator,
                    callback_on_step_end=step_callback
                )
                result_image = result.images[0]

            elif actual_mode == "img2img":
                if not image_input:
                    raise HTTPException(status_code=400, detail="Img2Img requires init_image")
                if image_input.mode == "RGBA":
                    image_input = image_input.convert("RGB")

                result = await asyncio.to_thread(
                    pipe,
                    prompt=final_prompt,
                    negative_prompt=final_negative_prompt,
                    image=image_input,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    strength=denoising_strength,
                    generator=generator,
                    callback_on_step_end=step_callback
                )
                result_image = result.images[0]

            elif actual_mode == "inpainting":
                if image_input is None:
                    image_input = Image.new("RGB", (width, height), (0, 0, 0))

                if has_transparency and outpaint_ready_image is not None:
                    image_input = outpaint_ready_image
                    hard_mask_input, soft_mask_input = merge_generation_masks(
                        hard_mask_input,
                        soft_mask_input,
                        outpaint_hard_mask,
                        outpaint_soft_mask,
                    )
                    # Outpainting needs strong rewrite in transparent areas.
                    denoising_strength = max(denoising_strength, 0.95)
                elif image_input.mode == "RGBA":
                    image_input = image_input.convert("RGB")

                if hard_mask_input is None:
                    raise HTTPException(status_code=400, detail="Inpainting requires mask_image or transparent init_image")

                result = await asyncio.to_thread(
                    pipe,
                    prompt=final_prompt,
                    negative_prompt=final_negative_prompt,
                    image=image_input,
                    mask_image=hard_mask_input,
                    width=width,
                    height=height,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    strength=denoising_strength,
                    generator=generator,
                    callback_on_step_end=step_callback
                )
                result_image = result.images[0]

                # COMPOSITING
                # Essential for "Inpainting" to preserve unmasked pixels bit-perfectly.
                # Essential for "Outpainting" to keep the original context sharp (not VAE-reconstructed).
                if image_input and soft_mask_input:
                    if result_image.size == image_input.size == soft_mask_input.size:
                        # Use new feather_blend logic for seamless edges
                        result_image = feather_blend(
                            image_input,
                            result_image,
                            soft_mask_input,
                            hard_mask=hard_mask_input
                        )

            # 4.5 Check for cancellation
            if model_manager.is_cancel_requested(request_id):
                raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

        # 5. Save & Return
        if result_image:
            # Metadata dict
            meta = {
                "prompt": final_prompt,
                "negative_prompt": final_negative_prompt,
                "raw_negative_prompt": negative_prompt,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "model_id": model_id,
                "mode": actual_mode,
                #_____________апдейт_______ Prompt transformation trace
                "raw_prompt": transform_result.raw_prompt,
                "transformed_prompt": transform_result.transformed_prompt,
                "transformed_negative_prompt": transform_result.transformed_negative_prompt,
                "prompt_transform_status": transform_result.transform_status,
                "prompt_transform_provider": transform_result.provider,
                "prompt_transform_latency_ms": transform_result.latency_ms,
                "prompt_transform_strict": settings.PROMPT_TRANSFORM_STRICT,
            }
            #_____________апдейт_______ Keep error details only when fallback happened
            if transform_result.error:
                meta["prompt_transform_error"] = transform_result.error
            
            filename = save_image_with_metadata(result_image, meta, str(settings.OUTPUT_DIR))
            return {
                "status": "success",
                "url": f"/outputs/{filename}",
                "request_id": request_id,
                "meta": meta
            }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generation failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upscale")
async def upscale_image(
    image: UploadFile = File(...),
    scale_factor: float = Form(default=2.0)
):
    """
    Architecture placeholder for Upscaling.
    Currently implements a simple resize, but ready for SwinIR/RealESRGAN integration.
    """
    try:
        content = await image.read()
        pil_image = Image.open(io.BytesIO(content)).convert("RGB")
        
        # Placeholder implementation: Bicubic resize
        new_width = int(pil_image.width * scale_factor)
        new_height = int(pil_image.height * scale_factor)
        upscaled = pil_image.resize((new_width, new_height), Image.BICUBIC)
        
        filename = save_image_with_metadata(upscaled, {"upscale": scale_factor}, str(settings.OUTPUT_DIR))
        return {"status": "success", "url": f"/outputs/{filename}"}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upscale failed: {e}")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
