"""
Collection of Stable Diffusion backends used by the unified generation service.

The package groups together:

- Base dataclasses describing the different operation modes (text2img, img2img,
  inpainting, upscaling) and the generic :class:`GenerationBackend` interface.
- Concrete backend implementations for Stable Diffusion 1.5 and SDXL.
- The :class:`ModelManager` utility that keeps track of instantiated diffusers
  pipelines so we do not pay the loading cost more than once.

The :mod:`image_generation.services.generator` facade imports from this module
to wire everything together, therefore public re-exports live here for
ergonomic imports.
"""

from .manager import ModelManager
from .base import (
    GenerationBackend,
    Text2ImgParams,
    Img2ImgParams,
    InpaintParams,
    UpscaleParams,
    GenerationResult,
)
from .sd15 import SD15Backend
from .sdxl import SDXLBackend

__all__ = [
    "ModelManager",
    "GenerationBackend",
    "Text2ImgParams",
    "Img2ImgParams",
    "InpaintParams",
    "UpscaleParams",
    "GenerationResult",
    "SD15Backend",
    "SDXLBackend",
]
