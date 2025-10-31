from __future__ import annotations

"""
Settings layer responsible for describing the Stable Diffusion backends that
are available to the application.

The configuration is intentionally split into two tiers:

1. :class:`PipelineConfig` captures the information required to instantiate a
   single diffusers pipeline — model identifier, `torch_dtype`, revision tag,
   etc.  Backends can mix and match different pipeline configs for text2img,
   img2img, inpainting and upscaling.
2. :class:`ModelConfig` groups the pipeline configs that constitute a single
   backend (e.g. SD 1.5 VS SDXL) and stores sensible defaults such as image
   size, guidance scale or scheduler.

The :func:`load_settings` helper reads ``models.yaml`` (or an explicitly
provided path) and materialises the dataclasses so higher level modules can
rely on type-checked objects instead of raw dictionaries.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional, Any

import yaml


@dataclass(slots=True)
class PipelineConfig:
    """
    Declarative description of a single diffusers pipeline instance.

    Parameters mirror the arguments accepted by the Diffusers
    ``from_pretrained`` helpers.  The configuration is referenced by the
    backends when they request a pipeline from :class:`ModelManager`.
    """

    id: str
    variant: Optional[str] = None
    revision: Optional[str] = None
    torch_dtype: str = "float16"
    scheduler: Optional[str] = None


@dataclass(slots=True)
class ModelConfig:
    """
    Aggregates all building blocks that together represent a backend.

    A backend combines the base text-to-image pipeline with optional flavour
    pipelines (img2img, inpainting, upscaling, refiner).  The default values
    stored alongside them provide a single source of truth for resolution,
    number of steps, scheduler name, etc.
    """

    name: str
    text2img: PipelineConfig
    img2img: Optional[PipelineConfig] = None
    inpaint: Optional[PipelineConfig] = None
    upscale: Optional[PipelineConfig] = None
    refiner: Optional[PipelineConfig] = None
    default_width: int = 512
    default_height: int = 512
    default_steps: int = 25
    default_cfg_scale: float = 7.5
    default_scheduler: str = "dpmpp_2m_karras"


@dataclass(slots=True)
class GenerationSettings:
    """
    Top-level configuration that influences every backend.

    The fields encapsulate environment-wide toggles such as which device to
    favour, which performance optimisations are allowed and which safety policy
    should be enforced.  The :class:`~image_generation.services.generator.ImageGenerationService`
    consumes this dataclass during initialisation.
    """

    models: Dict[str, ModelConfig] = field(default_factory=dict)
    device: str = "auto"
    enable_xformers: bool = True
    enable_attention_slicing: bool = False
    enable_sequential_cpu_offload: bool = False
    enable_model_cpu_offload: bool = False
    enable_compile: bool = False
    autocast_precision: str = "fp16"
    safety_mode: str = "warn"  # warn | block | off


def _parse_pipeline_config(raw: Dict[str, Any]) -> PipelineConfig:
    """
    Convert a raw dictionary (coming from YAML) into :class:`PipelineConfig`.

    Parameters
    ----------
    raw:
        Mapping with keys matching ``PipelineConfig`` fields.
    """
    return PipelineConfig(
        id=raw["id"],
        variant=raw.get("variant"),
        revision=raw.get("revision"),
        torch_dtype=raw.get("torch_dtype", "float16"),
        scheduler=raw.get("scheduler"),
    )


def _parse_model_config(name: str, raw: Dict[str, Any]) -> ModelConfig:
    """
    Convert a dictionary into :class:`ModelConfig`.

    Parameters
    ----------
    name:
        Identifier used in the YAML file.  Stored for debugging purposes so
        errors can reference the backend name.
    raw:
        Mapping that may contain nested pipeline sections.
    """
    return ModelConfig(
        name=name,
        text2img=_parse_pipeline_config(raw["text2img"]),
        img2img=_parse_pipeline_config(raw["img2img"]) if raw.get("img2img") else None,
        inpaint=_parse_pipeline_config(raw["inpaint"]) if raw.get("inpaint") else None,
        upscale=_parse_pipeline_config(raw["upscale"]) if raw.get("upscale") else None,
        refiner=_parse_pipeline_config(raw["refiner"]) if raw.get("refiner") else None,
        default_width=raw.get("default_width", 512),
        default_height=raw.get("default_height", 512),
        default_steps=raw.get("default_steps", 25),
        default_cfg_scale=raw.get("default_cfg_scale", 7.5),
        default_scheduler=raw.get("default_scheduler", "dpmpp_2m_karras"),
    )


def load_settings(path: Optional[Path] = None) -> GenerationSettings:
    """
    Load generation settings from a YAML file and materialise dataclasses.

    If ``path`` is omitted, ``models.yaml`` next to this file is used.

    Returns
    -------
    GenerationSettings
        Fully parsed configuration that can be passed to
        :class:`~image_generation.services.generator.ImageGenerationService`.
    """

    if path is None:
        path = Path(__file__).with_name("models.yaml")

    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    models_section = raw.get("models", {})
    models = {
        name: _parse_model_config(name, cfg) for name, cfg in models_section.items()
    }

    return GenerationSettings(
        models=models,
        device=raw.get("device", "auto"),
        enable_xformers=raw.get("enable_xformers", True),
        enable_attention_slicing=raw.get("enable_attention_slicing", False),
        enable_sequential_cpu_offload=raw.get("enable_sequential_cpu_offload", False),
        enable_model_cpu_offload=raw.get("enable_model_cpu_offload", False),
        enable_compile=raw.get("enable_compile", False),
        autocast_precision=raw.get("autocast_precision", "fp16"),
        safety_mode=raw.get("safety_mode", "warn"),
    )
