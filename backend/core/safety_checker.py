"""Жёсткая проверка готовой картинки на NSFW.

Использует CLIP-классификатор Stable Diffusion (StableDiffusionSafetyChecker).
Это стандартный и сильный фильтр, но НЕ абсолютный: возможны пропуски и ложные
срабатывания. Поэтому политика — fail-closed: если классификатор недоступен,
вызывающий код обязан НЕ отдавать картинку (если NSFW не разрешён явно).
"""
import logging
import threading
from typing import Optional

import numpy as np
from PIL import Image

from core.config import settings

logger = logging.getLogger("SafetyChecker")


class NSFWSafetyChecker:
    def __init__(self, model_id: str):
        self._model_id = model_id
        self._checker = None
        self._processor = None
        self._load_failed = False
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._checker is not None or self._load_failed:
            return
        with self._lock:
            if self._checker is not None or self._load_failed:
                return
            try:
                from diffusers.pipelines.stable_diffusion.safety_checker import (
                    StableDiffusionSafetyChecker,
                )
                from transformers import CLIPImageProcessor

                self._processor = CLIPImageProcessor.from_pretrained(self._model_id)
                checker = StableDiffusionSafetyChecker.from_pretrained(self._model_id)
                checker.eval()
                self._checker = checker
                logger.info("NSFW safety checker loaded: %s", self._model_id)
            except Exception as e:
                self._load_failed = True
                logger.error("Failed to load NSFW safety checker (%s): %s", self._model_id, e)

    def is_available(self) -> bool:
        self._ensure_loaded()
        return self._checker is not None

    def is_nsfw(self, image: Image.Image) -> Optional[bool]:
        """True — NSFW, False — безопасно, None — классификатор недоступен."""
        self._ensure_loaded()
        if self._checker is None:
            return None
        try:
            import torch

            rgb = image.convert("RGB")
            clip_input = self._processor(images=rgb, return_tensors="pt").pixel_values
            np_image = (np.asarray(rgb).astype(np.float32) / 255.0)[None, ...]
            with torch.no_grad():
                _, has_nsfw_concepts = self._checker(clip_input=clip_input, images=np_image)
            return bool(has_nsfw_concepts[0])
        except Exception as e:
            logger.error("NSFW check failed: %s", e)
            return None


nsfw_safety_checker = NSFWSafetyChecker(settings.NSFW_SAFETY_CHECKER_MODEL)
