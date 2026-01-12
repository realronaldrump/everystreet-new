"""Page rendering routes for trips UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from config import get_clarity_id

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")


@router.get("/trips", response_class=HTMLResponse, tags=["Pages"])
async def trips_page(request: Request):
    """Render the main trips data table page."""
    return templates.TemplateResponse(
        "trips.html",
        {"request": request, "CLARITY_PROJECT_ID": get_clarity_id()},
    )


@router.get("/{trip_id}", response_class=HTMLResponse, tags=["Pages"])
async def trip_detail_page(request: Request, trip_id: str):
    """Render the map page focused on a specific trip."""
    from config import get_mapbox_token  # Import here to avoid circular deps if any

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "CLARITY_PROJECT_ID": get_clarity_id(),
            "MAPBOX_ACCESS_TOKEN": get_mapbox_token(),
            "trip_id": trip_id,
        },
    )
