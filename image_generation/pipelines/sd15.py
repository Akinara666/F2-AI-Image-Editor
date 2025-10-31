from __future__ import annotations

"""
Stable Diffusion 1.5 backend implementation.

This module wires the generic abstractions defined in ``base.py`` with the
specific diffusers pipelines used for SD 1.5 text2img, img2img, inpainting and
upscaling.  The backend is instantiated by :class:`ImageGenerationService` and
receives a shared :class:`ModelManager` so the heavy models are cached across
requests.
"""

from typing import Optional, Tuple, List

import torch
from diffusers import (
    StableDiffusionPipeline,
    StableDiffusionImg2ImgPipeline,
    StableDiffusionInpaintPipeline,
    StableDiffusionUpscalePipeline,
)

from .base import (
    GenerationBackend,
    GenerationResult,
    Img2ImgParams,
    InpaintParams,
    Text2ImgParams,
    UpscaleParams,
)
from .manager import ModelManager
from ..config.settings import ModelConfig, PipelineConfig, GenerationSettings
from ..utils import (
    DeviceConfig,
    SafetyMode,
    handle_safety,
    make_callback,
)
from ..utils.device import autocast_context


_DTYPE_MAP = {
    "float16": torch.float16,
    "fp16": torch.float16,
    "float32": torch.float32,
    "fp32": torch.float32,
    "bfloat16": torch.bfloat16,
    "bf16": torch.bfloat16,
}


def _resolve_dtype(name: Optional[str], fallback: torch.dtype) -> torch.dtype:
    """
    Convert the string dtype stored in configuration into a torch dtype.

    Parameters
    ----------
    name:
        String representation such as ``"float16"``.
    fallback:
        Default dtype used when the configuration omits the field.
    """
    if not name:
        return fallback
    return _DTYPE_MAP.get(name.lower(), fallback)


