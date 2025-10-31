from __future__ import annotations

"""
High level facade that exposes Stable Diffusion features to the rest of the application.

The :class:`ImageGenerationService` coordinates configuration loading,
initialises device-specific optimisations, instantiates the available
backends (SD 1.5 and SDXL) and provides DTO-style request classes for the
different generation modes.  Consumers such as the UI or automated tests only
interact with this layer and do not need to worry about the underlying
Diffusers APIs.
"""

from dataclasses import dataclass, field
from typing import Dict, Optional, Any

import torch

from ..config import GenerationSettings, load_settings
from ..pipelines import (
    ModelManager,
    GenerationBackend,
    GenerationResult,
    Text2ImgParams,
    Img2ImgParams,
    InpaintParams,
    UpscaleParams,
)
from ..pipelines.sd15 import SD15Backend
from ..pipelines.sdxl import SDXLBackend
from ..utils import (
    DeviceConfig,
    resolve_device,
    SafetyMode,
    ensure_rgba_mask,
    resize_to_multiple,
)
from ..utils.device import get_autocast_dtype
from ..utils.seed import prepare_generator


@dataclass(slots=True)
class BaseRequest:
    """
    Common fields shared by all request DTOs.

    Attributes
    ----------
    model:
        Which backend to target.  Must match a key defined in ``models.yaml``.
    scheduler:
        Optional override for the scheduler used in this run.
    seed:
        Optional deterministic seed.  When omitted the generation is random.
    progress_cb:
        Optional callable receiving :class:`DiffusionProgress` updates.
    extra_options:
        Dictionary for backend-specific experimental flags.
    """

    model: str = "sd15"
    scheduler: Optional[str] = None
    seed: Optional[int] = None
    progress_cb: Optional[Any] = None
    extra_options: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Text2ImgRequest(BaseRequest):
    """
    DTO describing a text-to-image generation request.

    The fields map directly to the parameters exposed by diffusers pipelines
    plus a ``refine`` switch enabling the SDXL refiner when available.
    """

    prompt: str = ""
    negative_prompt: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None
    num_images: int = 1
    tiling: bool = False
    refine: bool = False


@dataclass(slots=True)
class Img2ImgRequest(BaseRequest):
    """
    DTO describing an img2img request.

    ``image`` must be a :class:`PIL.Image.Image` prepared by the caller (the
    service resizes it to the required latent multiple).
    """

    prompt: str = ""
    image: Optional[Any] = None
    negative_prompt: Optional[str] = None
    strength: float = 0.5
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None


@dataclass(slots=True)
class InpaintRequest(BaseRequest):
    """
    DTO describing an inpainting request.

    Both ``image`` and ``mask_image`` are expected to be PIL images.  The
    service takes care of normalising the mask to the correct format.
    """

    prompt: str = ""
    image: Optional[Any] = None
    mask_image: Optional[Any] = None
    negative_prompt: Optional[str] = None
    strength: float = 0.5
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None


@dataclass(slots=True)
class UpscaleRequest(BaseRequest):
    """
    DTO describing an upscaling request.

    ``prompt`` and ``negative_prompt`` are optional so the same object can be
    used for purely perceptual upscaling (e.g. RealESRGAN) where guidance is
    not necessary.
    """

    image: Optional[Any] = None
    prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    steps: Optional[int] = None
    guidance_scale: Optional[float] = None


