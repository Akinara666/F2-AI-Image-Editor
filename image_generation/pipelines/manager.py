from __future__ import annotations

"""
Lazy-loading and caching layer for diffusers pipelines.

The goal of :class:`ModelManager` is to ensure that each pipeline (text2img,
img2img, etc.) is instantiated only once per backend and re-used across
requests.  This drastically reduces latency when the UI performs multiple
operations in quick succession.
"""

from typing import Any, Callable, Dict, Tuple

from diffusers import DiffusionPipeline

from ..config.settings import GenerationSettings, PipelineConfig
from ..utils import DeviceConfig, resolve_scheduler


class ModelManager:
    """
    Lazily loads and caches diffusers pipelines per configuration.

    The manager is stateful and therefore shared by all backends within a
    single :class:`ImageGenerationService` instance.
    """

    def __init__(self, settings: GenerationSettings, device_cfg: DeviceConfig) -> None:
        self.settings = settings
        self.device_cfg = device_cfg
        self._cache: Dict[Tuple[str, str], DiffusionPipeline] = {}

    def get_pipeline(
        self,
        cache_key: Tuple[str, str],
        config: PipelineConfig,
        factory: Callable[[PipelineConfig], DiffusionPipeline],
    ) -> DiffusionPipeline:
        """
        Retrieve a configured pipeline from the cache or instantiate it.

        Parameters
        ----------
        cache_key:
            Tuple uniquely identifying the pipeline (e.g. ``("sd15", "text2img")``).
        config:
            Pipeline configuration describing the model identifier and dtype.
        factory:
            Callable responsible for creating the pipeline when it is missing.
        """
        if cache_key in self._cache:
            return self._cache[cache_key]

        pipeline = factory(config)
        self._configure_pipeline(pipeline)
        self._cache[cache_key] = pipeline
        return pipeline

    def _configure_pipeline(self, pipeline: DiffusionPipeline) -> None:
        """
        Move the pipeline to the correct device and apply configured optimisations.

        The method is intentionally tolerant of missing methods so it can work
        across the different pipeline classes provided by diffusers.
        """
        if hasattr(pipeline, "to"):
            pipeline.to(self.device_cfg.device, torch_dtype=self.device_cfg.torch_dtype)

        if self.device_cfg.enable_xformers and hasattr(
            pipeline, "enable_xformers_memory_efficient_attention"
        ):
            try:
                pipeline.enable_xformers_memory_efficient_attention()
            except Exception:
                pass

        if self.device_cfg.enable_attention_slicing and hasattr(
            pipeline, "enable_attention_slicing"
        ):
            pipeline.enable_attention_slicing()

        if self.device_cfg.enable_sequential_cpu_offload and hasattr(
            pipeline, "enable_sequential_cpu_offload"
        ):
            pipeline.enable_sequential_cpu_offload()
        elif self.device_cfg.enable_model_cpu_offload and hasattr(
            pipeline, "enable_model_cpu_offload"
        ):
            pipeline.enable_model_cpu_offload()

        if self.device_cfg.enable_compile and hasattr(pipeline, "compile"):
            try:
                pipeline.compile()
            except Exception:
                pass

    def set_scheduler(self, pipeline: DiffusionPipeline, scheduler_name: str) -> None:
        """
        Swap the scheduler of an already instantiated pipeline.
        """
        scheduler_cls = resolve_scheduler(scheduler_name)
        pipeline.scheduler = scheduler_cls.from_config(pipeline.scheduler.config)

    def clear(self) -> None:
        """
        Free the cached pipelines.  Mainly useful for tests or graceful shutdown.
        """
        for pipe in self._cache.values():
            pipe.to("cpu")
            del pipe
        self._cache.clear()