class SD15Backend(GenerationBackend):
    """
    Stable Diffusion 1.5 backend covering text2img, img2img, inpainting and upscaling.

     The backend relies on :class:`ModelManager` to lazily load the pipelines
     and exposes the high-level methods consumed by the service.
    """

    def __init__(
        self,
        config: ModelConfig,
        device_cfg: DeviceConfig,
        settings: GenerationSettings,
        safety_mode: SafetyMode,
        manager: ModelManager,
    ) -> None:
        super().__init__("sd15", config, device_cfg, settings, safety_mode)
        self.manager = manager

    # region Loading helpers
    def _load_text2img(self, cfg: PipelineConfig) -> StableDiffusionPipeline:
        """
        Instantiate the base SD 1.5 text-to-image pipeline.

        Safety checker is disabled when the global safety mode is ``OFF``.
        """
        pipe = StableDiffusionPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_img2img(self, cfg: PipelineConfig) -> StableDiffusionImg2ImgPipeline:
        """
        Instantiate the SD 1.5 img2img pipeline.
        """
        pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_inpaint(self, cfg: PipelineConfig) -> StableDiffusionInpaintPipeline:
        """
        Instantiate the SD 1.5 inpainting pipeline.
        """
        pipe = StableDiffusionInpaintPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_upscale(self, cfg: PipelineConfig) -> StableDiffusionUpscalePipeline:
        """
        Instantiate the SD Upscaler pipeline.
        """
        pipe = StableDiffusionUpscalePipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        return pipe

    # endregion

    def _get_text2img_pipe(self) -> StableDiffusionPipeline:
        """Return (and cache) the SD 1.5 text2img pipeline."""
        if self.config.text2img is None:
            raise RuntimeError("text2img pipeline is not configured for sd15")
        return self.manager.get_pipeline(
            ("sd15", "text2img"),
            self.config.text2img,
            self._load_text2img,
        )

    def _get_img2img_pipe(self) -> StableDiffusionImg2ImgPipeline:
        """Return (and cache) the SD 1.5 img2img pipeline."""
        cfg = self.config.img2img or self.config.text2img
        if cfg is None:
            raise RuntimeError("img2img pipeline is not configured for sd15")
        cache_key = ("sd15", "img2img" if self.config.img2img else "text2img")
        return self.manager.get_pipeline(cache_key, cfg, self._load_img2img)

    def _get_inpaint_pipe(self) -> StableDiffusionInpaintPipeline:
        """Return (and cache) the SD 1.5 inpainting pipeline."""
        if self.config.inpaint is None:
            raise RuntimeError("inpaint pipeline is not configured for sd15")
        return self.manager.get_pipeline(
            ("sd15", "inpaint"),
            self.config.inpaint,
            self._load_inpaint,
        )

    def _get_upscale_pipe(self) -> StableDiffusionUpscalePipeline:
        """Return (and cache) the SD 1.5 upscaling pipeline."""
        if self.config.upscale is None:
            raise RuntimeError("upscale pipeline is not configured for sd15")
        return self.manager.get_pipeline(
            ("sd15", "upscale"),
            self.config.upscale,
            self._load_upscale,
        )

    # region Operations
    def text2img(self, params: Text2ImgParams) -> GenerationResult:
        """
        Run the text-to-image generation flow for SD 1.5.

        Handles scheduler selection, mixed precision context and safety checker
        post-processing before producing a :class:`GenerationResult`.
        """
        pipe = self._get_text2img_pipe()
        exec_ctx = self._prepare_execution(
            params.seed, params.scheduler, self.config.default_scheduler
        )
        self.manager.set_scheduler(pipe, exec_ctx["scheduler_name"])

        kwargs = self._infer_width_height(params)
        steps = params.steps or self.config.default_steps
        guidance = params.guidance_scale or self.config.default_cfg_scale
        generator = self._get_generator(params.seed, params.generator)

        callback = make_callback(params.progress_cb, steps)

        with autocast_context(self.device_cfg):
            result = pipe(
                prompt=params.prompt,
                negative_prompt=params.negative_prompt,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                num_images_per_prompt=params.num_images,
                callback=callback,
                tiling=params.tiling,
                **kwargs,
                **params.extra_options,
            )

        safety = handle_safety(self.safety_mode, getattr(result, "nsfw_content_detected", []))
        metadata = {
            "steps": steps,
            "guidance_scale": guidance,
            "scheduler": exec_ctx["scheduler_name"],
            "width": kwargs["width"],
            "height": kwargs["height"],
        }

        return self._finalize_result(
            start_time=exec_ctx["start_time"],
            images=list(result.images),
            seed=params.seed,
            model_id=self.config.text2img.id,
            metadata=metadata,
            safety=safety,
        )

    def img2img(self, params: Img2ImgParams) -> GenerationResult:
        """
        Run the img2img generation flow for SD 1.5.
        """
        pipe = self._get_img2img_pipe()
        exec_ctx = self._prepare_execution(
            params.seed, params.scheduler, self.config.default_scheduler
        )
        self.manager.set_scheduler(pipe, exec_ctx["scheduler_name"])

        steps = params.steps or self.config.default_steps
        guidance = params.guidance_scale or self.config.default_cfg_scale
        generator = self._get_generator(params.seed, params.generator)
        callback = make_callback(params.progress_cb, steps)

        with autocast_context(self.device_cfg):
            result = pipe(
                prompt=params.prompt,
                image=params.image,
                strength=params.strength,
                negative_prompt=params.negative_prompt,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback=callback,
                **params.extra_options,
            )

        safety = handle_safety(self.safety_mode, getattr(result, "nsfw_content_detected", []))
        metadata = {
            "steps": steps,
            "guidance_scale": guidance,
            "scheduler": exec_ctx["scheduler_name"],
            "strength": params.strength,
        }
        model_id = (self.config.img2img or self.config.text2img).id

        return self._finalize_result(
            start_time=exec_ctx["start_time"],
            images=list(result.images),
            seed=params.seed,
            model_id=model_id,
            metadata=metadata,
            safety=safety,
        )

    def inpaint(self, params: InpaintParams) -> GenerationResult:
        """
        Run the inpainting flow for SD 1.5.
        """
        pipe = self._get_inpaint_pipe()
        exec_ctx = self._prepare_execution(
            params.seed, params.scheduler, self.config.default_scheduler
        )
        self.manager.set_scheduler(pipe, exec_ctx["scheduler_name"])

        steps = params.steps or self.config.default_steps
        guidance = params.guidance_scale or self.config.default_cfg_scale
        generator = self._get_generator(params.seed, params.generator)
        callback = make_callback(params.progress_cb, steps)

        with autocast_context(self.device_cfg):
            result = pipe(
                prompt=params.prompt,
                image=params.image,
                mask_image=params.mask,
                strength=params.strength,
                negative_prompt=params.negative_prompt,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback=callback,
                **params.extra_options,
            )

        safety = handle_safety(self.safety_mode, getattr(result, "nsfw_content_detected", []))
        metadata = {
            "steps": steps,
            "guidance_scale": guidance,
            "scheduler": exec_ctx["scheduler_name"],
            "strength": params.strength,
        }

        return self._finalize_result(
            start_time=exec_ctx["start_time"],
            images=list(result.images),
            seed=params.seed,
            model_id=self.config.inpaint.id,
            metadata=metadata,
            safety=safety,
        )

    def upscale(self, params: UpscaleParams) -> GenerationResult:
        """
        Run the SD Upscaler flow for SD 1.5.
        """
        pipe = self._get_upscale_pipe()
        exec_ctx = self._prepare_execution(
            params.seed, params.scheduler, self.config.default_scheduler
        )
        self.manager.set_scheduler(pipe, exec_ctx["scheduler_name"])

        steps = params.steps or 20
        guidance = params.guidance_scale or 0.0
        generator = self._get_generator(params.seed, params.generator)
        callback = make_callback(params.progress_cb, steps)

        with autocast_context(self.device_cfg):
            result = pipe(
                image=params.image,
                prompt=params.prompt,
                negative_prompt=params.negative_prompt,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                callback=callback,
                **params.extra_options,
            )

        metadata = {
            "steps": steps,
            "guidance_scale": guidance,
            "scheduler": exec_ctx["scheduler_name"],
        }

        return self._finalize_result(
            start_time=exec_ctx["start_time"],
            images=list(result.images),
            seed=params.seed,
            model_id=self.config.upscale.id,
            metadata=metadata,
        )

    # endregion
