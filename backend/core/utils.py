import io
import os
import re
import numpy as np
from PIL import Image, PngImagePlugin, ImageFilter
from datetime import datetime
from uuid import uuid4

from core.config import settings


def _prune_old_outputs(output_dir: str, max_files: int) -> None:
    """Keep at most ``max_files`` newest PNGs in ``output_dir`` (cleanup policy)."""
    if max_files <= 0:
        return
    try:
        entries = [
            entry for entry in os.scandir(output_dir)
            if entry.is_file() and entry.name.lower().endswith(".png")
        ]
        if len(entries) <= max_files:
            return
        entries.sort(key=lambda entry: entry.stat().st_mtime)
        for entry in entries[: len(entries) - max_files]:
            try:
                os.remove(entry.path)
            except OSError:
                pass
    except OSError:
        pass


def _build_png_metadata(params: dict) -> PngImagePlugin.PngInfo:
    meta = PngImagePlugin.PngInfo()
    for key, value in params.items():
        if value is not None:
            meta.add_text(str(key), str(value))
    return meta


def _build_output_filename(params: dict) -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    # Use prompt snippet for filename if available. Whitelist characters so the
    # prompt can never inject path separators or break the /outputs URL.
    prompt_slug = re.sub(r"[^\w-]+", "_", (params.get("prompt") or "gen")[:20]).strip("_")
    if not prompt_slug:
        prompt_slug = "gen"
    return f"{timestamp}_{prompt_slug}_{uuid4().hex[:8]}.png"


def encode_image_with_metadata(image: Image.Image, params: dict) -> tuple[bytes, str]:
    """Encode ``image`` to PNG bytes (params in a tEXt chunk) and pick a filename.

    Uses ``compress_level=1``: PNG's default level 6 is markedly slower on large
    images and sits on the generation request's critical path (the
    ``preview -> sharp`` transition), while the file-size difference is minor.
    Returns ``(png_bytes, filename)``; the caller decides when/where to persist
    (e.g. via a FastAPI BackgroundTask, off the response path).
    """
    meta = _build_png_metadata(params)
    filename = _build_output_filename(params)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", pnginfo=meta, compress_level=1)
    return buffer.getvalue(), filename


def encode_webp(image: Image.Image, quality: int = 90) -> bytes:
    """Encode to WebP for fast on-screen delivery over slow links (e.g. tunnels).

    A 1024² PNG is ~1.8–2.5 MB; the same image as WebP q90 is ~0.4–0.6 MB, so the
    candidate crosses the tunnel ~4–5× faster. WebP keeps an alpha plane, so the
    lossy mode does not break transparency-dependent paths. The lossless PNG is
    still persisted to disk separately for history/accept fidelity.
    """
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=quality, method=4)
    return buffer.getvalue()


def encode_result_for_delivery(
    image: Image.Image, params: dict, webp_quality: int = 90
) -> tuple[bytes, bytes, str]:
    """One pass: lossless PNG (for disk) + compact WebP (for the inline response).

    Returns ``(png_bytes, webp_bytes, filename)``.
    """
    png_bytes, filename = encode_image_with_metadata(image, params)
    webp_bytes = encode_webp(image, webp_quality)
    return png_bytes, webp_bytes, filename


def write_output_bytes(data: bytes, filename: str, output_dir: str) -> str:
    """Persist pre-encoded image bytes and apply the cleanup policy.

    Safe to run off the request path (e.g. FastAPI BackgroundTasks), so neither
    the disk write nor the directory prune block the generation response.
    """
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "wb") as output_file:
        output_file.write(data)
    _prune_old_outputs(output_dir, settings.MAX_STORED_IMAGES)
    return filename


def save_image_with_metadata(image: Image.Image, params: dict, output_dir: str) -> str:
    """Encode + persist in one synchronous call. Returns the filename.

    Kept for callers that are not on the latency-critical generation path
    (history snapshots, tool edits, upscale).
    """
    data, filename = encode_image_with_metadata(image, params)
    return write_output_bytes(data, filename, output_dir)

