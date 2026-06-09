import torch
import gc
import asyncio
import logging
import re
import threading
from dataclasses import dataclass
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path
from diffusers import (
    StableDiffusionPipeline, 
    StableDiffusionImg2ImgPipeline,
    StableDiffusionInpaintPipeline,
    StableDiffusionXLPipeline,
    StableDiffusionXLImg2ImgPipeline,
    StableDiffusionXLInpaintPipeline,
    ControlNetModel,
    StableDiffusionControlNetPipeline,
    EulerAncestralDiscreteScheduler,
    EulerDiscreteScheduler,
    DPMSolverMultistepScheduler,
    DDIMScheduler,
    LMSDiscreteScheduler,
    DPMSolverSDEScheduler,
    KDPM2AncestralDiscreteScheduler,
    HeunDiscreteScheduler,
    UniPCMultistepScheduler,
    DDPMScheduler
)
from typing import Optional, Literal

from core.config import settings

ModelFamily = Literal["sd", "sdxl"]
PipelineType = Literal["text2img", "img2img", "inpainting", "controlnet"]


@dataclass
class ModelBundle:
    cache_key: str
    model_id: str
    model_family: ModelFamily
    anchor_pipeline_type: PipelineType
    anchor_pipeline: object
    torch_dtype: torch.dtype
    uses_cpu_offload: bool

