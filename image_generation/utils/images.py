from __future__ import annotations

"""
Lightweight image loader/saver helpers shared across the pipelines.

The Stable Diffusion pipelines work with :class:`PIL.Image` objects, therefore
all request DTOs expect images in memory.  These utilities sit between the
external interface (which may pass file paths) and the pipelines to guarantee
consistent modes and sizes.
"""

from pathlib import Path
from typing import Union, Tuple

from PIL import Image


ImageLike = Union[str, Path, Image.Image]


def load_image(source: ImageLike) -> Image.Image:
    """
    Load an image from a path-like or return a copy when a PIL image is given.

    Copying the PIL image ensures the caller can mutate the original reference
    without affecting the pipeline input.
    """
    if isinstance(source, Image.Image):
        return source.copy()
    return Image.open(source).convert("RGB")


def save_image(image: Image.Image, destination: ImageLike, **save_kwargs) -> None:
    """
    Persist a PIL image to disk, creating parent folders automatically.

    Parameters
    ----------
    image:
        PIL image to be saved.
    destination:
        Path-like target (string or :class:`pathlib.Path`).
    save_kwargs:
        Additional parameters forwarded to :meth:`PIL.Image.Image.save`.
    """
    if isinstance(destination, (str, Path)):
        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        image.save(destination, **save_kwargs)
    else:
        raise TypeError("destination must be path-like")


def ensure_rgba_mask(mask: ImageLike, size: Tuple[int, int]) -> Image.Image:
    """
    Normalise a mask image to a single-channel ``L`` image with desired size.

    Diffusers inpainting pipelines expect the mask to match the base image
    dimensions; this helper enforces the contract and converts other modes
    (e.g. ``RGBA``) to luminance.
    """
    img = mask if isinstance(mask, Image.Image) else Image.open(mask)
    if img.mode != "L":
        img = img.convert("L")
    if img.size != size:
        img = img.resize(size, Image.LANCZOS)
    return img


def resize_to_multiple(image: Image.Image, multiple: int = 8) -> Image.Image:
    """
    Downscale the image so both dimensions are multiples of ``multiple``.

    Stable Diffusion’s latent space requires dimensions divisible by 8 (or 64
    for SDXL).  If the image already satisfies the condition it is returned as
    is; otherwise the function performs a Lanczos downscale to the closest
    compatible size.
    """
    width, height = image.size
    nw = width - (width % multiple)
    nh = height - (height % multiple)
    if nw == width and nh == height:
        return image
    return image.resize((nw, nh), Image.LANCZOS)
