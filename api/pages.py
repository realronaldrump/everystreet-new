from typing import Annotated, Any

from fastapi import APIRouter, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse

from core.auth import validate_form_csrf_token
from core.jinja import templates
from core.template_context import build_base_template_context
from gas.services.vehicle_service import VehicleService

router = APIRouter()


async def _render_page(
    template_name: str,
    request: Request,
    **context: Any,
) -> HTMLResponse:
    """Render a Jinja template with a consistent base context."""
    base_context = await build_base_template_context(request)
    return templates.TemplateResponse(
        request,
        template_name,
        {
            **base_context,
            **context,
        },
    )


@router.get("/", response_class=HTMLResponse)
async def landing(request: Request):
    """Render landing page."""
    return await _render_page("landing.html", request)


@router.get("/map", response_class=HTMLResponse)
async def map_page(request: Request):
    """Render main map page."""
    return await _render_page("index.html", request)


@router.get("/control-center", response_class=HTMLResponse)
async def control_center_page(request: Request):
    """Render control center page."""
    return await _render_page(
        "control_center.html",
        request,
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
    if not validate_form_csrf_token(request, csrf_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token.",
        )

    imei_value = (imei or "").strip()
    name_value = (custom_name or "").strip() or None

    if imei_value:
        await VehicleService.upsert_and_authorize(imei_value, name_value)

    return RedirectResponse(url="/control-center#credentials", status_code=303)


@router.post("/vehicles/add-vehicle", response_class=RedirectResponse)
async def vehicles_add_vehicle(
    request: Request,
    imei: Annotated[str, Form()] = "",
    custom_name: Annotated[str | None, Form()] = None,
    csrf_token: Annotated[str, Form()] = "",
) -> RedirectResponse:
    """Handle My Vehicles -> Add Vehicle form submission."""
    if not validate_form_csrf_token(request, csrf_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid CSRF token.",
        )

    imei_value = (imei or "").strip()
    name_value = (custom_name or "").strip() or None

    if imei_value:
        await VehicleService.upsert_and_authorize(imei_value, name_value)

    return RedirectResponse(url="/vehicles", status_code=303)


@router.get("/vehicles", response_class=HTMLResponse)
async def vehicles_page(request: Request):
    """Render vehicle management page."""
    return await _render_page("vehicles.html", request)


@router.get("/insights")
async def insights_page(request: Request):
    return await _render_page("insights.html", request)


@router.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return await _render_page("visits.html", request)


@router.get("/gas-tracking", response_class=HTMLResponse)
async def gas_tracking_page(request: Request):
    """Render gas tracking page."""
    return await _render_page("gas_tracking.html", request)


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return await _render_page("export.html", request)


@router.get("/map-matching", response_class=HTMLResponse)
async def map_matching_page(request: Request):
    """Render map matching job page."""
    return await _render_page("map_matching.html", request)


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return await _render_page("coverage_management.html", request)


@router.get(
    "/coverage-route-planner",
    response_class=HTMLResponse,
)
async def coverage_route_planner_page(request: Request):
    """Render the coverage route planning page."""
    return await _render_page("coverage_route_planner.html", request)


@router.get(
    "/live-navigation",
    response_class=HTMLResponse,
)
async def live_navigation_page(request: Request):
    """Render the live navigation experience."""
    return await _render_page("live_navigation.html", request)


@router.get(
    "/regional-coverage-explorer",
    response_class=HTMLResponse,
)
async def regional_coverage_explorer_page(request: Request):
    """Render the region explorer page."""
    return await _render_page("regional_coverage_explorer.html", request)


@router.get("/setup-wizard", response_class=HTMLResponse)
async def setup_wizard_page(request: Request):
    """Render the setup wizard."""
    return await _render_page("setup_wizard.html", request)
