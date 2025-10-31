from __future__ import annotations

"""
Utility to convert scheduler names used in YAML configuration into diffusers
classes.

Having a central mapping allows non-technical configuration authors to pick a
scheduler by name while the code still works with the actual class objects.
"""

from typing import Dict, Type

from diffusers import (
    DDIMScheduler,
    DPMSolverMultistepScheduler,
    DPMSolverSinglestepScheduler,
    EulerAncestralDiscreteScheduler,
    EulerDiscreteScheduler,
    HeunDiscreteScheduler,
    LMSDiscreteScheduler,
    PNDMScheduler,
    UniPCMultistepScheduler,
    DEISMultistepScheduler,
    KDPM2AncestralDiscreteScheduler,
    KDPM2DiscreteScheduler,
    KarrasVeScheduler,
)
from diffusers.schedulers.scheduling_utils import SchedulerMixin


_SCHEDULERS: Dict[str, Type[SchedulerMixin]] = {
    "ddim": DDIMScheduler,
    "dpmpp_2m": DPMSolverMultistepScheduler,
    "dpmpp_2m_karras": DPMSolverMultistepScheduler,
    "dpmpp_2s": DPMSolverSinglestepScheduler,
    "euler": EulerDiscreteScheduler,
    "euler_a": EulerAncestralDiscreteScheduler,
    "heun": HeunDiscreteScheduler,
    "lms": LMSDiscreteScheduler,
    "pndm": PNDMScheduler,
    "unipc": UniPCMultistepScheduler,
    "deis": DEISMultistepScheduler,
    "kdpm2": KDPM2DiscreteScheduler,
    "kdpm2_a": KDPM2AncestralDiscreteScheduler,
    "karras_ve": KarrasVeScheduler,
}


def resolve_scheduler(name: str) -> Type[SchedulerMixin]:
    """
    Resolve the diffusers scheduler class for a given string identifier.

    Parameters
    ----------
    name:
        Name as provided in ``models.yaml`` or in a request DTO.

    Raises
    ------
    KeyError
        If the scheduler is unknown.  The caller handles the error and can
        provide a friendly diagnostic message to the UI.
    """
    key = name.lower()
    if key not in _SCHEDULERS:
        raise KeyError(f"Unsupported scheduler: {name}")
    return _SCHEDULERS[key]
