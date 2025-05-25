import logging
import os

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from db import db_manager

logger = logging.getLogger(__name__)
router = APIRouter()

templates = Jinja2Templates(directory="templates")

# Get Mapbox access token from environment
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")


@router.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Render main index page."""
    return templates.TemplateResponse(
        "index.html", {"request": request, "MAPBOX_ACCESS_TOKEN": MAPBOX_ACCESS_TOKEN}
    )


@router.get("/trips", response_class=HTMLResponse)
async def trips_page(request: Request):
    """Render trips page."""
    return templates.TemplateResponse("trips.html", {"request": request})


@router.get("/edit_trips", response_class=HTMLResponse)
async def edit_trips_page(request: Request):
    """Render trip editing page."""
    return templates.TemplateResponse("edit_trips.html", {"request": request})


@router.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return templates.TemplateResponse("settings.html", {"request": request})


@router.get(
    "/driving-insights",
    response_class=HTMLResponse,
)
async def driving_insights_page(request: Request):
    """Render driving insights page."""
    return templates.TemplateResponse(
        "driving_insights.html",
        {"request": request},
    )


@router.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return templates.TemplateResponse("visits.html", {"request": request})


@router.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return templates.TemplateResponse("export.html", {"request": request})


@router.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    """Render upload page."""
    return templates.TemplateResponse("upload.html", {"request": request})


@router.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return templates.TemplateResponse(
        "coverage_management.html",
        {"request": request},
    )


@router.get("/database-management", response_class=HTMLResponse)
async def database_management_page(request: Request):
    """Render database management page with statistics."""
    try:
        db_stats = await db_manager.db.command("dbStats")
        storage_used_mb = round(db_stats["dataSize"] / (1024 * 1024), 2)
        storage_limit_mb = 512
        storage_usage_percent = round(
            (storage_used_mb / storage_limit_mb) * 100,
            2,
        )
        collections_info = []
        collection_names = [
            name for name in await db_manager.db.list_collection_names()
        ]
        for collection_name in collection_names:
            stats = await db_manager.db.command("collStats", collection_name)
            collections_info.append(
                {
                    "name": collection_name,
                    "document_count": stats["count"],
                    "size_mb": round(stats["size"] / (1024 * 1024), 2),
                },
            )
        return templates.TemplateResponse(
            "database_management.html",
            {
                "request": request,
                "storage_used_mb": storage_used_mb,
                "storage_limit_mb": storage_limit_mb,
                "storage_usage_percent": storage_usage_percent,
                "collections": collections_info,
            },
        )
    except Exception as e:
        logger.exception("Error loading database management page: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page(request: Request):
    """Render app settings page."""
    return templates.TemplateResponse(
        "app_settings.html",
        {"request": request},
    )


@router.get(
    "/driving-navigation",
    response_class=HTMLResponse,
)
async def driving_navigation_page(request: Request):
    """Render the driving navigation page."""
    return templates.TemplateResponse(
        "driving_navigation.html",
        {"request": request},
    )


@router.get(
    "/driver-behavior",
    response_class=HTMLResponse,
)
async def driver_behavior_page(request: Request):
    """Render driver behavior page."""
    return templates.TemplateResponse(
        "driver_behavior.html",
        {"request": request},
    )
