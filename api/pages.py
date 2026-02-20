from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from core.jinja import register_template_filters
from core.repo_info import get_repo_version_info
from db.models import Vehicle
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
)

router = APIRouter()

templates = Jinja2Templates(directory="templates")
register_template_filters(templates)

def _render_page(template_name: str, request: Request, **context: Any) -> HTMLResponse:
    """Render a Jinja template with a consistent base context."""
    return templates.TemplateResponse(
        template_name,
        {
            "request": request,
            "repo_version": get_repo_version_info(),
            **context,
        },
    )


@router.get("/", response_class=HTMLResponse)
async def landing(request: Request):
    """Render landing page."""
    return _render_page("landing.html", request)


@router.get("/map", response_class=HTMLResponse)
async def map_page(request: Request):
    """Render main map page."""
    return _render_page("index.html", request)


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return _render_page(
        "settings.html",
        request,
        storage_snapshot={},
        storage_sources=[],
        storage_used_mb=None,
        database_logical_mb=None,
        storage_updated_at=None,
        collections=[],
        storage_error=None,
    )


@router.post("/settings/credentials/add-vehicle", response_class=RedirectResponse)
async def settings_add_vehicle(
    imei: Annotated[str, Form()] = "",
    custom_name: Annotated[str | None, Form()] = None,
) -> RedirectResponse:
    """Handle Credentials -> Add Vehicle form submission."""
    imei_value = (imei or "").strip()
    name_value = (custom_name or "").strip() or None

    if imei_value:
        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == imei_value)
        if vehicle:
            if name_value is not None:
                vehicle.custom_name = name_value
            vehicle.is_active = True
            vehicle.updated_at = now
            await vehicle.save()
        else:
            vehicle = Vehicle(
                imei=imei_value,
                custom_name=name_value,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            await vehicle.insert()

        credentials = await get_bouncie_credentials()
        devices = credentials.get("authorized_devices") or []
        if isinstance(devices, str):
            devices = [d.strip() for d in devices.split(",") if d.strip()]
        if not isinstance(devices, list):
            devices = []
        devices = [str(d).strip() for d in devices if str(d).strip()]
        if imei_value not in devices:
            devices.append(imei_value)
            await update_bouncie_credentials({"authorized_devices": devices})

    # Always return the user to the Credentials tab.
    return RedirectResponse(url="/settings#credentials", status_code=303)


@router.post("/vehicles/add-vehicle", response_class=RedirectResponse)
async def vehicles_add_vehicle(
    imei: Annotated[str, Form()] = "",
    custom_name: Annotated[str | None, Form()] = None,
) -> RedirectResponse:
    """Handle My Vehicles -> Add Vehicle form submission."""
    imei_value = (imei or "").strip()
    name_value = (custom_name or "").strip() or None

    if imei_value:
        now = datetime.now(UTC)
        vehicle = await Vehicle.find_one(Vehicle.imei == imei_value)
        if vehicle:
            if name_value is not None:
                vehicle.custom_name = name_value
            vehicle.is_active = True
            vehicle.updated_at = now
            await vehicle.save()
        else:
            vehicle = Vehicle(
                imei=imei_value,
                custom_name=name_value,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
            await vehicle.insert()

        credentials = await get_bouncie_credentials()
        devices = credentials.get("authorized_devices") or []
        if isinstance(devices, str):
            devices = [d.strip() for d in devices.split(",") if d.strip()]
        if not isinstance(devices, list):
            devices = []
        devices = [str(d).strip() for d in devices if str(d).strip()]
        if imei_value not in devices:
            devices.append(imei_value)
            await update_bouncie_credentials({"authorized_devices": devices})

    return RedirectResponse(url="/vehicles", status_code=303)


@router.get("/profile", response_class=HTMLResponse)
async def profile_page(request: Request):
    """Render profile settings page."""
    return _render_page("profile.html", request)


@router.get("/vehicles", response_class=HTMLResponse)
async def vehicles_page(request: Request):
    """Render vehicle management page."""
    return _render_page("vehicles.html", request)


@router.get("/insights")
async def insights_page(request: Request):
    return _render_page("insights.html", request)


@router.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return _render_page("visits.html", request)


@router.get("/gas-tracking", response_class=HTMLResponse)
async def gas_tracking_page(request: Request):
    """Render gas tracking page."""
    return _render_page("gas_tracking.html", request)


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return _render_page("export.html", request)


@router.get("/map-matching", response_class=HTMLResponse)
async def map_matching_page(request: Request):
    """Render map matching job page."""
    return _render_page("map_matching.html", request)


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return _render_page("coverage_management.html", request)


@router.get("/database-management", response_class=RedirectResponse)
async def database_management_page():
    """Redirect database management to settings tab."""
    return RedirectResponse(url="/settings#storage", status_code=301)


@router.get("/server-logs", response_class=HTMLResponse)
async def server_logs_page(request: Request):
    """Render server logs viewing page."""
    return _render_page("server_logs.html", request)


@router.get(
    "/coverage-navigator",
    response_class=HTMLResponse,
)
async def coverage_navigator_page(request: Request):
    """Render the consolidated coverage navigation page."""
    return _render_page("coverage_navigator.html", request)


@router.get(
    "/turn-by-turn",
    response_class=HTMLResponse,
)
async def turn_by_turn_page(request: Request):
    """Render the turn-by-turn navigation experience."""
    return _render_page("turn_by_turn.html", request)


@router.get(
    "/driving-navigation",
    response_class=HTMLResponse,
)
async def driving_navigation_page():
    """Redirect driving navigation to the consolidated coverage page."""
    from fastapi.responses import RedirectResponse

    return RedirectResponse(url="/coverage-navigator", status_code=301)


@router.get(
    "/optimal-routes",
    response_class=HTMLResponse,
)
async def optimal_routes_page():
    """Redirect optimal routes to the consolidated coverage page."""
    from fastapi.responses import RedirectResponse

    return RedirectResponse(url="/coverage-navigator", status_code=301)


@router.get(
    "/county-map",
    response_class=HTMLResponse,
)
async def county_map_page(request: Request):
    """Render the county map visualization page."""
    return _render_page("county_map.html", request)


@router.get("/setup-wizard", response_class=HTMLResponse)
async def setup_wizard_page(request: Request):
    """Render the setup wizard."""
    return _render_page("setup_wizard.html", request)


@router.get("/status", response_class=HTMLResponse)
async def status_dashboard(request: Request):
    """Render system status dashboard."""
    return _render_page("status_dashboard.html", request)
