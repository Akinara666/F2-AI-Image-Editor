"""
High-level façade around the Stable Diffusion pipelines.

The classes re-exported here are intended to be the only touch point for UI
modules, CLI utilities or integration tests that need to generate or transform
images.  By keeping the public API in this init file we can do

``from image_generation.services import ImageGenerationService``.
"""

from .generator import (
    ImageGenerationService,
    Text2ImgRequest,
    Img2ImgRequest,
    InpaintRequest,
    UpscaleRequest,
)

__all__ = [
    "ImageGenerationService",
    "Text2ImgRequest",
    "Img2ImgRequest",
    "InpaintRequest",
    "UpscaleRequest",
]
