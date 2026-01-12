import os
import io
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
