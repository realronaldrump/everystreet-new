"""Page rendering routes for trips UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.template_context import render_template

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/trips", response_class=HTMLResponse, tags=["Pages"])
async def trips_page(
    request: Request,
    highlight: str | None = None,
    trip_id: str | None = None,
):
    """Render the main trips data table page."""
    preload_trip_id = trip_id or highlight
    return await render_template(request, "trips.html", trip_id=preload_trip_id)


@router.get("/trips/{trip_id}", response_class=HTMLResponse, tags=["Pages"])
async def trip_details_page(request: Request, trip_id: str):
    """Render trips page with a specific trip preselected."""
    return await render_template(request, "trips.html", trip_id=trip_id)
