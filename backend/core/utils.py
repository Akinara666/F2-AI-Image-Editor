import os
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

def _odd_kernel_size(radius_px: int) -> int:
    return max(3, radius_px * 2 + 1)

def _combine_masks_max(mask_a: Image.Image | None, mask_b: Image.Image | None) -> Image.Image | None:
    if mask_a is None:
        return mask_b
    if mask_b is None:
        return mask_a

    a = np.array(mask_a.convert("L"), dtype=np.uint8)
    b = np.array(mask_b.convert("L"), dtype=np.uint8)
    return Image.fromarray(np.maximum(a, b), mode="L")

def process_mask_for_inpainting(
    mask_image: Image.Image,
    mask_padding: int = 32,
    mask_blur: int = 4,
    threshold: int = 127
) -> tuple[Image.Image, Image.Image]:
    """
    WebUI/Invoke-style mask processing:
    1. Binary inpaint mask.
    2. Optional padding (dilation) around mask.
    3. Separate blurred blend mask for final compositing.
    """
    if mask_image.mode != "L":
        mask_image = mask_image.convert("L")

    mask_arr = np.array(mask_image, dtype=np.uint8)
    hard_mask = Image.fromarray(np.where(mask_arr >= threshold, 255, 0).astype(np.uint8), mode="L")

    if mask_padding > 0:
        hard_mask = hard_mask.filter(ImageFilter.MaxFilter(_odd_kernel_size(mask_padding)))
        
    soft_mask = hard_mask
    if mask_blur > 0:
        soft_mask = hard_mask.filter(ImageFilter.GaussianBlur(radius=mask_blur))
        
    return hard_mask, soft_mask

def feather_blend(
    original_image: Image.Image,
    generated_image: Image.Image,
    soft_mask: Image.Image,
    hard_mask: Image.Image | None = None
) -> Image.Image:
    """
    Blends the generated image back into the original image using the soft mask as an alpha channel.
    This creates a seamless transition between AI pixels and original pixels.
    """
    if original_image.size != generated_image.size or original_image.size != soft_mask.size:
        return generated_image # Fallback if sizes mismatch somehow
        
    orig = np.array(original_image.convert("RGB"), dtype=np.float32)
    gen = np.array(generated_image.convert("RGB"), dtype=np.float32)
    alpha = np.array(soft_mask.convert("L"), dtype=np.float32) / 255.0
    if hard_mask is not None:
        hard_alpha = (np.array(hard_mask.convert("L"), dtype=np.float32) >= 127.0).astype(np.float32)
        alpha = np.maximum(alpha, hard_alpha * 0.98)

    alpha_3 = alpha[..., None]

    blended = (orig * (1.0 - alpha_3)) + (gen * alpha_3)
    return Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8), mode="RGB")

def merge_generation_masks(
    manual_hard_mask: Image.Image | None,
    manual_soft_mask: Image.Image | None,
    outpaint_hard_mask: Image.Image | None,
    outpaint_soft_mask: Image.Image | None,
) -> tuple[Image.Image | None, Image.Image | None]:
    """
    Combines user mask and transparency-derived outpainting mask.
    """
    return (
        _combine_masks_max(manual_hard_mask, outpaint_hard_mask),
        _combine_masks_max(manual_soft_mask, outpaint_soft_mask),
    )

def prepare_image_for_outpainting(
    image: Image.Image,
    mask_padding: int = 32,
    mask_blur: int = 4,
) -> tuple[Image.Image, Image.Image, Image.Image]:
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
    small_w = max(1, image.width // 8)
    small_h = max(1, image.height // 8)
    small = image.resize((small_w, small_h), resample=Image.BICUBIC)
    bg_filled = small.resize(image.size, resample=Image.BICUBIC).convert("RGB")
    
    # 3. Add Noise to Background (Texture seeding)
    # Convert to numpy to add noise efficienty. Use int32 to prevent uint8 overflow (which causes glitchy colors)
    bg_arr = np.array(bg_filled).astype(np.int32)
    noise = np.random.randint(-15, 15, (bg_arr.shape[0], bg_arr.shape[1], 3), dtype=np.int32)
    bg_arr = np.clip(bg_arr + noise, 0, 255).astype(np.uint8)
    bg_filled = Image.fromarray(bg_arr)
    
    # 4. Composite: Original Content ON TOP of Infill Background
    # We use the original alpha as the mask for pasting
    final_image = bg_filled.copy()
    final_image.paste(image, mask=alpha)
    
    # 5. Process Mask (Feathering)
    hard_mask, soft_mask = process_mask_for_inpainting(
        mask,
        mask_padding=mask_padding,
        mask_blur=mask_blur
    )
    
    return final_image, hard_mask, soft_mask