class ModelManager:
    def __init__(self, device=settings.DEVICE, max_cache_size=settings.MAX_CACHED_MODELS):
        self.device = device
        self.sd_enable_cpu_offload = settings.SD_ENABLE_CPU_OFFLOAD
        self.sd_enable_xformers = settings.SD_ENABLE_XFORMERS
        self.model_bundles_cache = OrderedDict()  # LRU cache: { bundle_key: ModelBundle }
        self.max_cache_size = max_cache_size
        self.current_pipeline = None
        self.current_cache_key = None
        self.current_model_cache_key = None
        self.model_lock = asyncio.Lock()
        self.generation_lock = asyncio.Lock()
        self.active_request_id: Optional[str] = None
        self.cancel_requested = False
        self.active_pipeline = None
        self.cancelled_request_ids = set()
        self.logger = logging.getLogger("ModelManager")
        self.model_family_cache: dict[str, ModelFamily] = {}
        self.model_family_cache_lock = threading.Lock()
        # accelerate installs CPU-offload hooks on the module objects themselves.
        # Pipelines built via from_pipe() share those modules, so only one
        # pipeline may own the offload hooks at a time. Track the current owner
        # to hand ownership over cleanly instead of stacking conflicting hooks.
        self._offload_hook_owner = None
        self._configure_tf32()

    def _configure_tf32(self):
        """Allow TF32 tensor-core math for fp32 ops (Ampere+); harmless elsewhere."""
        if self.device != "cuda" or not settings.SD_ALLOW_TF32:
            return
        try:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            self.logger.info("Enabled TF32 matmul/cudnn for faster fp32 ops on Ampere+ GPUs.")
        except Exception as e:
            self.logger.warning("Could not enable TF32: %s", e)

    @staticmethod
    def _generate_model_cache_key(
        model_id: str,
        model_family: ModelFamily,
        pipeline_type: PipelineType,
        controlnet_model_id: Optional[str] = None,
    ) -> str:
        if pipeline_type == "controlnet":
            resolved_controlnet_id = controlnet_model_id or "lllyasviel/sd-controlnet-canny"
            return f"{model_family}::{model_id}::controlnet::{resolved_controlnet_id}"
        return f"{model_family}::{model_id}"

    @staticmethod
    def _generate_runtime_cache_key(model_cache_key: str, pipeline_type: PipelineType) -> str:
        return f"{model_cache_key}::{pipeline_type}"

    def _get_default_torch_dtype(self) -> torch.dtype:
        override = settings.SD_TORCH_DTYPE
        if override in {"fp32", "float32"}:
            return torch.float32
        if override in {"fp16", "float16", "half"}:
            return torch.float16
        if override in {"bf16", "bfloat16"}:
            return torch.bfloat16

        # auto: bf16 shares fp32's exponent range, so it avoids the fp16 overflow
        # that yields black/NaN VAE output. Use it where natively accelerated
        # (Ampere+, sm_80+); fall back to fp16 on older GPUs and fp32 on CPU.
        if self.device != "cuda":
            return torch.float32
        try:
            if torch.cuda.is_available() and torch.cuda.get_device_capability(0)[0] >= 8:
                return torch.bfloat16
        except Exception as e:
            self.logger.warning("Could not query GPU capability for dtype selection: %s", e)
        return torch.float16

    @staticmethod
    def _normalize_model_family(model_family: Optional[str]) -> Optional[ModelFamily]:
        if model_family is None:
            return None

        normalized_family = model_family.strip().lower()
        if normalized_family in {"sd", "sdxl"}:
            return normalized_family
        return None

    @staticmethod
    def _infer_model_family_from_name(model_id: str) -> ModelFamily:
        path_name = Path(model_id).name.lower()
        lowered = model_id.lower()
        sdxl_hints = (
            "stable-diffusion-xl",
            "sdxl",
            "juggernautxl",
            "realvisxl",
            "xl-base",
            "xl_inpaint",
            "xl-turbo",
            "pony",
        )
        if any(hint in lowered for hint in sdxl_hints):
            return "sdxl"
        if re.search(r"(^|[-_.\s])xl([-. _\s]|$)", path_name):
            return "sdxl"
        return "sd"

    @staticmethod
    def _infer_model_family_from_safetensors_metadata(metadata: Optional[dict[str, str]]) -> Optional[ModelFamily]:
        if not metadata:
            return None

        normalized_entries = [
            f"{str(key).strip().lower()}={str(value).strip().lower()}"
            for key, value in metadata.items()
            if value is not None
        ]
        metadata_blob = " | ".join(normalized_entries)
        sdxl_hints = (
            "stable-diffusion-xl",
            "sdxl",
            "sd_xl_base_1.0",
            "sd_xl_refiner_1.0",
            "modelspec.architecture=stable-diffusion-xl",
        )
        if any(hint in metadata_blob for hint in sdxl_hints):
            return "sdxl"

        sd_hints = (
            "stable-diffusion-v1",
            "stable-diffusion-v2",
            "stable-diffusion-2",
        )
        if any(hint in metadata_blob for hint in sd_hints):
            return "sd"
        return None

    @staticmethod
    def _infer_model_family_from_safetensors_keys(keys: list[str]) -> Optional[ModelFamily]:
        sdxl_prefixes = (
            "text_encoder_2.",
            "conditioner.embedders.1.",
            "conditioner.embedders.2.",
        )
        sdxl_fragments = (
            ".text_projection",
            ".add_embedding.",
        )
        if any(key.startswith(sdxl_prefixes) for key in keys):
            return "sdxl"
        if any(
            key.startswith("conditioner.embedders.")
            and any(fragment in key for fragment in sdxl_fragments)
            for key in keys
        ):
            return "sdxl"
        if any(key.startswith("cond_stage_model.") for key in keys):
            return "sd"
        if any(key.startswith("text_encoder.") for key in keys):
            return "sd"
        return None

    def _infer_model_family_from_safetensors_file(self, model_path: Path) -> Optional[ModelFamily]:
        try:
            from safetensors import safe_open
        except Exception as exc:
            self.logger.warning("safetensors inspection unavailable for %s: %s", model_path, exc)
            return None

        try:
            with safe_open(str(model_path), framework="pt", device="cpu") as safetensor_file:
                metadata_family = self._infer_model_family_from_safetensors_metadata(safetensor_file.metadata())
                if metadata_family is not None:
                    self.logger.info(
                        "Detected model family from safetensors metadata: path=%s family=%s",
                        model_path,
                        metadata_family,
                    )
                    return metadata_family

                keys = list(safetensor_file.keys())
                key_family = self._infer_model_family_from_safetensors_keys(keys)
                if key_family is not None:
                    self.logger.info(
                        "Detected model family from safetensors keys: path=%s family=%s",
                        model_path,
                        key_family,
                    )
                    return key_family
        except Exception as exc:
            self.logger.warning("Failed to inspect safetensors model %s: %s", model_path, exc)
            return None

        return None

    def infer_model_family(self, model_id: str, model_family: Optional[str] = None) -> ModelFamily:
        normalized_family = self._normalize_model_family(model_family)
        if normalized_family is not None:
            return normalized_family

        path = Path(model_id)
        cache_key = str(path.resolve()) if path.is_absolute() or path.exists() else model_id

        with self.model_family_cache_lock:
            cached_family = self.model_family_cache.get(cache_key)
        if cached_family is not None:
            return cached_family

        inferred_family: Optional[ModelFamily] = None
        if path.suffix.lower() == ".safetensors" and path.exists():
            inferred_family = self._infer_model_family_from_safetensors_file(path)

        resolved_family = inferred_family or self._infer_model_family_from_name(model_id)
        with self.model_family_cache_lock:
            self.model_family_cache[cache_key] = resolved_family
        return resolved_family

    @staticmethod
    def _get_pipeline_class(model_family: ModelFamily, pipeline_type: str):
        if model_family == "sdxl":
            if pipeline_type == "inpainting":
                return StableDiffusionXLInpaintPipeline
            if pipeline_type == "img2img":
                return StableDiffusionXLImg2ImgPipeline
            if pipeline_type == "controlnet":
                raise NotImplementedError("SDXL ControlNet pipeline is not implemented yet.")
            return StableDiffusionXLPipeline

        if pipeline_type == "inpainting":
            return StableDiffusionInpaintPipeline
        if pipeline_type == "img2img":
            return StableDiffusionImg2ImgPipeline
        if pipeline_type == "controlnet":
            return StableDiffusionControlNetPipeline
        return StableDiffusionPipeline

    def _build_load_arg_candidates(self, model_id: str) -> list[dict[str, object]]:
        torch_dtype = self._get_default_torch_dtype()
        lower_model_id = model_id.lower()
        base_args: dict[str, object] = {
            "torch_dtype": torch_dtype,
        }
        if not lower_model_id.endswith(".ckpt"):
            base_args["use_safetensors"] = True
        if self.device == "cuda":
            base_args["variant"] = "fp16"

        candidates = [base_args]
        if "variant" in base_args:
            candidates.append({key: value for key, value in base_args.items() if key != "variant"})
        return candidates

    def _free_cuda_memory(self):
        """Return freed blocks to the OS/allocator without touching pipeline state."""
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()

    @staticmethod
    def _is_cuda_oom(exc: BaseException) -> bool:
        oom_type = getattr(torch.cuda, "OutOfMemoryError", None)
        if oom_type is not None and isinstance(exc, oom_type):
            return True
        return isinstance(exc, RuntimeError) and "out of memory" in str(exc).lower()

    def _clear_all_cached_bundles(self):
        """Drop every cached bundle and reclaim VRAM (used to recover from OOM)."""
        self.logger.warning("Dropping all cached model bundles to reclaim VRAM.")
        self.model_bundles_cache.clear()
        self.current_pipeline = None
        self.current_cache_key = None
        self.current_model_cache_key = None
        self._offload_hook_owner = None
        self._free_cuda_memory()

    def _unload_current_model(self):
        """No longer fully unloads by default. Models are managed by cpu_offload.
        This method is kept for explicit hard resets if needed.
        """
        self.logger.info("Hard VRAM clear requested.")
        if self.current_pipeline is not None:
            # We don't delete the pipeline if it's in the cache,
            # we just let cpu_offload handle VRAM.
            # If we wanted to really delete it:
            # del self.current_pipeline
            self.current_pipeline = None
            self.current_cache_key = None
            self.current_model_cache_key = None

        # Hard cleanup
        self._free_cuda_memory()
        self.logger.info("VRAM cleared.")

    async def get_model(
        self, 
        model_id: str, 
        model_family: Optional[ModelFamily] = None,
        pipeline_type: PipelineType = "text2img",
        sampler_name: str = "Euler a",
        **kwargs
    ):
        """
        Retrieves the requested model. If it's different from the loaded one,
        swaps them out to save VRAM.
        """
        async with self.model_lock:
            resolved_model_family = self.infer_model_family(model_id, model_family)
            model_cache_key = self._generate_model_cache_key(
                model_id,
                resolved_model_family,
                pipeline_type,
                kwargs.get("controlnet_model_id"),
            )
            runtime_cache_key = self._generate_runtime_cache_key(model_cache_key, pipeline_type)
            
            # Check if it is the EXACT same pipeline already active
            if self.current_cache_key == runtime_cache_key and self.current_pipeline is not None:
                self.logger.info(
                    "Reusing active runtime pipeline without rematerialization: runtime=%s model=%s family=%s",
                    runtime_cache_key,
                    model_id,
                    resolved_model_family,
                )
                self._apply_sampler(self.current_pipeline, sampler_name)
                return self.current_pipeline

            # Two attempts: if the first fails with CUDA OOM we drop every cached
            # bundle to free VRAM and retry once with a clean slate.
            for attempt in range(2):
                try:
                    bundle = self.model_bundles_cache.get(model_cache_key)
                    if bundle is not None:
                        self.logger.info(
                            "Model bundle cache hit: bundle=%s requested_pipeline=%s anchor=%s offload=%s",
                            model_cache_key,
                            pipeline_type,
                            bundle.anchor_pipeline_type,
                            bundle.uses_cpu_offload,
                        )
                        self.model_bundles_cache.move_to_end(model_cache_key)
                    else:
                        self.logger.info(
                            "Model bundle cache miss. Loading fresh bundle: model_id=%s family=%s anchor_pipeline_type=%s",
                            model_id,
                            resolved_model_family,
                            pipeline_type,
                        )
                        bundle = self._load_model_bundle(
                            model_id=model_id,
                            model_family=resolved_model_family,
                            pipeline_type=pipeline_type,
                            cache_key=model_cache_key,
                            **kwargs,
                        )
                        self._evict_if_needed()
                        self.model_bundles_cache[model_cache_key] = bundle

                    pipeline = self._materialize_pipeline(bundle, pipeline_type)
                    self._activate_pipeline_for_runtime(bundle, pipeline, runtime_cache_key)

                    self.current_pipeline = pipeline
                    self.current_cache_key = runtime_cache_key
                    self.current_model_cache_key = model_cache_key

                    self.logger.info(
                        "Runtime pipeline ready: runtime=%s bundle=%s anchor=%s requested=%s offload=%s",
                        runtime_cache_key,
                        model_cache_key,
                        bundle.anchor_pipeline_type,
                        pipeline_type,
                        bundle.uses_cpu_offload,
                    )
                    self._apply_sampler(self.current_pipeline, sampler_name)
                    return self.current_pipeline
                except Exception as e:
                    if attempt == 0 and self._is_cuda_oom(e):
                        self.logger.warning(
                            "CUDA out of memory while loading model (attempt 1/2). "
                            "Dropping all cached bundles and retrying once: %s",
                            e,
                        )
                        self._clear_all_cached_bundles()
                        continue
                    self.logger.error(f"Error loading model: {e}")
                    # A non-OOM failure (or OOM even after clearing) happens before
                    # current_pipeline is reassigned, so the previously active
                    # pipeline (if any) is still valid and cached. Only reclaim
                    # leaked CUDA memory; do not wipe the working pipeline pointers.
                    self._free_cuda_memory()
                    raise e

    def _load_model_bundle(
        self,
        *,
        model_id: str,
        model_family: ModelFamily,
        pipeline_type: PipelineType,
        cache_key: str,
        **kwargs,
    ) -> ModelBundle:
        is_single_file = model_id.endswith(".safetensors") or model_id.endswith(".ckpt")
        pipeline_class = self._get_pipeline_class(model_family, pipeline_type)
        load_arg_candidates = self._build_load_arg_candidates(model_id)
        preferred_torch_dtype = self._get_default_torch_dtype()

        def create_pipeline(load_args, *, local_files_only: bool):
            final_args = {**load_args}
            if not is_single_file:
                final_args["local_files_only"] = local_files_only

            if is_single_file:
                return pipeline_class.from_single_file(model_id, **final_args)

            if pipeline_type == "controlnet":
                cnet_path = kwargs.get("controlnet_model_id", "lllyasviel/sd-controlnet-canny")
                controlnet = ControlNetModel.from_pretrained(
                    cnet_path,
                    torch_dtype=load_args["torch_dtype"],
                )
                return pipeline_class.from_pretrained(model_id, controlnet=controlnet, **final_args)

            return pipeline_class.from_pretrained(model_id, **final_args)

        pipeline = None
        load_errors = []
        for local_files_only in ((True, False) if not is_single_file else (True,)):
            for load_args in load_arg_candidates:
                try:
                    self.logger.info(
                        "Attempting model load: model_id=%s family=%s pipeline_type=%s local_only=%s variant=%s dtype=%s",
                        model_id,
                        model_family,
                        pipeline_type,
                        local_files_only,
                        load_args.get("variant", "<default>"),
                        load_args["torch_dtype"],
                    )
                    pipeline = create_pipeline(load_args, local_files_only=local_files_only)
                    break
                except Exception as e:
                    load_errors.append(str(e))
                    self.logger.info(
                        "Model load attempt failed: model_id=%s family=%s pipeline_type=%s local_only=%s variant=%s error=%s",
                        model_id,
                        model_family,
                        pipeline_type,
                        local_files_only,
                        load_args.get("variant", "<default>"),
                        e,
                    )
            if pipeline is not None:
                break

        if pipeline is None:
            raise RuntimeError(
                "All model load attempts failed. Last errors: "
                + " | ".join(load_errors[-4:])
            )

        # torch SDPA is the diffusers default on torch>=2.0 and gives
        # memory-efficient attention for free, so xformers is opt-in only.
        if self.sd_enable_xformers:
            try:
                pipeline.enable_xformers_memory_efficient_attention()
                self.logger.info("Enabled xformers memory-efficient attention for bundle %s.", cache_key)
            except Exception as e:
                self.logger.warning(f"Could not enable xformers ({e}); relying on torch SDPA.")
                # In the low-VRAM regime fall back to attention slicing; otherwise
                # SDPA already caps the attention memory without the speed cost.
                if self.sd_enable_cpu_offload:
                    try:
                        pipeline.enable_attention_slicing()
                        self.logger.info("Enabled attention slicing fallback for bundle %s.", cache_key)
                    except Exception as slice_error:
                        self.logger.warning(f"Could not enable attention slicing: {slice_error}")
        else:
            self.logger.info("xformers disabled; using torch SDPA attention for bundle %s.", cache_key)

        # VAE slicing/tiling cap the peak VRAM of the decode step (the spike is
        # most pronounced for SDXL and large / outpainting canvases). They are
        # effectively free for typical sizes and degrade gracefully if absent.
        for vae_optimization in ("enable_vae_slicing", "enable_vae_tiling"):
            enable_fn = getattr(pipeline, vae_optimization, None)
            if enable_fn is None:
                continue
            try:
                enable_fn()
            except Exception as e:
                self.logger.warning("Could not %s for bundle %s: %s", vae_optimization, cache_key, e)

        uses_cpu_offload = False
        if self.device == "cuda":
            if self.sd_enable_cpu_offload:
                try:
                    self._enable_model_cpu_offload(pipeline)
                    uses_cpu_offload = True
                    self.logger.info("Enabled CPU offloading for model bundle %s.", cache_key)
                except Exception as e:
                    self.logger.warning(f"Could not enable CPU offload ({e}). Moving to device mostly manually.")
                    pipeline.to(self.device)
            else:
                self.logger.info(
                    "CPU offload disabled for SD bundle %s via SD_ENABLE_CPU_OFFLOAD=false. Keeping pipeline on %s.",
                    cache_key,
                    self.device,
                )
                pipeline.to(self.device)
        else:
            self.logger.info("Running SD bundle %s on CPU without model offload.", cache_key)
            pipeline.to(self.device)

        return ModelBundle(
            cache_key=cache_key,
            model_id=model_id,
            model_family=model_family,
            anchor_pipeline_type=pipeline_type,
            anchor_pipeline=pipeline,
            torch_dtype=preferred_torch_dtype,
            uses_cpu_offload=uses_cpu_offload,
        )

    def _materialize_pipeline(self, bundle: ModelBundle, pipeline_type: PipelineType):
        if pipeline_type == bundle.anchor_pipeline_type:
            self.logger.info(
                "Using anchor pipeline directly: bundle=%s pipeline_type=%s",
                bundle.cache_key,
                pipeline_type,
            )
            return bundle.anchor_pipeline

        if bundle.anchor_pipeline_type == "controlnet" or pipeline_type == "controlnet":
            raise RuntimeError("ControlNet pipelines are not shareable with non-ControlNet modes.")

        pipeline_class = self._get_pipeline_class(bundle.model_family, pipeline_type)
        self.logger.info(
            "Creating runtime pipeline variant from shared bundle: bundle=%s anchor=%s target=%s",
            bundle.cache_key,
            bundle.anchor_pipeline_type,
            pipeline_type,
        )
        return pipeline_class.from_pipe(bundle.anchor_pipeline, torch_dtype=bundle.torch_dtype)

    def _enable_model_cpu_offload(self, pipeline) -> None:
        """Hand CPU-offload hook ownership to ``pipeline``.

        Frees the hooks held by the previous owner first so that modules shared
        through from_pipe() are never hooked by two pipelines at once (which
        leaves accelerate confused about device placement).
        """
        previous_owner = self._offload_hook_owner
        if previous_owner is not None and previous_owner is not pipeline:
            remove_hooks = getattr(previous_owner, "remove_all_hooks", None)
            if remove_hooks is not None:
                try:
                    remove_hooks()
                except Exception as e:
                    self.logger.warning("Could not remove offload hooks from previous owner: %s", e)
        pipeline.enable_model_cpu_offload()
        self._offload_hook_owner = pipeline

    def _activate_pipeline_for_runtime(self, bundle: ModelBundle, pipeline, runtime_cache_key: str) -> None:
        if self.current_cache_key == runtime_cache_key and self.current_pipeline is pipeline:
            return

        if bundle.uses_cpu_offload and self.device == "cuda":
            if self._offload_hook_owner is pipeline:
                self.logger.info("Pipeline %s already owns CPU offload hooks.", runtime_cache_key)
                return
            try:
                self._enable_model_cpu_offload(pipeline)
                self.logger.info("Re-activated CPU offload hooks for pipeline %s", runtime_cache_key)
            except Exception as e:
                self.logger.warning(
                    "Could not re-activate CPU offload for pipeline %s (%s). Falling back to pipeline.to(%s).",
                    runtime_cache_key,
                    e,
                    self.device,
                )
                pipeline.to(self.device)
        elif self.device != "cuda":
            pipeline.to(self.device)
        else:
            self.logger.info(
                "Runtime pipeline %s stays resident on %s because SD CPU offload is disabled.",
                runtime_cache_key,
                self.device,
            )

    @asynccontextmanager
    async def generation_session(self, request_id: str):
        await self.generation_lock.acquire()
        self.active_request_id = request_id
        self.cancel_requested = request_id in self.cancelled_request_ids
        self.active_pipeline = None
        self.logger.info("Generation session started: request_id=%s", request_id)
        try:
            yield
        finally:
            if self.active_pipeline is not None:
                try:
                    self.active_pipeline._interrupt = False
                except Exception:
                    pass
            self.active_pipeline = None
            self.cancel_requested = False
            self.active_request_id = None
            self.cancelled_request_ids.discard(request_id)
            self.generation_lock.release()
            self.logger.info("Generation session finished: request_id=%s", request_id)

    def bind_active_pipeline(self, request_id: str, pipeline) -> None:
        if self.active_request_id != request_id:
            raise RuntimeError(f"Cannot bind pipeline for inactive request: {request_id}")

        self.active_pipeline = pipeline
        try:
            pipeline._interrupt = self.cancel_requested
        except Exception:
            pass

    def is_cancel_requested(self, request_id: str) -> bool:
        if self.active_request_id == request_id:
            return self.cancel_requested or request_id in self.cancelled_request_ids
        return request_id in self.cancelled_request_ids

    def request_cancel(self, request_id: str) -> bool:
        self.cancelled_request_ids.add(request_id)
        if self.active_request_id == request_id:
            self.cancel_requested = True
            if self.active_pipeline is not None:
                try:
                    self.active_pipeline._interrupt = True
                except Exception:
                    pass
            self.logger.info("Cancellation requested for active request_id=%s", request_id)
        else:
            self.logger.info("Cancellation queued for request_id=%s", request_id)
        return True

    def _evict_if_needed(self):
        """Evict least-recently-used model bundles when cache exceeds max size."""
        while len(self.model_bundles_cache) >= self.max_cache_size:
            evicted_key, evicted_bundle = self.model_bundles_cache.popitem(last=False)
            self.logger.info(f"Evicting LRU model bundle from cache: {evicted_key}")
            if self.current_model_cache_key == evicted_key:
                self.current_pipeline = None
                self.current_cache_key = None
                self.current_model_cache_key = None
                # The active pipeline (offload owner) belonged to this bundle.
                self._offload_hook_owner = None
            if self._offload_hook_owner is evicted_bundle.anchor_pipeline:
                self._offload_hook_owner = None
            del evicted_bundle
            self._free_cuda_memory()

    def _apply_sampler(self, pipeline, sampler_name: str):
        """Applies the requested sampler to the pipeline."""
        self.logger.info(f"Applying scheduler: {sampler_name}")
        try:
            if sampler_name == "Euler a":
                pipeline.scheduler = EulerAncestralDiscreteScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "Euler":
                pipeline.scheduler = EulerDiscreteScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "DPM++ 2M Karras":
                pipeline.scheduler = DPMSolverMultistepScheduler.from_config(pipeline.scheduler.config, use_karras_sigmas=True)
            elif sampler_name == "DPM++ 2S a Karras":
                pipeline.scheduler = DPMSolverMultistepScheduler.from_config(pipeline.scheduler.config, use_karras_sigmas=True, algorithm_type="sde-dpmsolver++")
            elif sampler_name == "DPM++ SDE Karras":
                pipeline.scheduler = DPMSolverSDEScheduler.from_config(pipeline.scheduler.config, use_karras_sigmas=True)
            elif sampler_name == "DPM2 a Karras":
                pipeline.scheduler = KDPM2AncestralDiscreteScheduler.from_config(pipeline.scheduler.config, use_karras_sigmas=True)
            elif sampler_name == "DDIM":
                pipeline.scheduler = DDIMScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "DDPM":
                pipeline.scheduler = DDPMScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "Heun":
                pipeline.scheduler = HeunDiscreteScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "UniPC":
                pipeline.scheduler = UniPCMultistepScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "LMS":
                pipeline.scheduler = LMSDiscreteScheduler.from_config(pipeline.scheduler.config)
        except Exception as e:
            self.logger.warning(f"Could not apply sampler {sampler_name}: {e}")

# Singleton instance
model_manager = ModelManager()
