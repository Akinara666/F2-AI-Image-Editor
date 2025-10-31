"""
Grab-bag of utility helpers shared across the pipeline implementations.

The utilities exported here are deliberately lightweight wrappers around common
operations such as:

- Device selection and autocast handling that every backend needs before
  running inference.
- Scheduler name resolution that lets the YAML configuration reference
  schedulers by human-friendly string names.
- Progress/event handling that allows the UI to visualise the diffusion
  process in real time.
- Seed and image helpers used by all generation modes.
- Safety checker glue code which makes the policy configurable (warn / block /
  disable).
"""

from .device import DeviceConfig, resolve_device
from .scheduler import resolve_scheduler
from .progress import DiffusionProgress, ProgressCallback, make_callback
from .seed import prepare_generator
from .images import (
    load_image,
    save_image,
    ensure_rgba_mask,
    resize_to_multiple,
)
from .safety import SafetyMode, SafetyResult, handle_safety

__all__ = [
    "DeviceConfig",
    "resolve_device",
    "resolve_scheduler",
    "DiffusionProgress",
    "ProgressCallback",
    "make_callback",
    "prepare_generator",
    "load_image",
    "save_image",
    "ensure_rgba_mask",
    "resize_to_multiple",
    "SafetyMode",
    "SafetyResult",
    "handle_safety",
]
