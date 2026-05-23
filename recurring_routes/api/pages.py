"""Page rendering routes for recurring routes UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.template_context import render_template

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/routes", response_class=HTMLResponse, tags=["Pages"])
async def routes_page(request: Request):
    """Render recurring routes page."""
    return await render_template(request, "routes.html", route_id=None)


@router.get("/routes/{route_id}", response_class=HTMLResponse, tags=["Pages"])
async def route_details_page(request: Request, route_id: str):
    """Render routes page with a specific route preselected."""
    return await render_template(request, "routes.html", route_id=route_id)
