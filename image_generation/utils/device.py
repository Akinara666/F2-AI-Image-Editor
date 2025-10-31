from __future__ import annotations

"""
Helpers responsible for device resolution and autocast management.

All pipelines need to agree on the target device and dtype and therefore the
logic centralises device negotiation.  The :class:`DeviceConfig` dataclass is
constructed by :class:`~image_generation.services.generator.ImageGenerationService`
and handed to the pipeline backends so they can consistently apply the desired
optimisations.
"""

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Optional

import torch


_AUTOCast_MAP = {
    "fp32": torch.float32,
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
}


@dataclass(slots=True)
class DeviceConfig:
    """
    Immutable description of the device runtime environment.

    The configuration is shared between the :class:`ModelManager` and the
    specific backends so every pipeline is moved to the same device and uses
    consistent dtype/autocast preferences.
    """

    device: torch.device
    torch_dtype: torch.dtype
    autocast_precision: str = "fp16"
    enable_xformers: bool = False
    enable_attention_slicing: bool = False
    enable_sequential_cpu_offload: bool = False
    enable_model_cpu_offload: bool = False
    enable_compile: bool = False


def resolve_device(preferred: str = "auto") -> torch.device:
    """
    Resolve the device that should be used for inference.

    The function tries to honour the ``preferred`` hint while gracefully
    falling back to CPU when the requested accelerator is unavailable.  It is
    used during service initialisation and therefore runs eagerly at startup.
    """

    if preferred not in {"auto", "cuda", "cpu", "mps"}:
        raise ValueError(f"Unsupported device preference: {preferred}")

    if preferred == "cuda" or (preferred == "auto" and torch.cuda.is_available()):
        return torch.device("cuda")

    if preferred == "mps" or (preferred == "auto" and torch.backends.mps.is_available()):
        return torch.device("mps")

    return torch.device("cpu")


def get_autocast_dtype(precision: str) -> Optional[torch.dtype]:
    """
    Translate a human-friendly precision string into a torch dtype.

    Returns ``None`` when the precision is unknown so the caller can disable
    autocast and handle the situation gracefully without raising.
    """
    return _AUTOCast_MAP.get(precision.lower())


@contextmanager
def autocast_context(device_cfg: DeviceConfig):
    """
    Context manager that enables torch.autocast for the configured device.

    Pipelines wrap the diffusers call in this helper so they automatically
    benefit from mixed precision, matching the configuration supplied by the
    user.
    """
    dtype = get_autocast_dtype(device_cfg.autocast_precision)
    if dtype is None:
        yield
        return

    target = device_cfg.device.type
    cm = torch.autocast(device_type=target, dtype=dtype)
    with cm:
        yield
