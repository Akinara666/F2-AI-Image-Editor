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

def process_mask_for_inpainting(mask_image: Image.Image, blur_radius: int = 4) -> Image.Image:
    """
    Prepares the mask for inpainting:
    1. Ensures it is strictly 'L' mode (grayscale).
    2. Applies Gaussian Blur to soften edges and prevent seams.
    """
    # Ensure mask is grayscale
    if mask_image.mode != "L":
        mask_image = mask_image.convert("L")
    
    # Apply Blur
    if blur_radius > 0:
        mask_image = mask_image.filter(ImageFilter.GaussianBlur(radius=blur_radius))
        
    return mask_image

def prepare_image_for_outpainting(image: Image.Image) -> tuple[Image.Image, Image.Image]:
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
    # We blur the mask slightly so the transition isn't pixel-perfect sharp
    # Use existing helper
    processed_mask = process_mask_for_inpainting(mask, blur_radius=8)
    
    return final_image, processed_mask
