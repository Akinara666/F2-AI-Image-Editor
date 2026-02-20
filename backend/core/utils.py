import os
import io
import numpy as np
from PIL import Image, PngImagePlugin, ImageFilter
from datetime import datetime

def save_image_with_metadata(image: Image.Image, params: dict, output_dir: str) -> str:
    """
    Saves the image with generation parameters in PNG metadata (tEXt chunk).
    Returns the filename.
    """
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # Convert parameters to string format for metadata
    meta = PngImagePlugin.PngInfo()
    for key, value in params.items():
        if value is not None:
            meta.add_text(str(key), str(value))
    
    # Generate filename
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    # Use prompt snippet for filename if available
    prompt_slug = params.get("prompt", "gen")[:20].replace(" ", "_").strip()
    filename = f"{timestamp}_{prompt_slug}.png"
    filepath = os.path.join(output_dir, filename)

    image.save(filepath, "PNG", pnginfo=meta)
    return filename

def process_mask_for_inpainting(mask_image: Image.Image, hard_blur: int = 4, soft_blur: int = 16) -> tuple[Image.Image, Image.Image]:
    """
    Prepares the mask for inpainting. Returns two masks:
    1. Hard Mask: For the SD diffusers pipeline (slight blur).
    2. Soft Mask: For the final alpha compositing to hide seams (heavy blur).
    """
    # Ensure mask is grayscale
    if mask_image.mode != "L":
        mask_image = mask_image.convert("L")
    
    hard_mask = mask_image
    if hard_blur > 0:
        hard_mask = mask_image.filter(ImageFilter.GaussianBlur(radius=hard_blur))
        
    soft_mask = mask_image
    if soft_blur > 0:
        soft_mask = mask_image.filter(ImageFilter.GaussianBlur(radius=soft_blur))
        
    return hard_mask, soft_mask

def feather_blend(original_image: Image.Image, generated_image: Image.Image, soft_mask: Image.Image) -> Image.Image:
    """
    Blends the generated image back into the original image using the soft mask as an alpha channel.
    This creates a seamless transition between AI pixels and original pixels.
    """
    if original_image.size != generated_image.size or original_image.size != soft_mask.size:
        return generated_image # Fallback if sizes mismatch somehow
        
    # Ensure they are RGBA to freely paste using alpha
    original_rgba = original_image.convert("RGBA")
    generated_rgba = generated_image.convert("RGBA")
    
    # The mask itself dicts where the generated image appears.
    # We paste the generated image ON TOP OF the original image, using the soft mask.
    blended = original_rgba.copy()
    blended.paste(generated_rgba, mask=soft_mask)
    
    # Return as RGB to avoid saving transparent PNGs by mistake
    return blended.convert("RGB")

def prepare_image_for_outpainting(image: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
    """
    Prepares an RGBA image for outpainting/inpainting.
    
    Strategy (Blur Fill + Noise):
    1. Detect void (Alpha=0). Create generation mask.
    2. Fill void with a blurred version of the original image + noise.
       This gives the model color context and texture to hallucinate from, 
       avoiding "black cliffs".
    
    Returns:
        (filled_rgb_image, mask_image)
    """
    # 1. Extract Alpha and Create Mask
    # Mask: 255 (White) = Void/Edit, 0 (Black) = Content/Keep
    if image.mode != 'RGBA':
        image = image.convert('RGBA')
        
    alpha = image.getchannel('A')
    # Invert alpha for mask: Transparent(0) -> Mask(255), Opaque(255) -> Keep(0)
    mask = Image.eval(alpha, lambda a: 255 if a < 255 else 0)
    
    # 2. Create Infill Background (Blur Fill)
    # Downscale and Upscale to create average color wash
    small = image.resize((image.width // 8, image.height // 8), resample=Image.BICUBIC)
    bg_filled = small.resize(image.size, resample=Image.BICUBIC).convert("RGB")
    
    # 3. Add Noise to Background (Texture seeding)
    # Convert to numpy to add noise efficienty
    bg_arr = np.array(bg_filled)
    noise = np.random.randint(0, 20, (bg_arr.shape[0], bg_arr.shape[1], 3), dtype=np.uint8)
    bg_arr = np.clip(bg_arr + noise, 0, 255).astype(np.uint8)
    bg_filled = Image.fromarray(bg_arr)
    
    # 4. Composite: Original Content ON TOP of Infill Background
    # We use the original alpha as the mask for pasting
    final_image = bg_filled.copy()
    final_image.paste(image, mask=alpha)
    
    # 5. Process Mask (Feathering)
    hard_mask, soft_mask = process_mask_for_inpainting(mask, hard_blur=4, soft_blur=24)
    
    return final_image, hard_mask, soft_mask
