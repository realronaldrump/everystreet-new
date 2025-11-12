import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from config import CLARITY_PROJECT_ID, MAPBOX_ACCESS_TOKEN
from db import db_manager

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")

# Get Mapbox access token from centralized config


def _render_page(template_name: str, request: Request, **context: Any) -> HTMLResponse:
    """Render a Jinja template with a consistent base context."""
    return templates.TemplateResponse(
        template_name,
        {
            "request": request,
            "CLARITY_PROJECT_ID": CLARITY_PROJECT_ID,
            **context,
        },
    )


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Render main index page."""
    return _render_page(
        "index.html",
        request,
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
    )


@router.get("/edit_trips", response_class=HTMLResponse)
async def edit_trips_page(request: Request):
    """Render trip editing page."""
    return _render_page(
        "edit_trips.html",
        request,
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
    )


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return _render_page("settings.html", request)


@router.get("/profile", response_class=HTMLResponse)
async def profile_page(request: Request):
    """Render profile settings page."""
    return _render_page("profile.html", request)


@router.get("/insights")
async def insights_page(request: Request):
    return _render_page("insights.html", request)


@router.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return _render_page(
        "visits.html",
        request,
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
    )


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return _render_page("export.html", request)


@router.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    """Render upload page."""
    return _render_page(
        "upload.html",
        request,
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
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
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
    )


@router.get("/database-management", response_class=HTMLResponse)
async def database_management_page(request: Request):
    """Render database management page with statistics."""
    try:
        db_stats = await db_manager.db.command("dbStats")
        storage_used_mb = round(db_stats["dataSize"] / (1024 * 1024), 2)
        collection_names = list(await db_manager.db.list_collection_names())
        collections_info = []
        for collection_name in collection_names:
            stats = await db_manager.db.command("collStats", collection_name)
            collections_info.append(
                {
                    "name": collection_name,
                    "document_count": stats["count"],
                    "size_mb": round(stats["size"] / (1024 * 1024), 2),
                },
            )
        return _render_page(
            "database_management.html",
            request,
            storage_used_mb=storage_used_mb,
            collections=collections_info,
        )
    except Exception as e:
        logger.exception("Error loading database management page: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page(request: Request):
    """Render app settings page."""
    return _render_page("app_settings.html", request)


@router.get("/server-logs", response_class=HTMLResponse)
async def server_logs_page(request: Request):
    """Render server logs viewing page."""
    return _render_page("server_logs.html", request)


@router.get(
    "/driving-navigation",
    response_class=HTMLResponse,
)
async def driving_navigation_page(request: Request):
    """Render the driving navigation page."""
    return _render_page(
        "driving_navigation.html",
        request,
        MAPBOX_ACCESS_TOKEN=MAPBOX_ACCESS_TOKEN,
    )
