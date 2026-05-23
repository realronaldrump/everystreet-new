from __future__ import annotations

import math
from typing import Any, overload


@overload
def safe_float(value: Any, default: None) -> float | None: ...


@overload
def safe_float(value: Any, default: float = 0.0) -> float: ...


def safe_float(value: Any, default: float | None = 0.0) -> float | None:
    """Coerce value to float with a default."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default
