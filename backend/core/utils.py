import os
import re
import numpy as np
from PIL import Image, PngImagePlugin, ImageFilter
from datetime import datetime
from uuid import uuid4

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
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    # Use prompt snippet for filename if available. Whitelist characters so the
    # prompt can never inject path separators or break the /outputs URL.
    prompt_slug = re.sub(r"[^\w-]+", "_", (params.get("prompt") or "gen")[:20]).strip("_")
    if not prompt_slug:
        prompt_slug = "gen"
    filename = f"{timestamp}_{prompt_slug}_{uuid4().hex[:8]}.png"
    filepath = os.path.join(output_dir, filename)

    image.save(filepath, "PNG", pnginfo=meta)
    return filename

def _odd_kernel_size(radius_px: int) -> int:
    return max(3, radius_px * 2 + 1)


def _binarize_mask(mask_image: Image.Image, threshold: int) -> Image.Image:
    mask_arr = np.array(mask_image.convert("L"), dtype=np.uint8)
    return Image.fromarray(np.where(mask_arr >= threshold, 255, 0).astype(np.uint8), mode="L")

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
    Prepare two masks for inpainting:
    1. A binary generation mask for the diffusion pipeline.
    2. A soft blend mask for post-compositing on top of the untouched source image.

    Diffusers inpaint pipelines binarize `mask_image` internally, so passing a blurred mask
    directly into the pipeline does not preserve feathered edges. To make `mask_blur`
    meaningful, we keep a binary generation mask for the pipeline and create a separate
    blurred blend mask for the final composite.
    """
    if mask_image.mode != "L":
        mask_image = mask_image.convert("L")

    base_mask = _binarize_mask(mask_image, threshold)

    if mask_padding > 0:
        base_mask = base_mask.filter(ImageFilter.MaxFilter(_odd_kernel_size(mask_padding)))

    generation_mask = base_mask
    # Approximate A1111-style "blur expands the rewritten area a bit" behavior even though
    # diffusers will still binarize the mask internally.
    blur_growth_radius = max(0, round(mask_blur / 2))
    if blur_growth_radius > 0:
        generation_mask = generation_mask.filter(ImageFilter.MaxFilter(_odd_kernel_size(blur_growth_radius)))

    blend_mask = base_mask
    if mask_blur > 0:
        blend_mask = base_mask.filter(ImageFilter.GaussianBlur(radius=mask_blur))

    # Keep the original masked region fully opaque in the final composite.
    blend_mask = _combine_masks_max(blend_mask, base_mask)

    return generation_mask, blend_mask

def feather_blend(
    original_image: Image.Image,
    generated_image: Image.Image,
    blend_mask: Image.Image,
    generation_mask: Image.Image | None = None,
) -> Image.Image:
    """
    Blend the generated image back into the untouched source image.

    `blend_mask` controls the feathered transition near the border.
    `generation_mask`, when present, keeps the original edited region fully generated.
    """
    if original_image.size != generated_image.size or original_image.size != blend_mask.size:
        return generated_image # Fallback if sizes mismatch somehow
        
    orig = np.array(original_image.convert("RGB"), dtype=np.float32)
    gen = np.array(generated_image.convert("RGB"), dtype=np.float32)
    alpha = np.array(blend_mask.convert("L"), dtype=np.float32) / 255.0
    if generation_mask is not None and generation_mask.size == blend_mask.size:
        generation_alpha = np.array(generation_mask.convert("L"), dtype=np.float32) / 255.0
        alpha = np.maximum(alpha, generation_alpha)
    alpha_3 = alpha[..., None]

    blended = (orig * (1.0 - alpha_3)) + (gen * alpha_3)
    return Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8), mode="RGB")

def merge_generation_masks(
    manual_generation_mask: Image.Image | None,
    manual_blend_mask: Image.Image | None,
    outpaint_generation_mask: Image.Image | None,
    outpaint_blend_mask: Image.Image | None,
) -> tuple[Image.Image | None, Image.Image | None]:
    """
    Combines user mask and transparency-derived outpainting mask.
    """
    return (
        _combine_masks_max(manual_generation_mask, outpaint_generation_mask),
        _combine_masks_max(manual_blend_mask, outpaint_blend_mask),
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
    generation_mask, blend_mask = process_mask_for_inpainting(
        mask,
        mask_padding=mask_padding,
        mask_blur=mask_blur
    )
    
    return final_image, generation_mask, blend_mask
