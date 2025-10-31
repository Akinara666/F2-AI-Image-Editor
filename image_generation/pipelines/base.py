from __future__ import annotations

import time
"""
Shared abstractions and data structures for Stable Diffusion backends.

Every backend (SD 1.5, SDXL, future models) derives from
:class:`GenerationBackend` so the service can interact with them via a uniform
interface.  The dataclasses declared here group together the parameters for
each operation mode and are filled by :class:`~image_generation.services.generator.ImageGenerationService`
before delegating to the backend.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import torch
from PIL import Image

from ..config.settings import ModelConfig, GenerationSettings
from ..utils import (
    DeviceConfig,
    ProgressCallback,
    SafetyMode,
    SafetyResult,
)


@dataclass(slots=True)
class Text2ImgParams:
    """
    Parameter bundle passed to :meth:`GenerationBackend.text2img`.

    The structure mirrors the arguments expected by diffusers pipelines but
    keeps the service code tidy and explicit.  Additional options can be passed
    through ``extra_options`` so new features can be introduced without
    breaking the contract.
    """

    prompt: str
    negative_prompt: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    scheduler: Optional[str] = None
    num_images: int = 1
    seed: Optional[int] = None
    tiling: bool = False
    refine: bool = False
    generator: Optional[torch.Generator] = None
    progress_cb: Optional[ProgressCallback] = None
    extra_options: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Img2ImgParams:
    """
    Parameters for :meth:`GenerationBackend.img2img`.

    Contains the reference image (already converted to ``PIL.Image``) and
    allows custom strength/configuration overrides.
    """

    prompt: str
    image: Image.Image
    negative_prompt: Optional[str] = None
    strength: float = 0.5
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    generator: Optional[torch.Generator] = None
    progress_cb: Optional[ProgressCallback] = None
    extra_options: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class InpaintParams:
    """
    Parameters for :meth:`GenerationBackend.inpaint`.

    Works similarly to :class:`Img2ImgParams` but carries an additional mask
    image.  The service ensures the mask has already been converted to the
    expected luminance format and size.
    """

    prompt: str
    image: Image.Image
    mask: Image.Image
    negative_prompt: Optional[str] = None
    strength: float = 0.5
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    generator: Optional[torch.Generator] = None
    progress_cb: Optional[ProgressCallback] = None
    extra_options: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class UpscaleParams:
    """
    Parameters for :meth:`GenerationBackend.upscale`.

    Upscaling supports both prompt-guided SD upscalers and third-party models.
    ``extra_options`` can be used to pass custom switches such as
    ``noise_level`` for hi-res fix or RealESRGAN variants.
    """

    image: Image.Image
    prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    guidance_scale: Optional[float] = None
    steps: Optional[int] = None
    generator: Optional[torch.Generator] = None
    progress_cb: Optional[ProgressCallback] = None
    extra_options: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class GenerationResult:
    """
    Common result object returned by every backend method.

    Attributes
    ----------
    images:
        Generated PIL images (typically a single entry).
    seed:
        Seed used for generation (if deterministically supplied).
    model_id:
        Identifier of the diffusers model that produced the output.
    elapsed_ms:
        Time spent inside the pipeline call.
    metadata:
        Additional information surfaced to the caller (steps, scheduler, etc.).
    safety:
        Result of the safety checker evaluation, when enabled.
    """

    images: List[Image.Image]
    seed: Optional[int]
    model_id: str
    elapsed_ms: float
    metadata: Dict[str, Any] = field(default_factory=dict)
    safety: Optional[SafetyResult] = None


class GenerationBackend(ABC):
    """
    Base interface implemented by specific Stable Diffusion backends.

    The class encapsulates helpers that are useful across implementations,
    namely:

    - Normalising width/height/seed values when callers leave them undefined.
    - Setting up timers and scheduler names before invoking diffusers.
    - Creating consistent :class:`GenerationResult` instances after the run.
    """

    def __init__(
        self,
        name: str,
        config: ModelConfig,
        device_cfg: DeviceConfig,
        settings: GenerationSettings,
        safety_mode: SafetyMode,
    ) -> None:
        self.name = name
        self.config = config
        self.device_cfg = device_cfg
        self.settings = settings
        self.safety_mode = safety_mode

    @abstractmethod
    def text2img(self, params: Text2ImgParams) -> GenerationResult: ...

    @abstractmethod
    def img2img(self, params: Img2ImgParams) -> GenerationResult: ...

    @abstractmethod
    def inpaint(self, params: InpaintParams) -> GenerationResult: ...

    @abstractmethod
    def upscale(self, params: UpscaleParams) -> GenerationResult: ...

    def _infer_width_height(self, params: Text2ImgParams) -> Dict[str, int]:
        """
        Fill in missing width/height using backend defaults.
        """
        width = params.width or self.config.default_width
        height = params.height or self.config.default_height
        return {"width": width, "height": height}

    def _prepare_execution(
        self,
        seed: Optional[int],
        scheduler_name: Optional[str],
        default_scheduler: str,
    ) -> Dict[str, Any]:
        """
        Compute execution metadata (timer + scheduler decision) shared by all modes.
        """
        start_time = time.perf_counter()
        scheduler = scheduler_name or default_scheduler
        return {"start_time": start_time, "scheduler_name": scheduler}

    def _get_generator(
        self, seed: Optional[int], generator: Optional[torch.Generator]
    ) -> Optional[torch.Generator]:
        """
        Reuse the provided generator when present or create one from the seed.
        """
        if generator is not None or seed is None:
            return generator
        gen = torch.Generator(device=self.device_cfg.device)
        gen.manual_seed(seed)
        return gen

    def _finalize_result(
        self,
        *,
        start_time: float,
        images: List[Image.Image],
        seed: Optional[int],
        model_id: str,
        metadata: Dict[str, Any],
        safety: Optional[SafetyResult] = None,
    ) -> GenerationResult:
        """
        Assemble the :class:`GenerationResult` with timing and metadata.
        """
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        return GenerationResult(
            images=images,
            seed=seed,
            model_id=model_id,
            elapsed_ms=elapsed_ms,
            metadata=metadata,
            safety=safety,
        )
