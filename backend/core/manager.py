import torch
import gc
import asyncio
import logging
from diffusers import (
    StableDiffusionPipeline, 
    StableDiffusionImg2ImgPipeline,
    StableDiffusionInpaintPipeline,
    ControlNetModel,
    StableDiffusionControlNetPipeline,
    EulerAncestralDiscreteScheduler,
    EulerDiscreteScheduler,
    DPMSolverMultistepScheduler,
    DDIMScheduler,
    LMSDiscreteScheduler
)
from typing import Optional, Literal

from core.config import settings

class ModelManager:
    def __init__(self, device=settings.DEVICE):
        self.device = device
        self.pipelines_cache = {} # Cache for loaded pipelines: { cache_key: pipeline }
        self.current_pipeline = None
        self.current_cache_key = None
        self.lock = asyncio.Lock() # Async lock for sequential GPU access
        self.logger = logging.getLogger("ModelManager")

    def _generate_cache_key(self, model_id: str, pipeline_type: str) -> str:
        return f"{model_id}::{pipeline_type}"

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
        pipeline_type: Literal["text2img", "img2img", "inpainting", "controlnet"] = "text2img",
        sampler_name: str = "Euler a",
        **kwargs
    ):
        """
        Retrieves the requested model. If it's different from the loaded one,
        swaps them out to save VRAM.
        """
        async with self.lock:
            cache_key = self._generate_cache_key(model_id, pipeline_type)
            
            # Check if it is the EXACT same pipeline already active
            if self.current_cache_key == cache_key and self.current_pipeline is not None:
                return self.current_pipeline

            # Check if we have it cached in RAM
            if cache_key in self.pipelines_cache:
                self.logger.info(f"Retrieving model {cache_key} from RAM cache...")
                self.current_pipeline = self.pipelines_cache[cache_key]
                self.current_cache_key = cache_key
                self._apply_sampler(self.current_pipeline, sampler_name)
                return self.current_pipeline

            # We need to load it fresh
            self.logger.info(f"Loading model freshly: {model_id} ({pipeline_type})")
            
            try:
                # Basic optimizations: fp16, safetensors
                load_args = {
                    "torch_dtype": torch.float16,
                    "use_safetensors": True,
                    "variant": "fp16", # Common for many huggingface models
                }
                
                
                # Helper to instantiate pipeline with specific args
                def create_pipeline(args_override):
                    final_args = {**load_args, **args_override}
                    
                    if model_id.endswith(".safetensors") or model_id.endswith(".ckpt"):
                        # Use from_single_file for legacy/webui models
                        if pipeline_type == "inpainting":
                             return StableDiffusionInpaintPipeline.from_single_file(model_id, **final_args)
                        elif pipeline_type == "img2img":
                             return StableDiffusionImg2ImgPipeline.from_single_file(model_id, **final_args)
                        else:
                             return StableDiffusionPipeline.from_single_file(model_id, **final_args)
                    else: 
                         # Standard Diffusers loading
                        if pipeline_type == "inpainting":
                            return StableDiffusionInpaintPipeline.from_pretrained(model_id, **final_args)
                        elif pipeline_type == "img2img":
                            return StableDiffusionImg2ImgPipeline.from_pretrained(model_id, **final_args)
                        elif pipeline_type == "controlnet":
                            cnet_path = kwargs.get("controlnet_model_id", "lllyasviel/sd-controlnet-canny")
                            controlnet = ControlNetModel.from_pretrained(cnet_path, torch_dtype=torch.float16)
                            return StableDiffusionControlNetPipeline.from_pretrained(model_id, controlnet=controlnet, **final_args)
                        else:
                            return StableDiffusionPipeline.from_pretrained(model_id, **final_args)

                # ATTEMPT 1: Load Offline
                try:
                    self.logger.info("Attempting to load model from local cache...")
                    pipeline = create_pipeline({"local_files_only": True})
                except Exception as e:
                    self.logger.info(f"Local load failed ({e}). Attempting to download...")
                    # ATTEMPT 2: Load Online
                    pipeline = create_pipeline({"local_files_only": False})

                # Optimize and handle VRAM
                try:
                    pipeline.enable_xformers_memory_efficient_attention()
                except Exception as e:
                    self.logger.warning(f"Could not enable xformers: {e}")

                # Enable CPU Offload to keep weights in RAM and move to VRAM dynamically
                try:
                    pipeline.enable_model_cpu_offload()
                    self.logger.info("Enabled CPU offloading for model.")
                except Exception as e:
                    self.logger.warning(f"Could not enable CPU offload ({e}). Moving to device mostly manually.")
                    pipeline.to(self.device)
                
                # Cache it
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
            elif sampler_name == "DDIM":
                pipeline.scheduler = DDIMScheduler.from_config(pipeline.scheduler.config)
            elif sampler_name == "LMS":
                pipeline.scheduler = LMSDiscreteScheduler.from_config(pipeline.scheduler.config)
        except Exception as e:
            self.logger.warning(f"Could not apply sampler {sampler_name}: {e}")

    def load_lora_weights(self, lora_path: str, adapter_name: str = "default"):
        """
        Architecture hook for LoRA. Wrapper around diffusers load_lora_weights.
        """
        if self.current_pipeline:
             self.logger.info(f"Loading LoRA from {lora_path}")
             try:
                 self.current_pipeline.load_lora_weights(lora_path, adapter_name=adapter_name)
             except Exception as e:
                 self.logger.error(f"Failed to load LoRA: {e}")

# Singleton instance
model_manager = ModelManager()
