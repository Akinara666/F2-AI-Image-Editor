from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
import uvicorn
import io
import json
import base64
from PIL import Image

# Import core modules
from core.manager import model_manager
from core.utils import save_image_with_metadata, process_mask_for_inpainting
from core.config import STYLE_PRESETS
import logging

# Setup Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Local AI Gen Service", version="0.1.0")

# Mount static folder for outputs
app.mount("/outputs", StaticFiles(directory="static/outputs"), name="outputs")

# --- Schemas ---
class GenerationRequest(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = None
    seed: int = -1
    steps: int = 20
    cfg: float = 7.0
    width: int = 512
    height: int = 512
    model_id: str = "runwayml/stable-diffusion-v1-5"
    type: str = "text2img" # text2img, img2img, inpainting

# --- Presets & configuration ---
# Imports from core.config

# --- Endpoints ---

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.get("/")
def read_root():
    return {"message": "AI Image Gen API is running. Visit /docs for Swagger UI."}



@app.post("/generate")
async def generate_image(
    prompt: str = Form(...),
    negative_prompt: str = Form(default="low quality, bad anatomy, ugly"),
    width: int = Form(default=512),
    height: int = Form(default=512),
    steps: int = Form(default=20),
    cfg: float = Form(default=7.5),
    seed: int = Form(default=-1),
    model_id: str = Form(default="runwayml/stable-diffusion-v1-5"),
    mode: str = Form(default="auto"), # auto, txt2img, img2img, inpainting
    style_preset: Optional[str] = Form(None),
    denoising_strength: float = Form(default=0.75),
    init_image: UploadFile = File(None),
    mask_image: UploadFile = File(None),
):
    try:
        # 0. Apply Preset
        final_prompt = prompt
        if style_preset and style_preset in STYLE_PRESETS:
             final_prompt = f"{prompt}, {STYLE_PRESETS[style_preset]}"
             
        # Detect Mode & Process Inputs Early
        # We need to read images to know if there is an alpha channel for auto-outpainting
        
        image_input = None
        mask_input = None
        
        # Load Init Image
        if init_image:
            img_bytes = await init_image.read()
            # Open as RGBA to preserve transparency
            image_input = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
            # Resize
            image_input = image_input.resize((width, height))
            
        # Load Mask Image
        if mask_image:
            mask_bytes = await mask_image.read()
            raw_mask = Image.open(io.BytesIO(mask_bytes))
            # Pre-process mask (Gaussian Blur for better blending)
            mask_input = process_mask_for_inpainting(raw_mask, blur_radius=4)
            mask_input = mask_input.resize((width, height))

        # 1. Determine Actual Mode (Smart Logic)
        actual_mode = mode
        
        # Auto-detect Outpainting context (Alpha channel transparency)
        # If no manual mask is provided, but init image has transparency, treat as Outpainting
        if mode == "auto":
             if mask_input:
                 actual_mode = "inpainting"
             elif image_input and denoising_strength < 1.0:
                 # Check for transparency
                 has_transparency = False
                 if image_input.mode == 'RGBA':
                     # Simple check: if min alpha < 255
                     alpha = image_input.getchannel('A')
                     if alpha.getextrema()[0] < 255:
                         has_transparency = True
                 
                 if has_transparency:
                     actual_mode = "inpainting"
                     logger.info("Auto-detected Transparency -> Switching to Inpainting/Outpainting mode")
                     
                     # Force high denoising strength for Outpainting to avoid "black void" retention
                     # The model needs to hallucinate fully in the empty space.
                     denoising_strength = 1.0
                     
                     # GENERATE MASK FROM ALPHA
                     # Alpha: 0 (Transparent) -> Mask: 255 (White/Edit)
                     # Alpha: 255 (Opaque) -> Mask: 0 (Black/Keep)
                     alpha = image_input.getchannel('A')
                     mask_from_alpha = Image.eval(alpha, lambda a: 255 if a < 255 else 0)
                     mask_input = process_mask_for_inpainting(mask_from_alpha, blur_radius=4)
                     
                     # Composite image_input onto black for the model (remove alpha)
                     bg = Image.new("RGB", image_input.size, (0, 0, 0))
                     bg.paste(image_input, mask=image_input.split()[3]) # Paste using alpha
                     image_input = bg
                 else:
                     actual_mode = "img2img"
                     image_input = image_input.convert("RGB") # Drop alpha if opaque
             else:
                 actual_mode = "text2img"

        # Ensure image_input is RGB for pipeline if not handled above
        if image_input and image_input.mode == 'RGBA':
             image_input = image_input.convert("RGB")

        # 2. Load Model
        pipeline_type = actual_mode
        if actual_mode not in ["text2img", "img2img", "inpainting", "controlnet"]:
            pipeline_type = "text2img" # fallback
            
        pipe = await model_manager.get_model(model_id, pipeline_type=pipeline_type)

        if seed == -1:
            import random
            seed = random.randint(0, 2**32 - 1)
        
        generator = None 

        # 4. Generate
        import torch
        generator = torch.Generator(device=model_manager.device).manual_seed(seed)
        
        result_image = None
        
        logger.info(f"Starting Generation: Mode={actual_mode}, Size={width}x{height}, Seed={seed}")

        if actual_mode == "text2img":
            result = pipe(
                prompt=final_prompt,
                negative_prompt=negative_prompt,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=cfg,
                generator=generator
            )
            result_image = result.images[0]
            
        elif actual_mode == "img2img":
            if not image_input:
                 raise HTTPException(status_code=400, detail="Img2Img requires init_image")
            
            result = pipe(
                prompt=final_prompt,
                negative_prompt=negative_prompt,
                image=image_input,
                num_inference_steps=steps,
                guidance_scale=cfg,
                strength=denoising_strength,
                generator=generator
            )
            result_image = result.images[0]

        elif actual_mode == "inpainting":
            if not (image_input and mask_input):
                 if image_input is None:
                     image_input = Image.new("RGB", (width, height), (0,0,0))
                
            result = pipe(
                prompt=final_prompt,
                negative_prompt=negative_prompt,
                image=image_input,
                mask_image=mask_input,
                width=width,
                height=height,
                num_inference_steps=steps,
                guidance_scale=cfg,
                strength=denoising_strength,
                generator=generator
            )
            generated = result.images[0]
            
            # COMPOSITING: Paste generated content back onto original using the mask
            # For outpainting, specifically handle the artifact issue
            if image_input and mask_input:
                 # Standard Inpainting match
                 if generated.size == image_input.size == mask_input.size:
                     if mode == "auto" and has_transparency:
                         # SPECIAL OUTPAINTING COMPOSITE
                         # Fix: Use ERODED original alpha to blend strictly INSIDE the valid content.
                         
                         # 1. Recover original Alpha (Content=255, Void=0)
                         
                         # We need to Composite: Original (Top) over Generated (Bottom).
                         # Mask: Defines where Original is visible.
                         
                         from PIL import ImageFilter
                         # Erode alpha: Shrink white area (Content) to ensure edges don't touch black void
                         # MinFilter(3) shrinks white regions by radius 1-2.
                         eroded_alpha = alpha.filter(ImageFilter.MinFilter(3)) # Erode
                         blurred_alpha = eroded_alpha.filter(ImageFilter.GaussianBlur(2)) # Soften
                         
                         # Composite(Top, Bottom, Mask) -> Mask=255 shows Top.
                         result_image = Image.composite(image_input, generated, blurred_alpha)
                     else:
                         # Standard Inpainting (User mask)
                         # mask_input is White for Edit (Generate).
                         # Composite(Generatd, Original, Mask).
                         result_image = Image.composite(generated, image_input, mask_input)
                 else:
                     result_image = generated
            else:
                result_image = generated


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
            
            filename = save_image_with_metadata(result_image, meta, "static/outputs")
            return {
                "status": "success",
                "url": f"/outputs/{filename}",
                "meta": meta
            }
            
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
        
        filename = save_image_with_metadata(upscaled, {"upscale": scale_factor}, "static/outputs")
        return {"status": "success", "url": f"/outputs/{filename}"}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upscale failed: {e}")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
