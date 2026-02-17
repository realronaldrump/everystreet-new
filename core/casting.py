from __future__ import annotations

from typing import Any


def safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce value to float with a default."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
