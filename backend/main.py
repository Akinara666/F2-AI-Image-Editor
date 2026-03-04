from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
import os
from pydantic import BaseModel
from typing import Optional
import uvicorn
import io
import asyncio
from PIL import Image
import torch

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
import logging

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Local AI Gen Service", version="0.1.0")

# Mount static folder for outputs
app.mount("/outputs", StaticFiles(directory=str(settings.OUTPUT_DIR)), name="outputs")

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Global Error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc), "type": type(exc).__name__}
    )

# --- Schemas ---
class GenerationRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    seed: int = -1
    steps: int = 20
    cfg: float = 7.0
    width: int = 512
    height: int = 512
    model_id: str = settings.DEFAULT_MODEL_ID
    type: str = "text2img" # text2img, img2img, inpainting

# --- Presets & configuration ---
# Imports from core.config

# --- Global State ---
generation_state = {
    "cancel_requested": False
}

# --- Endpoints ---

@app.post("/cancel")
def cancel_generation():
    generation_state["cancel_requested"] = True
    logger.info("Cancellation requested by user.")
    return {"status": "cancelled"}

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.get("/")
def read_root():
    return {"message": "AI Image Gen API is running. Visit /docs for Swagger UI."}

@app.get("/models")
def list_models():
    # Base cloud models
    models = [
        {"id": "runwayml/stable-diffusion-v1-5", "label": "SD v1.5 Base (Cloud)"},
        {"id": "Lykon/DreamShaper", "label": "DreamShaper (Cloud)"},
        {"id": "prompthero/openjourney-v4", "label": "OpenJourney v4 (Cloud)"}
    ]
    
    # Scan local directory
    models_dir = settings.MODELS_DIR
    if models_dir.exists():
        try:
            for file in os.listdir(models_dir):
                if file.endswith(".safetensors") or file.endswith(".ckpt"):
                    abs_path = str(models_dir / file)
                    models.append({"id": abs_path, "label": f"{file} (Local)"})
        except Exception as e:
            logger.error(f"Failed to scan models directory: {e}")
                
    return {"models": models}


@app.post("/generate")
async def generate_image(
    prompt: str = Form(...),
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
        # Reset cancel state for new generation
        generation_state["cancel_requested"] = False

        # 0. Apply Preset
        final_prompt = prompt
        if style_preset and style_preset in STYLE_PRESETS:
             final_prompt = f"{prompt}, {STYLE_PRESETS[style_preset]}"
             
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
            
        def clamp_int(value: int, low: int, high: int) -> int:
            return max(low, min(high, int(value)))

        eff_mask_blur = clamp_int(mask_blur, 0, 64)
        eff_mask_padding = clamp_int(mask_padding, 0, 128)

        # Load Mask Image (Manual)
        if mask_image:
            mask_bytes = await mask_image.read()
            raw_mask = Image.open(io.BytesIO(mask_bytes))
            # WebUI/Invoke style inpaint mask controls.
            hard_mask, soft_mask = process_mask_for_inpainting(
                raw_mask,
                mask_padding=eff_mask_padding,
                mask_blur=eff_mask_blur
            )
            hard_mask_input = hard_mask.resize((width, height))
            soft_mask_input = soft_mask.resize((width, height))

        # Prepare outpaint context whenever transparency exists.
        if image_input and has_transparency:
            outpaint_ready_image, outpaint_hard_mask, outpaint_soft_mask = prepare_image_for_outpainting(
                image_input,
                mask_padding=eff_mask_padding,
                mask_blur=eff_mask_blur
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
            
        pipe = await model_manager.get_model(
            model_id, 
            pipeline_type=pipeline_type,
            sampler_name=sampler
        )

        if seed == -1:
            import random
            seed = random.randint(0, 2**32 - 1)
        
        generator = torch.Generator(device=model_manager.device).manual_seed(seed)
        
        result_image = None
        
        logger.info(f"Starting Generation: Mode={actual_mode}, Size={width}x{height}, Seed={seed}")

        def step_callback(pipeline, step_index, timestep, callback_kwargs):
            if generation_state.get("cancel_requested", False):
                logger.info(f"Interrupting pipeline at step {step_index}...")
                pipeline._interrupt = True
            return callback_kwargs

        # 4. Generate
        if actual_mode == "text2img":
            result = await asyncio.to_thread(
                pipe,
                prompt=final_prompt,
                negative_prompt=negative_prompt,
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
                negative_prompt=negative_prompt,
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
                negative_prompt=negative_prompt,
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
        if generation_state.get("cancel_requested", False):
            raise HTTPException(status_code=499, detail="Generation was cancelled by user.")

        # 5. Save & Return
        if result_image:
            # Metadata dict
            meta = {
                "prompt": final_prompt,
                "negative_prompt": negative_prompt,
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "model_id": model_id,
                "mode": actual_mode 
            }
            
            filename = save_image_with_metadata(result_image, meta, str(settings.OUTPUT_DIR))
            return {
                "status": "success",
                "url": f"/outputs/{filename}",
                "meta": meta
            }
            
    except HTTPException:
        raise
    except Exception as e:
        import traceback
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
