"""
Public entry point for the image generation package.

This module exposes the two most important touch points required by external
consumers:

- :class:`~image_generation.services.generator.ImageGenerationService` — high level
  orchestrator that hides the complexity of loading Stable Diffusion 1.5 / SDXL
  pipelines, managing schedulers and running the different generation modes.
- :func:`~image_generation.config.settings.load_settings` and
  :class:`~image_generation.config.settings.GenerationSettings` — helpers for
  reading the YAML-based configuration that describes available models and the
  environment tweaks (device selection, safety checker policy, memory optimisations).

Typical usage pattern::

    from image_generation import ImageGenerationService, load_settings

    service = ImageGenerationService(load_settings())
    result = service.text2img(Text2ImgRequest(prompt="Galaxy skyline"))
    result.images[0].save("output.png")
"""

from .services.generator import ImageGenerationService
from .config.settings import GenerationSettings, load_settings

__all__ = [
    "ImageGenerationService",
    "GenerationSettings",
    "load_settings",
]
