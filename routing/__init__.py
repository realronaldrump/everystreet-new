"""Routing helpers and optimal route generation."""

from __future__ import annotations

from core.lazy_imports import make_lazy_dir, make_lazy_getattr

__all__ = [
    "generate_optimal_route",
    "generate_optimal_route_with_progress",
    "save_optimal_route",
]

_LAZY_IMPORTS: dict[str, tuple[str, str | None]] = {
    "generate_optimal_route": ("routing.service", "generate_optimal_route"),
    "generate_optimal_route_with_progress": (
        "routing.service",
        "generate_optimal_route_with_progress",
    ),
    "save_optimal_route": ("routing.service", "save_optimal_route"),
    "service": ("routing.service", None),
}


__getattr__ = make_lazy_getattr(__name__, _LAZY_IMPORTS)
__dir__ = make_lazy_dir(globals(), _LAZY_IMPORTS)
