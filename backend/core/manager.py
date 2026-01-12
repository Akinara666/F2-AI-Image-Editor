import torch
import gc
import asyncio
from diffusers import (
    StableDiffusionPipeline, 
    StableDiffusionInpaintPipeline,
    ControlNetModel,
    StableDiffusionControlNetPipeline,
    AutoencoderKL
)
from typing import Optional, Literal

class ModelManager:
    def __init__(self, device="cuda"):
        self.device = device
        self.current_pipeline = None
        self.current_model_id = None
        self.current_type = None
        self.lock = asyncio.Lock() # Async lock for sequential GPU access

    def _unload_current_model(self):
        """Forcefully unloads the current model from VRAM."""
        if self.current_pipeline is not None:
            print(f"Unloading model: {self.current_model_id}")
            # Move to CPU first (optional, but helps detach) or just delete
            del self.current_pipeline
            self.current_pipeline = None
            self.current_model_id = None
            self.current_type = None
            
        # Hard cleanup
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        print("VRAM cleared.")

    async def get_model(
        self, 
        model_id: str, 
        pipeline_type: Literal["text2img", "inpainting", "controlnet"] = "text2img",
        **kwargs
    ):
        """
        Retrieves the requested model. If it's different from the loaded one,
        swaps them out to save VRAM.
        """
        async with self.lock:
            # Check if we already have this model loaded
            if (self.current_pipeline is not None and 
                self.current_model_id == model_id and 
                self.current_type == pipeline_type):
                return self.current_pipeline

            # Unload existing to free VRAM
            self._unload_current_model()

            print(f"Loading model: {model_id} ({pipeline_type})")
            
            try:
                # Basic optimizations: fp16, safetensors
                load_args = {
                    "torch_dtype": torch.float16,
                    "use_safetensors": True,
                    "variant": "fp16" # Common for many huggingface models
                }
                
                # Check for specific pipeline types
                # Check context for Single File loading
                if model_id.endswith(".safetensors") or model_id.endswith(".ckpt"):
                    # Use from_single_file for legacy/webui models
                    if pipeline_type == "inpainting":
                         # Inpainting implementation for single file might require specific config
                         pipeline = StableDiffusionInpaintPipeline.from_single_file(model_id, **load_args)
                    else:
                         pipeline = StableDiffusionPipeline.from_single_file(model_id, **load_args)
                
                else: 
                     # Standard Diffusers loading
                    if pipeline_type == "inpainting":
                        pipeline = StableDiffusionInpaintPipeline.from_pretrained(
                            model_id, 
                            **load_args
                        )
                    elif pipeline_type == "controlnet":
                        # Example logic for ControlNet - requires controlnet model path passed in kwargs
                        cnet_path = kwargs.get("controlnet_model_id", "lllyasviel/sd-controlnet-canny")
                        controlnet = ControlNetModel.from_pretrained(cnet_path, torch_dtype=torch.float16)
                        pipeline = StableDiffusionControlNetPipeline.from_pretrained(
                            model_id, 
                            controlnet=controlnet, 
                            **load_args
                        )
                    else:
                        # Default Text2Img / Img2Img shared pipeline
                        pipeline = StableDiffusionPipeline.from_pretrained(
                            model_id, 
                            **load_args
                        )

                # Enable xformers for speed/memory efficiency
                try:
                    pipeline.enable_xformers_memory_efficient_attention()
                except Exception as e:
                    print(f"Could not enable xformers: {e}")

                # Move to GPU
                pipeline.to(self.device)
                
                # Update state
                self.current_pipeline = pipeline
                self.current_model_id = model_id
                self.current_type = pipeline_type

                return self.current_pipeline

            except Exception as e:
                print(f"Error loading model: {e}")
                self._unload_current_model() # Cleanup on failure
                raise e

    def load_lora_weights(self, lora_path: str, adapter_name: str = "default"):
        """
        Architecture hook for LoRA. Wrapper around diffusers load_lora_weights.
        """
        if self.current_pipeline:
             print(f"Loading LoRA from {lora_path}")
             try:
                 self.current_pipeline.load_lora_weights(lora_path, adapter_name=adapter_name)
             except Exception as e:
                 print(f"Failed to load LoRA: {e}")

# Singleton instance
model_manager = ModelManager()
