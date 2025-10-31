from __future__ import annotations

"""
Stable Diffusion XL backend implementation.

Compared to SD 1.5 the SDXL backend additionally supports an optional refiner
pass for improved high-frequency detail.  The overall structure mirrors the
SD 1.5 backend so both can be used interchangeably by the service layer.
"""

from typing import List, Optional

import torch
from diffusers import (
    StableDiffusionXLPipeline,
    StableDiffusionXLImg2ImgPipeline,
    StableDiffusionXLInpaintPipeline,
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
from ..utils import DeviceConfig, SafetyMode, handle_safety, make_callback
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
    Translate configuration string dtype into actual torch dtype.
    """
    if not name:
        return fallback
    return _DTYPE_MAP.get(name.lower(), fallback)


class SDXLBackend(GenerationBackend):
    """
    Stable Diffusion XL backend with optional refiner support.

    Receives the same :class:`ModelManager` instance used by SD 1.5 so pipeline
    instances can be reused if both backends are active.
    """

    def __init__(
        self,
        config: ModelConfig,
        device_cfg: DeviceConfig,
        settings: GenerationSettings,
        safety_mode: SafetyMode,
        manager: ModelManager,
    ) -> None:
        super().__init__("sdxl", config, device_cfg, settings, safety_mode)
        self.manager = manager

    # region loading helpers
    def _load_text2img(self, cfg: PipelineConfig) -> StableDiffusionXLPipeline:
        """Instantiate the SDXL text-to-image pipeline."""
        pipe = StableDiffusionXLPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_img2img(self, cfg: PipelineConfig) -> StableDiffusionXLImg2ImgPipeline:
        """Instantiate the SDXL img2img pipeline."""
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_inpaint(self, cfg: PipelineConfig) -> StableDiffusionXLInpaintPipeline:
        """Instantiate the SDXL inpainting pipeline."""
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        if self.safety_mode == SafetyMode.OFF:
            pipe.safety_checker = None
        return pipe

    def _load_refiner(self, cfg: PipelineConfig) -> StableDiffusionXLImg2ImgPipeline:
        """Instantiate the SDXL refiner pipeline."""
        pipe = StableDiffusionXLImg2ImgPipeline.from_pretrained(
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
        """Instantiate the SD upscaler compatible with SDXL images."""
        pipe = StableDiffusionUpscalePipeline.from_pretrained(
            cfg.id,
            torch_dtype=_resolve_dtype(cfg.torch_dtype, self.device_cfg.torch_dtype),
            variant=cfg.variant,
            revision=cfg.revision,
            use_safetensors=True,
        )
        return pipe

    # endregion

    def _get_text2img_pipe(self) -> StableDiffusionXLPipeline:
        """Return (and cache) the SDXL text2img pipeline."""
        return self.manager.get_pipeline(
            ("sdxl", "text2img"),
            self.config.text2img,
            self._load_text2img,
        )

    def _get_img2img_pipe(self) -> StableDiffusionXLImg2ImgPipeline:
        """Return (and cache) the SDXL img2img pipeline."""
        cfg = self.config.img2img or self.config.text2img
        return self.manager.get_pipeline(
            ("sdxl", "img2img" if self.config.img2img else "text2img"),
            cfg,
            self._load_img2img,
        )

    def _get_inpaint_pipe(self) -> StableDiffusionXLInpaintPipeline:
        """Return (and cache) the SDXL inpainting pipeline."""
        if self.config.inpaint is None:
            raise RuntimeError("Inpaint pipeline not configured for SDXL.")
        return self.manager.get_pipeline(
            ("sdxl", "inpaint"),
            self.config.inpaint,
            self._load_inpaint,
        )

    def _get_refiner_pipe(self) -> Optional[StableDiffusionXLImg2ImgPipeline]:
        """Return (and cache) the optional SDXL refiner pipeline."""
        if self.config.refiner is None:
            return None
        return self.manager.get_pipeline(
            ("sdxl", "refiner"),
            self.config.refiner,
            self._load_refiner,
        )

    def _get_upscale_pipe(self) -> Optional[StableDiffusionUpscalePipeline]:
        """Return (and cache) the SDXL-compatible upscaler pipeline."""
        if self.config.upscale is None:
            return None
        return self.manager.get_pipeline(
            ("sdxl", "upscale"),
            self.config.upscale,
            self._load_upscale,
        )

    def _maybe_refine(
        self,
        images: List[torch.Tensor],
        prompt: str,
        negative_prompt: Optional[str],
        steps: int,
        guidance: float,
        generator: Optional[torch.Generator],
    ) -> List[torch.Tensor]:
        """
        Optionally run the refiner pipeline on latent outputs from the base model.

        Diffusers returns tensors when ``output_type="latent"``; the refiner
        converts them into final images.
        """
        refiner = self._get_refiner_pipe()
        if refiner is None:
            return images

        self.manager.set_scheduler(refiner, self.config.default_scheduler)
        with autocast_context(self.device_cfg):
            refined = refiner(
                prompt=prompt,
                negative_prompt=negative_prompt,
                image=images,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                denoising_start=0.8,
            )
        return list(refined.images)

    # region operations
    def text2img(self, params: Text2ImgParams) -> GenerationResult:
        """
        Run the text-to-image generation flow for SDXL with optional refiner pass.
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

        extra = dict(params.extra_options)
        refiner_enabled = params.refine and self.config.refiner is not None
        callback = make_callback(params.progress_cb, steps)

        if refiner_enabled:
            extra.setdefault("denoising_end", 0.8)
            extra["output_type"] = "latent"

        with autocast_context(self.device_cfg):
            result = pipe(
                prompt=params.prompt,
                negative_prompt=params.negative_prompt,
                num_inference_steps=steps,
                guidance_scale=guidance,
                generator=generator,
                num_images_per_prompt=params.num_images,
                callback=callback,
                **kwargs,
                **extra,
            )

        images = list(result.images)
        if refiner_enabled:
            images = self._maybe_refine(
                images,
                params.prompt,
                params.negative_prompt,
                steps=steps,
                guidance=guidance,
                generator=generator,
            )

        safety = handle_safety(
            self.safety_mode, getattr(result, "nsfw_content_detected", [])
        )
        metadata = {
            "steps": steps,
            "guidance_scale": guidance,
            "scheduler": exec_ctx["scheduler_name"],
            "width": kwargs["width"],
            "height": kwargs["height"],
            "refiner": refiner_enabled,
        }

        return self._finalize_result(
            start_time=exec_ctx["start_time"],
            images=images,
            seed=params.seed,
            model_id=self.config.text2img.id,
            metadata=metadata,
            safety=safety,
        )

    def img2img(self, params: Img2ImgParams) -> GenerationResult:
        """Run the img2img generation flow for SDXL."""
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

        safety = handle_safety(
            self.safety_mode, getattr(result, "nsfw_content_detected", [])
        )
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
        """Run the inpainting flow for SDXL."""
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

        safety = handle_safety(
            self.safety_mode, getattr(result, "nsfw_content_detected", [])
        )
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
        """Run the upscaling flow for SDXL or compatible SD upscaler."""
        pipe = self._get_upscale_pipe()
        if pipe is None:
            raise RuntimeError("Upscale pipeline is not configured for SDXL backend.")

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
            model_id=self.config.upscale.id if self.config.upscale else self.config.text2img.id,
            metadata=metadata,
        )

    # endregion
