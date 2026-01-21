"""Routing helpers and optimal route generation."""

from __future__ import annotations

from importlib import import_module

__all__ = [
    "generate_optimal_route",
    "generate_optimal_route_with_progress",
    "save_optimal_route",
]

_LAZY_IMPORTS: dict[str, tuple[str, str | None]] = {
    "generate_optimal_route": ("routes.service", "generate_optimal_route"),
    "generate_optimal_route_with_progress": (
        "routes.service",
        "generate_optimal_route_with_progress",
    ),
    "save_optimal_route": ("routes.service", "save_optimal_route"),
    "service": ("routes.service", None),
}


def __getattr__(name: str):
    target = _LAZY_IMPORTS.get(name)
    if not target:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attr_name = target
    module = import_module(module_name)
    return module if attr_name is None else getattr(module, attr_name)


def __dir__():
    return sorted(set(globals()) | set(_LAZY_IMPORTS))
