from __future__ import annotations

"""
Progress reporting utilities used to bridge diffusers callbacks with UI-facing
handlers.

The diffusers pipelines accept a callback invoked after each sampling step.
This module wraps the raw callback signature and provides a convenient
:class:`DiffusionProgress` dataclass that can be forwarded to any consumer
listening for updates (CLI, GUI progress bar, telemetry, etc.).
"""

from dataclasses import dataclass
from typing import Callable, Optional

from PIL import Image


@dataclass(slots=True)
class DiffusionProgress:
    """
    A single progress update emitted by diffusers callbacks.

    Attributes
    ----------
    step:
        Current step number (1-based in our wrapper for easier consumption).
    total:
        Total number of steps planned.  When diffusers does not expose the
        information we report ``0`` so the consumer can decide how to handle
        indeterminate progress.
    eta_ms:
        Optional estimate of the remaining time in milliseconds.  Not currently
        provided by diffusers but kept for future extensions.
    preview_image:
        Optional low-resolution preview image that some pipelines can emit.
    """

    step: int
    total: int
    eta_ms: Optional[float] = None
    preview_image: Optional[Image.Image] = None


ProgressCallback = Callable[[DiffusionProgress], None]


def make_callback(
    progress_cb: Optional[ProgressCallback],
    total_steps: Optional[int] = None,
):
    """
    Convert a user-supplied callback into a diffusers-compatible callable.

    Diffusers invokes callbacks with ``(step, timestep, latents)`` arguments.
    This helper hides the specifics and forwards a richer
    :class:`DiffusionProgress` object to the consumer's callback.

    Parameters
    ----------
    progress_cb:
        Callable provided by the caller or ``None`` when progress reporting is
        not required.
    total_steps:
        Number of diffusion steps planned for the run.  Passed along so the
        consumer can compute percentage completion.
    """
    if progress_cb is None:
        return None

    def _callback(step: int, timestep, latents):
        progress_cb(
            DiffusionProgress(
                step=step + 1,
                total=total_steps or 0,
            )
        )

    return _callback
