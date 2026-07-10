from fastapi import APIRouter, Request, status
from fastapi.responses import HTMLResponse, Response

from core.template_context import render_template

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def landing(request: Request):
    """Render landing page."""
    return await render_template(request, "landing.html")


@router.head("/", include_in_schema=False)
async def home_head() -> Response:
    """Fast uptime probe for the public root without rendering templates."""
    return Response(status_code=status.HTTP_200_OK)


@router.get("/map", response_class=HTMLResponse)
async def map_page(request: Request):
    """Render main map page."""
    return await render_template(request, "index.html")


@router.get("/control-center", response_class=HTMLResponse)
async def control_center_page(request: Request):
    """Render control center page."""
    return await render_template(request, "control_center.html")


@router.get("/vehicles", response_class=HTMLResponse)
async def vehicles_page(request: Request):
    """Render vehicle management page."""
    return await render_template(request, "vehicles.html")


@router.get("/insights")
async def insights_page(request: Request):
    return await render_template(request, "insights.html")


@router.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return await render_template(request, "visits.html")


@router.get("/gas-tracking", response_class=HTMLResponse)
async def gas_tracking_page(request: Request):
    """Render gas tracking page."""
    return await render_template(request, "gas_tracking.html")


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return await render_template(request, "export.html")


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return await render_template(request, "coverage_management.html")


@router.get(
    "/coverage-route-planner",
    response_class=HTMLResponse,
)
async def coverage_route_planner_page(request: Request):
    """Render the coverage route planning page."""
    return await render_template(request, "coverage_route_planner.html")


@router.get(
    "/live-navigation",
    response_class=HTMLResponse,
)
async def live_navigation_page(request: Request):
    """Render the live navigation experience."""
    return await render_template(request, "live_navigation.html")


@router.get(
    "/regional-coverage-explorer",
    response_class=HTMLResponse,
)
async def regional_coverage_explorer_page(request: Request):
    """Render the region explorer page."""
    return await render_template(request, "regional_coverage_explorer.html")


@router.get(
    "/memory-city",
    response_class=HTMLResponse,
)
async def memory_city_page(request: Request):
    """Render the Memory City 3D sculpture view."""
    return await render_template(request, "memory_city.html")


@router.get("/setup-wizard", response_class=HTMLResponse)
async def setup_wizard_page(request: Request):
    """Render the setup wizard."""
    return await render_template(request, "setup_wizard.html")