class ImageGenerationService:
    """
    High-level facade providing SD 1.5 / SDXL generation features.

    A single service instance holds onto a :class:`ModelManager` so pipeline
    objects are cached and reused between calls.  All public methods return a
    :class:`GenerationResult`.
    """

    def __init__(self, settings: Optional[GenerationSettings] = None) -> None:
        self.settings = settings or load_settings()
        self.device_cfg = self._build_device_config(self.settings)
        self.manager = ModelManager(self.settings, self.device_cfg)
        self.backends = self._init_backends()

    def _build_device_config(self, settings: GenerationSettings) -> DeviceConfig:
        """
        Materialise :class:`DeviceConfig` from :class:`GenerationSettings`.

        The helper selects appropriate default dtypes for CUDA/MPS/CPU and
        validates the autocast precision value provided by the user.
        """
        device = resolve_device(settings.device)
        if device.type == "cuda":
            torch_dtype = torch.float16
        elif device.type == "mps":
            torch_dtype = torch.float16
        else:
            torch_dtype = torch.float32

        autocast_precision = settings.autocast_precision
        if get_autocast_dtype(autocast_precision) is None:
            autocast_precision = "fp32"

        return DeviceConfig(
            device=device,
            torch_dtype=torch_dtype,
            autocast_precision=autocast_precision,
            enable_xformers=settings.enable_xformers,
            enable_attention_slicing=settings.enable_attention_slicing,
            enable_sequential_cpu_offload=settings.enable_sequential_cpu_offload,
            enable_model_cpu_offload=settings.enable_model_cpu_offload,
            enable_compile=settings.enable_compile,
        )

    def _init_backends(self) -> Dict[str, GenerationBackend]:
        """
        Instantiate all configured backends and return them in a dictionary.

        Raises
        ------
        RuntimeError
            When no backends are enabled in the configuration, as the service
            would be unusable.
        """
        safety_mode = SafetyMode(self.settings.safety_mode)
        backends: Dict[str, GenerationBackend] = {}

        if "sd15" in self.settings.models:
            backends["sd15"] = SD15Backend(
                config=self.settings.models["sd15"],
                device_cfg=self.device_cfg,
                settings=self.settings,
                safety_mode=safety_mode,
                manager=self.manager,
            )
        if "sdxl" in self.settings.models:
            backends["sdxl"] = SDXLBackend(
                config=self.settings.models["sdxl"],
                device_cfg=self.device_cfg,
                settings=self.settings,
                safety_mode=safety_mode,
                manager=self.manager,
            )
        if not backends:
            raise RuntimeError("No backends configured. Check models.yaml.")
        return backends

    def _get_backend(self, model: str) -> GenerationBackend:
        """
        Fetch a backend by name with a clear error when it is missing.
        """
        if model not in self.backends:
            available = ", ".join(self.backends.keys())
            raise KeyError(f"Unknown model '{model}'. Available: {available}")
        return self.backends[model]

    def text2img(self, request: Text2ImgRequest) -> GenerationResult:
        """
        Generate images from text prompts using the requested backend.
        """
        backend = self._get_backend(request.model)
        generator = prepare_generator(request.seed, self.device_cfg.device)
        params = Text2ImgParams(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            width=request.width,
            height=request.height,
            steps=request.steps,
            guidance_scale=request.guidance_scale,
            num_images=request.num_images,
            tiling=request.tiling,
            refine=request.refine,
            scheduler=request.scheduler,
            seed=request.seed,
            generator=generator,
            progress_cb=request.progress_cb,
            extra_options=request.extra_options,
        )
        return backend.text2img(params)

    def img2img(self, request: Img2ImgRequest) -> GenerationResult:
        """
        Generate image variations starting from an input image.
        """
        if request.image is None:
            raise ValueError("img2img request requires 'image'.")
        backend = self._get_backend(request.model)
        generator = prepare_generator(request.seed, self.device_cfg.device)
        params = Img2ImgParams(
            prompt=request.prompt,
            image=resize_to_multiple(request.image),
            negative_prompt=request.negative_prompt,
            strength=request.strength,
            steps=request.steps,
            guidance_scale=request.guidance_scale,
            scheduler=request.scheduler,
            seed=request.seed,
            generator=generator,
            progress_cb=request.progress_cb,
            extra_options=request.extra_options,
        )
        return backend.img2img(params)

    def inpaint(self, request: InpaintRequest) -> GenerationResult:
        """
        Run inpainting on a source image and mask.
        """
        if request.image is None or request.mask_image is None:
            raise ValueError("inpaint request requires 'image' and 'mask_image'.")

        backend = self._get_backend(request.model)
        generator = prepare_generator(request.seed, self.device_cfg.device)
        image = resize_to_multiple(request.image)
        mask = ensure_rgba_mask(request.mask_image, image.size)

        params = InpaintParams(
            prompt=request.prompt,
            image=image,
            mask=mask,
            negative_prompt=request.negative_prompt,
            strength=request.strength,
            steps=request.steps,
            guidance_scale=request.guidance_scale,
            scheduler=request.scheduler,
            seed=request.seed,
            generator=generator,
            progress_cb=request.progress_cb,
            extra_options=request.extra_options,
        )
        return backend.inpaint(params)

    def upscale(self, request: UpscaleRequest) -> GenerationResult:
        """
        Run the upscaling flow (diffusers upscaler or other implementations).
        """
        if request.image is None:
            raise ValueError("upscale request requires 'image'.")

        backend = self._get_backend(request.model)
        generator = prepare_generator(request.seed, self.device_cfg.device)
        params = UpscaleParams(
            image=request.image,
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            steps=request.steps,
            guidance_scale=request.guidance_scale,
            scheduler=request.scheduler,
            seed=request.seed,
            generator=generator,
            progress_cb=request.progress_cb,
            extra_options=request.extra_options,
        )
        return backend.upscale(params)