def _dilate_mask(mask: Image.Image, radius: int) -> Image.Image:
    """Square dilation by ``radius`` (equivalent to ``MaxFilter(2*radius+1)``).

    PIL's ``MaxFilter`` is a rank filter, ``O(width * height * kernel^2)``: at the
    ``mask_blur`` ceiling (128 -> kernel 257 on a 1024x1024 mask) it ran for ~60s
    and, being synchronous, froze the whole event loop before generation even
    started. A square max-filter is separable, so we do two O(n) 1-D running maxes
    (horizontal then vertical) via strided windows — ~0.04s for the same case,
    bit-identical to ``MaxFilter``.
    """
    if radius <= 0:
        return mask
    arr = np.asarray(mask.convert("L"), dtype=np.uint8)
    kernel = 2 * radius + 1
    padded = np.pad(arr, radius, mode="edge")
    horizontal = np.lib.stride_tricks.sliding_window_view(padded, kernel, axis=1).max(axis=2)
    dilated = np.lib.stride_tricks.sliding_window_view(horizontal, kernel, axis=0).max(axis=2)
    return Image.fromarray(dilated, mode="L")


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
        base_mask = _dilate_mask(base_mask, mask_padding)

    generation_mask = base_mask
    # Approximate A1111-style "blur expands the rewritten area a bit" behavior even though
    # diffusers will still binarize the mask internally.
    blur_growth_radius = max(0, round(mask_blur / 2))
    if blur_growth_radius > 0:
        generation_mask = _dilate_mask(generation_mask, blur_growth_radius)

    # Soft blend mask for the final composite. We dilate the mask by mask_blur
    # and THEN Gaussian-blur it: the dilation shifts the ramp outward so the
    # interior stays a smooth 1.0 without a hard "core". The earlier approach
    # (max of the blur with an *eroded* core) left a visible step where the solid
    # core met the Gaussian tail (~45/255 jump) — exactly the harsh transition
    # between the solid and feathered parts of the mask. Dilate→blur removes it.
    blend_mask = base_mask
    if mask_blur > 0:
        blend_mask = _dilate_mask(base_mask, mask_blur)
        blend_mask = blend_mask.filter(ImageFilter.GaussianBlur(radius=mask_blur))

    return generation_mask, blend_mask

def feather_blend(
    original_image: Image.Image,
    generated_image: Image.Image,
    blend_mask: Image.Image,
) -> Image.Image:
    """
    Blend the generated image back into the untouched source image.

    `blend_mask` is a soft alpha (255 = fully generated, 0 = keep original) that
    already feathers across the mask boundary and stays fully opaque on the
    interior core (see ``process_mask_for_inpainting``). Driving the composite
    from it alone keeps the unmasked area bit-exact while the transition stays
    smooth — we deliberately do NOT re-assert a hard binary mask here, since that
    would reintroduce a sharp seam at the mask edge.
    """
    if original_image.size != generated_image.size or original_image.size != blend_mask.size:
        return generated_image # Fallback if sizes mismatch somehow

    orig = np.array(original_image.convert("RGB"), dtype=np.float32)
    gen = np.array(generated_image.convert("RGB"), dtype=np.float32)
    alpha = np.array(blend_mask.convert("L"), dtype=np.float32) / 255.0
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

def _blur_fill_from_opaque(
    image: Image.Image,
    scale: int = 8,
    iterations: int = 40,
) -> Image.Image:
    """
    Build a smooth low-frequency background for outpainting using ONLY the opaque
    pixels of an RGBA image.

    A naive ``image.resize(...).convert("RGB")`` averages the transparent void's
    RGB (usually black) into the result, so the model is seeded from a dark muddy
    wash near the border instead of a real extension of the picture's colors.
    Here we diffuse the opaque colors into the void (heat-equation style) so the
    seed is derived purely from actual content. Returns an RGB image the size of
    the input.
    """
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    rgb = rgba[..., :3]
    known = rgba[..., 3] >= 255  # fully opaque == real content
    h, w = known.shape

    if known.all():
        # Nothing transparent — the wash is irrelevant, return content as-is.
        return image.convert("RGB")
    if not known.any():
        # No content to derive colors from — neutral grey beats a black cliff.
        return Image.new("RGB", (w, h), (127, 127, 127))

    # Work at reduced resolution: cheap, and we only need a low-frequency wash.
    sw, sh = max(1, w // scale), max(1, h // scale)
    small_rgb = np.asarray(
        Image.fromarray(rgb.astype(np.uint8)).resize((sw, sh), Image.BILINEAR),
        dtype=np.float32,
    )
    small_known = np.asarray(
        Image.fromarray((known * 255).astype(np.uint8)).resize((sw, sh), Image.BILINEAR),
        dtype=np.float32,
    ) > 127
    if not small_known.any():
        small_known[sh // 2, sw // 2] = True  # guarantee a seed survives downscale

    seed = small_rgb[small_known].mean(axis=0)
    fill = small_rgb.copy()
    fill[~small_known] = seed
    known3 = small_known[..., None]

    # Diffuse opaque colors into the void; clamp the known pixels back each step
    # so content edges keep pushing their colors outward.
    for _ in range(iterations):
        blurred = np.asarray(
            Image.fromarray(fill.astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)),
            dtype=np.float32,
        )
        fill = np.where(known3, small_rgb, blurred)

    big = Image.fromarray(fill.astype(np.uint8)).resize((w, h), Image.BICUBIC)
    return big.convert("RGB")


def prepare_image_for_outpainting(
    image: Image.Image,
    mask_padding: int = 32,
    mask_blur: int = 4,
) -> tuple[Image.Image, Image.Image, Image.Image]:
    """
    Prepares an RGBA image for outpainting/inpainting.

    Strategy (Blur Fill + Noise):
    1. Detect void (Alpha=0). Create generation mask.
    2. Fill void with a content-derived color wash + noise. The wash is built
       only from opaque pixels (see ``_blur_fill_from_opaque``), giving the model
       color context to hallucinate from without "black cliffs" at the border.

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

    # 2. Create Infill Background from opaque content only (no void contamination)
    bg_filled = _blur_fill_from_opaque(image)

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
