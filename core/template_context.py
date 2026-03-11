"""Shared template context builders."""

from __future__ import annotations

from typing import Any

from fastapi import Request

from admin.services.admin_service import AdminService
from core.auth import get_request_auth_context, owner_login_enabled
from core.repo_info import get_repo_version_info


async def _get_template_app_settings(include_sensitive: bool) -> dict[str, Any]:
    try:
        settings = await AdminService.get_persisted_app_settings()
    except Exception:
        settings = None

    payload: dict[str, Any] = {
        "map_provider": "self_hosted",
        "mapTripsWithinCoverageOnly": False,
        "tripLayersUseHeatmap": True,
        "google_maps_api_key": None,
    }
    if settings is None:
        return payload

    map_provider = getattr(settings, "map_provider", "self_hosted")
    payload["map_provider"] = getattr(map_provider, "value", map_provider)
    payload["mapTripsWithinCoverageOnly"] = bool(
        getattr(settings, "mapTripsWithinCoverageOnly", False),
    )
    payload["tripLayersUseHeatmap"] = bool(
        getattr(settings, "tripLayersUseHeatmap", True),
    )
    if include_sensitive:
        payload["google_maps_api_key"] = getattr(settings, "google_maps_api_key", None)
    return payload


async def build_base_template_context(
    request: Request,
    **extra: Any,
) -> dict[str, Any]:
    """Return the shared base template context for HTML responses."""
    auth_context = get_request_auth_context(request)
    app_settings = await _get_template_app_settings(include_sensitive=auth_context.is_owner)
    return {
        "repo_version": get_repo_version_info(),
        "app_settings": app_settings,
        "auth_context": auth_context,
        "auth_context_json": auth_context.to_frontend_payload(),
        "owner_login_enabled": owner_login_enabled(),
        **extra,
    }
