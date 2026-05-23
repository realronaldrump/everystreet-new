from __future__ import annotations

from importlib import import_module
from typing import Any

LazyImports = dict[str, tuple[str, str | None]]


def resolve_lazy_attr(
    *,
    module_name: str,
    lazy_imports: LazyImports,
    attr_name: str,
) -> Any:
    target = lazy_imports.get(attr_name)
    if not target:
        msg = f"module {module_name!r} has no attribute {attr_name!r}"
        raise AttributeError(msg)

    import_path, imported_attr = target
    module = import_module(import_path)
    return module if imported_attr is None else getattr(module, imported_attr)


def lazy_module_dir(namespace: dict[str, Any], lazy_imports: LazyImports) -> list[str]:
    return sorted(set(namespace) | set(lazy_imports))


def make_lazy_getattr(module_name: str, lazy_imports: LazyImports):
    def lazy_getattr(attr_name: str) -> Any:
        return resolve_lazy_attr(
            module_name=module_name,
            lazy_imports=lazy_imports,
            attr_name=attr_name,
        )

    return lazy_getattr


def make_lazy_dir(namespace: dict[str, Any], lazy_imports: LazyImports):
    def lazy_dir() -> list[str]:
        return lazy_module_dir(namespace, lazy_imports)

    return lazy_dir
