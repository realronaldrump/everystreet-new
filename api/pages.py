from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from core.auth import validate_form_csrf_token
from core.template_context import render_template
from gas.services.vehicle_service import VehicleService

router = APIRouter()


async def _handle_add_vehicle_form(
    request: Request,
    *,
    imei: str,
    custom_name: str | None,
    csrf_token: str,
    redirect_url: str,
) -> RedirectResponse:
    if not validate_form_csrf_token(request, csrf_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token.",
        )

    imei_value = (imei or "").strip()
    name_value = (custom_name or "").strip() or None

    if imei_value:
        await VehicleService.upsert_and_authorize(imei_value, name_value)

    return RedirectResponse(url=redirect_url, status_code=303)


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
    return await render_template(
        request,
        "control_center.html",
        storage_snapshot={},
        storage_sources=[],
        storage_used_mb=None,
        database_logical_mb=None,
        storage_updated_at=None,
        collections=[],
        storage_error=None,
    )


@router.post(
    "/control-center/credentials/add-vehicle",
    response_class=RedirectResponse,
)
async def control_center_add_vehicle(
    request: Request,
    imei: Annotated[str, Form()] = "",
    custom_name: Annotated[str | None, Form()] = None,
    csrf_token: Annotated[str, Form()] = "",
) -> RedirectResponse:
    """Handle Credentials -> Add Vehicle form submission."""
    return await _handle_add_vehicle_form(
        request,
        imei=imei,
        custom_name=custom_name,
        csrf_token=csrf_token,
        redirect_url="/control-center#credentials",
    )


@router.post("/vehicles/add-vehicle", response_class=RedirectResponse)
async def vehicles_add_vehicle(
    request: Request,
    imei: Annotated[str, Form()] = "",
    custom_name: Annotated[str | None, Form()] = None,
    csrf_token: Annotated[str, Form()] = "",
) -> RedirectResponse:
    """Handle My Vehicles -> Add Vehicle form submission."""
    return await _handle_add_vehicle_form(
        request,
        imei=imei,
        custom_name=custom_name,
        csrf_token=csrf_token,
        redirect_url="/vehicles",
    )


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


@router.get("/map-matching", response_class=HTMLResponse)
async def map_matching_page(request: Request):
    """Render map matching job page."""
    return await render_template(request, "map_matching.html")


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
