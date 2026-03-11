"""Page rendering routes for recurring routes UI."""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from core.jinja import templates
from core.template_context import build_base_template_context

logger = logging.getLogger(__name__)
router = APIRouter()


async def _render_routes_page(
    request: Request,
    route_id: str | None = None,
) -> HTMLResponse:
    base_context = await build_base_template_context(request)
    return templates.TemplateResponse(
        request,
        "routes.html",
        {
            **base_context,
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
