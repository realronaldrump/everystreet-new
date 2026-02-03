"""Page rendering routes for trips UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from config import validate_mapbox_token
from core.repo_info import get_repo_version_info
from core.service_config import get_mapbox_token_async

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")


async def _render_trips_page(
    request: Request,
    trip_id: str | None = None,
) -> HTMLResponse:
    """Render the trips page with optional preloaded trip details."""
    token = await get_mapbox_token_async()
    validate_mapbox_token(token)

    return templates.TemplateResponse(
        "trips.html",
        {
            "request": request,
            "MAPBOX_ACCESS_TOKEN": token,
            "repo_version": get_repo_version_info(),
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
