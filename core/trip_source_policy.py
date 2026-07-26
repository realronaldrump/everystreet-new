"""Source policy helpers for historical trip queries."""

from __future__ import annotations

from typing import Any

BOUNCIE_SOURCE = "bouncie"


def enforce_bouncie_source(query: dict[str, Any]) -> dict[str, Any]:
    """
    Ensure a query only returns Bouncie-owned trips.

    This intentionally overrides any existing `source` filter so callers
    cannot accidentally include records owned by another source.
    """
    constrained = dict(query)
    constrained["source"] = BOUNCIE_SOURCE
    return constrained


__all__ = ["BOUNCIE_SOURCE", "enforce_bouncie_source"]
