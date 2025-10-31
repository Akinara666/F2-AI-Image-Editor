from __future__ import annotations

"""
Seed utility to produce deterministic generators.

Diffusers pipelines accept a :class:`torch.Generator` to control randomness.
This module centralises creation of the generator so all services follow the
same convention (device-aware generator, optional seed).
"""

from typing import Optional

import torch


def prepare_generator(seed: Optional[int], device: torch.device) -> Optional[torch.Generator]:
    """
    Create a torch generator bound to the requested device.

    The helper is used by :class:`ImageGenerationService` when preparing
    pipeline parameters.  Returning ``None`` keeps the default diffusers random
    behaviour for truly random generations.
    """
    if seed is None:
        return None
    gen = torch.Generator(device=device)
    gen.manual_seed(seed)
    return gen
