"""Page rendering routes for trips UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.jinja import templates
from core.repo_info import get_repo_version_info

logger = logging.getLogger(__name__)
router = APIRouter()


async def _render_trips_page(
    request: Request,
    trip_id: str | None = None,
) -> HTMLResponse:
    """Render the trips page with optional preloaded trip details."""
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
        "trips.html",
        {
            "repo_version": get_repo_version_info(),
            "app_settings": app_settings,
            "trip_id": trip_id,
        },
    )


@router.get("/trips", response_class=HTMLResponse, tags=["Pages"])
async def trips_page(
    request: Request,
    highlight: str | None = None,
    trip_id: str | None = None,
):
    """Render the main trips data table page."""
    preload_trip_id = trip_id or highlight
    return await _render_trips_page(request, trip_id=preload_trip_id)


@router.get("/trips/{trip_id}", response_class=HTMLResponse, tags=["Pages"])
async def trip_details_page(request: Request, trip_id: str):
    """Render trips page with a specific trip preselected."""
    return await _render_trips_page(request, trip_id=trip_id)
