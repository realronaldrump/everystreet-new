import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from config import get_mapbox_token, validate_mapbox_token
from db.models import ALL_DOCUMENT_MODELS

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")

# Get Mapbox access token from centralized config (map rendering only)


def _mapbox_token_for_render() -> str:
    token = get_mapbox_token()
    validate_mapbox_token(token)
    return token


def _render_page(template_name: str, request: Request, **context: Any) -> HTMLResponse:
    """Render a Jinja template with a consistent base context."""
    return templates.TemplateResponse(
        template_name,
        {
            "request": request,
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
    return _render_page(
        "index.html",
        request,
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )


@router.get("/edit_trips", response_class=HTMLResponse)
async def edit_trips_page(request: Request):
    """Render trip editing page."""
    return _render_page(
        "edit_trips.html",
        request,
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return _render_page("settings.html", request)


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
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )


@router.get("/gas-tracking", response_class=HTMLResponse)
async def gas_tracking_page(request: Request):
    """Render gas tracking page."""
    return _render_page(
        "gas_tracking.html",
        request,
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return _render_page("export.html", request)


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return _render_page(
        "coverage_management.html",
        request,
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )


@router.get("/database-management", response_class=HTMLResponse)
async def database_management_page(request: Request):
    """Render database management page with statistics."""
    try:
        collections_info = []
        collection_models = {}
        for model in ALL_DOCUMENT_MODELS:
            collection_models.setdefault(model.get_collection_name(), model)

        for collection_name in sorted(collection_models):
            model = collection_models[collection_name]
            document_count = await model.find_all().count()
            collections_info.append(
                {
                    "name": collection_name,
                    "document_count": document_count,
                    "size_mb": None,
                },
            )
        return _render_page(
            "database_management.html",
            request,
            storage_used_mb=None,
            collections=collections_info,
        )
    except Exception as e:
        logger.exception("Error loading database management page: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


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
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
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
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
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
        MAPBOX_ACCESS_TOKEN=_mapbox_token_for_render(),
    )
