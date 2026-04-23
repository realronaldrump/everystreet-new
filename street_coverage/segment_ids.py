"""Helpers for working with versioned street coverage segment ids."""

from __future__ import annotations

import re
from typing import Any


def segment_id_prefix_for_area_version(area_id: Any, area_version: int) -> str:
    """Return the stable prefix used by all segment ids for an area version."""
    return f"{area_id}-{int(area_version)}-"


def segment_id_regex_for_area_version(area_id: Any, area_version: int) -> dict[str, str]:
    """Return a Mongo regex matcher for segment ids belonging to an area version."""
    prefix = segment_id_prefix_for_area_version(area_id, area_version)
    return {"$regex": f"^{re.escape(prefix)}"}
