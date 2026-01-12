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
STYLE_PRESETS = {
    "Cinematic": "cinematic shot, dynamic lighting, 8k resolution, highly detailed, shallow depth of field, bokeh",
    "Anime": "masterpiece, anime style, key visual, vibrant colors, studio ghibli style",
    "Digital Art": "concept art, digital painting, smooth, sharp focus, artstation",
    "Photographic": "raw photo, realistic, 8k, dslr, soft lighting"
}

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
             
        # 1. Determine Actual Mode (Smart Logic)
        actual_mode = mode
        if mode == "auto":
             if mask_image:
                 actual_mode = "inpainting"
             elif init_image and denoising_strength < 1.0:
                 actual_mode = "img2img"
             else:
                 actual_mode = "text2img"
        
        # 2. Load Model
        # Map mode to internal pipeline type
        pipeline_type = actual_mode
        if actual_mode not in ["text2img", "img2img", "inpainting", "controlnet"]:
            pipeline_type = "text2img" # fallback
            
        pipe = await model_manager.get_model(model_id, pipeline_type=pipeline_type)

        if seed == -1:
            import random
            seed = random.randint(0, 2**32 - 1)
        
        generator = None # Will be torch.Generator inside logic if needed, usually passed to pipeline
        

        
        # 3. Process Inputs
        image_input = None
        mask_input = None
        
        if init_image:
            img_bytes = await init_image.read()
            image_input = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            # Resize if needed to match requested width/height or keep aspect ratio
            image_input = image_input.resize((width, height))
            
        if mask_image:
            mask_bytes = await mask_image.read()
            raw_mask = Image.open(io.BytesIO(mask_bytes))
            # Pre-process mask (Gaussian Blur for better blending)
            mask_input = process_mask_for_inpainting(raw_mask, blur_radius=4)
            mask_input = mask_input.resize((width, height))

        # 4. Generate
        import torch
        generator = torch.Generator(device=model_manager.device).manual_seed(seed)
        
        result_image = None
        
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
                 # Fallback if logic failed or logic says img2img but no file
                 raise HTTPException(status_code=400, detail="Img2Img requires init_image")
            
            # Ensure correct pipeline signature handling (some unified pipelines use 'image')
            result = pipe(
                prompt=final_prompt,
                negative_prompt=negative_prompt,
                image=image_input,
                num_inference_steps=steps,
                guidance_scale=cfg,
                strength=denoising_strength, # Key parameter for img2img
                generator=generator
            )
            result_image = result.images[0]

        elif actual_mode == "inpainting":
            if not (image_input and mask_input):
                 # Fallback
                 if image_input is None:
                     image_input = Image.new("RGB", (width, height), (0,0,0))
                
            result = pipe(
                prompt=final_prompt, # Use prompt with preset
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
            if image_input and mask_input:
                # Ensure sizes match
                if generated.size == image_input.size == mask_input.size:
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
                "model_id": model_id
            }
            
            filename = save_image_with_metadata(result_image, meta, "static/outputs")
            return {
                "status": "success",
                "url": f"/outputs/{filename}",
                "meta": meta
            }
            
    except Exception as e:
        import traceback
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
