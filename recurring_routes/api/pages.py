"""Page rendering routes for recurring routes UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.jinja import templates
from core.repo_info import get_repo_version_info

logger = logging.getLogger(__name__)
router = APIRouter()


async def _render_routes_page(
    request: Request,
    route_id: str | None = None,
) -> HTMLResponse:
    from admin.services.admin_service import AdminService

    try:
        app_settings = await AdminService.get_app_settings_payload()
    except Exception:
        app_settings = {
            "map_provider": None,
            "google_maps_api_key": None,
        }

    return templates.TemplateResponse(
        request,
        "routes.html",
        {
            "repo_version": get_repo_version_info(),
            "app_settings": app_settings,
            "route_id": route_id,
        },
    )


@router.get("/routes", response_class=HTMLResponse, tags=["Pages"])
async def routes_page(request: Request):
    """Render recurring routes page."""
    return await _render_routes_page(request, route_id=None)


@router.get("/routes/{route_id}", response_class=HTMLResponse, tags=["Pages"])
async def route_details_page(request: Request, route_id: str):
    """Render routes page with a specific route preselected."""
    return await _render_routes_page(request, route_id=route_id)
