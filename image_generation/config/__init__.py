"""
Namespace package for configuration artefacts that drive the image-generation
module.

The intent is to keep all configuration-related types and helpers in a single
place so that downstream modules can treat them as immutable contracts.  The
objects exported here are consumed by:

- :class:`~image_generation.services.generator.ImageGenerationService` when it
  initialises the backends and device features.
- :class:`~image_generation.pipelines.manager.ModelManager` which needs access
  to :class:`~image_generation.config.settings.PipelineConfig` instances in
  order to lazily load and cache diffusers pipelines.
"""

from .settings import GenerationSettings, ModelConfig, PipelineConfig, load_settings

__all__ = [
    "GenerationSettings",
    "ModelConfig",
    "PipelineConfig",
    "load_settings",
]
