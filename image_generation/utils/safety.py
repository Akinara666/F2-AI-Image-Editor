from __future__ import annotations

"""
Safety checker helpers mediating between diffusers output and the application
policy.

Diffusers pipelines may return a ``nsfw_content_detected`` list alongside the
generated images.  This module interprets the flag according to the configured
policy (warn, block or ignore) and provides the service with structured
feedback.
"""

from dataclasses import dataclass
from enum import Enum
from typing import List


class SafetyMode(str, Enum):
    """Enumeration of supported safety behaviours."""

    WARN = "warn"
    BLOCK = "block"
    OFF = "off"


@dataclass(slots=True)
class SafetyResult:
    """
    Encapsulates the safety checker outcome.

    Attributes
    ----------
    has_nsfw:
        Per-image flags returned by diffusers.
    warnings:
        Human-readable messages the UI can surface to the user.  Empty when no
        warning is required.
    """

    has_nsfw: List[bool]
    warnings: List[str]


def handle_safety(mode: SafetyMode, has_nsfw: List[bool]) -> SafetyResult:
    """
    Apply the chosen safety policy to the diffusers NSFW flags.

    Parameters
    ----------
    mode:
        Selected policy (warn, block, off).
    has_nsfw:
        List of booleans coming from diffusers.

    Raises
    ------
    RuntimeError
        When ``mode`` is ``BLOCK`` and NSFW content is detected.  The service
        will propagate the exception, signalling the UI to abort presenting the
        image.
    """
    if not has_nsfw:
        return SafetyResult(has_nsfw=[], warnings=[])

    warnings: List[str] = []
    if any(has_nsfw):
        if mode == SafetyMode.BLOCK:
            raise RuntimeError("NSFW content detected. Blocking generation result.")
        if mode == SafetyMode.WARN:
            warnings.append("NSFW content detected by safety checker.")

    return SafetyResult(has_nsfw=has_nsfw, warnings=warnings)
