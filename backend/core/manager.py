import torch
import gc
import asyncio
import logging
import re
import threading
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

class ModelManager:
    def __init__(self, device=settings.DEVICE, max_cache_size=settings.MAX_CACHED_MODELS):
        self.device = device
        self.pipelines_cache = OrderedDict()  # LRU cache: { cache_key: pipeline }
        self.max_cache_size = max_cache_size
        self.current_pipeline = None
        self.current_cache_key = None
        self.model_lock = asyncio.Lock()
        self.generation_lock = asyncio.Lock()
        self.active_request_id: Optional[str] = None
        self.cancel_requested = False
        self.active_pipeline = None
        self.cancelled_request_ids = set()
        self.logger = logging.getLogger("ModelManager")
        self.model_family_cache: dict[str, ModelFamily] = {}
        self.model_family_cache_lock = threading.Lock()

    def _generate_cache_key(self, model_id: str, model_family: ModelFamily, pipeline_type: str) -> str:
        return f"{model_family}::{model_id}::{pipeline_type}"

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
        torch_dtype = torch.float16 if self.device == "cuda" else torch.float32
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
            
        # Hard cleanup
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        self.logger.info("VRAM cleared.")

    async def get_model(
        self, 
        model_id: str, 
        model_family: Optional[ModelFamily] = None,
        pipeline_type: Literal["text2img", "img2img", "inpainting", "controlnet"] = "text2img",
        sampler_name: str = "Euler a",
        **kwargs
    ):
        """
        Retrieves the requested model. If it's different from the loaded one,
        swaps them out to save VRAM.
        """
        async with self.model_lock:
            resolved_model_family = self.infer_model_family(model_id, model_family)
            cache_key = self._generate_cache_key(model_id, resolved_model_family, pipeline_type)
            
            # Check if it is the EXACT same pipeline already active
            if self.current_cache_key == cache_key and self.current_pipeline is not None:
                return self.current_pipeline

            # Check if we have it cached in RAM
            if cache_key in self.pipelines_cache:
                self.logger.info(f"Retrieving model {cache_key} from RAM cache...")
                # Move to end (most recently used)
                self.pipelines_cache.move_to_end(cache_key)
                self.current_pipeline = self.pipelines_cache[cache_key]
                self.current_cache_key = cache_key
                self._apply_sampler(self.current_pipeline, sampler_name)
                return self.current_pipeline

            # We need to load it fresh
            self.logger.info(
                "Loading model freshly: model_id=%s family=%s pipeline_type=%s",
                model_id,
                resolved_model_family,
                pipeline_type,
            )
            
            try:
                is_single_file = model_id.endswith(".safetensors") or model_id.endswith(".ckpt")
                pipeline_class = self._get_pipeline_class(resolved_model_family, pipeline_type)
                load_arg_candidates = self._build_load_arg_candidates(model_id)

                # Helper to instantiate pipeline with specific args
                def create_pipeline(load_args, *, local_files_only: bool):
                    final_args = {**load_args}
                    if not is_single_file:
                        final_args["local_files_only"] = local_files_only
                    
                    if is_single_file:
                        # Use from_single_file for legacy/webui models
                        return pipeline_class.from_single_file(model_id, **final_args)
                    else: 
                        # Standard Diffusers loading
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
                                resolved_model_family,
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
                                resolved_model_family,
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

                # Optimize and handle VRAM
                try:
                    pipeline.enable_xformers_memory_efficient_attention()
                except Exception as e:
                    self.logger.warning(f"Could not enable xformers: {e}")

                # Enable CPU Offload to keep weights in RAM and move to VRAM dynamically
                if self.device == "cuda":
                    try:
                        pipeline.enable_model_cpu_offload()
                        self.logger.info("Enabled CPU offloading for model.")
                    except Exception as e:
                        self.logger.warning(f"Could not enable CPU offload ({e}). Moving to device mostly manually.")
                        pipeline.to(self.device)
                else:
                    pipeline.to(self.device)
                
                # Cache it (with LRU eviction)
                self._evict_if_needed()
                self.pipelines_cache[cache_key] = pipeline

                # Update state
                self.current_pipeline = pipeline
                self.current_cache_key = cache_key

                self._apply_sampler(self.current_pipeline, sampler_name)
                return self.current_pipeline

            except Exception as e:
                self.logger.error(f"Error loading model: {e}")
                self._unload_current_model() # Cleanup on failure
                raise e

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
        """Evict least-recently-used pipelines when cache exceeds max size."""
        while len(self.pipelines_cache) >= self.max_cache_size:
            evicted_key, evicted_pipeline = self.pipelines_cache.popitem(last=False)
            self.logger.info(f"Evicting LRU model from cache: {evicted_key}")
            if self.current_cache_key == evicted_key:
                self.current_pipeline = None
                self.current_cache_key = None
            del evicted_pipeline
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

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
