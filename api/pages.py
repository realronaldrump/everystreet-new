import logging
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from admin.services.admin_service import AdminService
from config import validate_mapbox_token
from core.jinja import register_template_filters
from core.repo_info import get_repo_version_info
from core.service_config import get_mapbox_token_async
from db.models import ALL_DOCUMENT_MODELS

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")
register_template_filters(templates)

# Get Mapbox access token from centralized config (map rendering only)


async def _mapbox_token_for_render() -> str:
    token = await get_mapbox_token_async()
    validate_mapbox_token(token)
    return token


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


async def _storage_management_context() -> dict[str, Any]:
    """Build storage management statistics context."""
    try:
        collections_info = []
        collection_models = {}
        for model in ALL_DOCUMENT_MODELS:
            collection_models.setdefault(model.get_collection_name(), model)

        collection_names = sorted(collection_models)
        collection_sizes = await AdminService.get_collection_sizes_mb(collection_names)
        storage_info = await AdminService.get_storage_info()

        for collection_name in collection_names:
            model = collection_models[collection_name]
            document_count = await model.find_all().count()
            collections_info.append(
                {
                    "name": collection_name,
                    "document_count": document_count,
                    "size_mb": collection_sizes.get(collection_name),
                },
            )

        return {
            "storage_snapshot": storage_info,
            "storage_sources": storage_info.get("sources", []),
            "storage_used_mb": storage_info.get("used_mb"),
            "database_logical_mb": storage_info.get("database_logical_mb"),
            "storage_updated_at": storage_info.get("updated_at"),
            "collections": collections_info,
            "storage_error": storage_info.get("error"),
        }
    except Exception as exc:
        logger.exception("Error loading storage management data")
        return {
            "storage_snapshot": {},
            "storage_sources": [],
            "storage_used_mb": None,
            "database_logical_mb": None,
            "storage_updated_at": None,
            "collections": [],
            "storage_error": str(exc),
        }


@router.get("/", response_class=HTMLResponse)
async def landing(request: Request):
    """Render landing page."""
    return _render_page("landing.html", request)


@router.get("/map", response_class=HTMLResponse)
async def map_page(request: Request):
    """Render main map page."""
    return _render_page(
        "index.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return _render_page(
        "settings.html",
        request,
        **(await _storage_management_context()),
    )


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
    return _render_page(
        "visits.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get("/gas-tracking", response_class=HTMLResponse)
async def gas_tracking_page(request: Request):
    """Render gas tracking page."""
    return _render_page(
        "gas_tracking.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return _render_page("export.html", request)


@router.get("/map-matching", response_class=HTMLResponse)
async def map_matching_page(request: Request):
    """Render map matching job page."""
    return _render_page(
        "map_matching.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return _render_page(
        "coverage_management.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get("/database-management", response_class=RedirectResponse)
async def database_management_page():
    """Redirect database management to settings tab."""
    return RedirectResponse(url="/settings#storage", status_code=301)


@router.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page():
    """Redirect old app-settings to unified settings page."""
    from fastapi.responses import RedirectResponse

    return RedirectResponse(url="/settings", status_code=301)


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
    return _render_page(
        "coverage_navigator.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get(
    "/turn-by-turn",
    response_class=HTMLResponse,
)
async def turn_by_turn_page(request: Request):
    """Render the turn-by-turn navigation experience."""
    return _render_page(
        "turn_by_turn.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


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
    return _render_page(
        "county_map.html",
        request,
        MAPBOX_ACCESS_TOKEN=await _mapbox_token_for_render(),
    )


@router.get("/setup-wizard", response_class=HTMLResponse)
async def setup_wizard_page(request: Request):
    """Render the setup wizard."""
    return _render_page("setup_wizard.html", request)


@router.get("/setup", response_class=RedirectResponse)
async def setup_wizard_redirect():
    """Redirect legacy setup path to the current wizard route."""
    return RedirectResponse(url="/setup-wizard", status_code=308)


@router.get("/status", response_class=HTMLResponse)
async def status_dashboard(request: Request):
    """Render system status dashboard."""
    return _render_page("status_dashboard.html", request)
