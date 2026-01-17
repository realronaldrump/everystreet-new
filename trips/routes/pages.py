"""Page rendering routes for trips UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")


@router.get("/trips", response_class=HTMLResponse, tags=["Pages"])
async def trips_page(request: Request):
    """Render the main trips data table page."""
    from config import get_mapbox_token, validate_mapbox_token

    token = get_mapbox_token()
    validate_mapbox_token(token)

    return templates.TemplateResponse(
        "trips.html",
        {
            "request": request,
            "MAPBOX_ACCESS_TOKEN": token,
        },
    )
