import logging
import os
import uuid
from pathlib import Path
from profile import router as profile_api_router

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from admin import router as admin_api_router
from analytics import router as analytics_api_router
from api.pages import router as pages_router
from core.http.session import cleanup_session
from core.repo_info import get_repo_version_info
from county import router as county_api_router
from db import db_manager
from db.logging_handler import MongoDBHandler
from driving import router as driving_routes_router
from exports import router as export_api_router
from gas import router as gas_api_router
from logs import router as logs_api_router
from map_data.routes import router as map_data_router
from map_matching.routes import router as map_matching_router
from processing import router as processing_api_router
from routes.routing import router as routing_router
from routes.status import router as status_router
from search import router as search_api_router
from setup import router as setup_api_router
from street_coverage.routes.coverage import router as coverage_api_router
from tasks.api import router as tasks_api_router
from tasks.arq import close_arq_pool
from tracking import router as tracking_api_router
from trips import router as trips_router
from visits import router as visits_router

load_dotenv()

# Basic logging configuration
logging.basicConfig(
    level=logging.INFO,  # Changed to INFO to capture more logs
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


class StaticFileFilter(logging.Filter):
    """Filter to suppress noisy static file request logs."""

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: V105
        # Filter out static file requests and favicon
        message = record.getMessage()
        if "/static/" in message or "/favicon.ico" in message:
            return False
        # Filter out Chrome DevTools requests
        return ".well-known/appspecific" not in message


# Apply the filter to uvicorn's access logger
uvicorn_access_logger = logging.getLogger("uvicorn.access")
uvicorn_access_logger.addFilter(StaticFileFilter())


class AppState:
    """Application state container to avoid global variables."""

    mongo_handler: MongoDBHandler | None = None


# Initialize FastAPI App
app = FastAPI(title="Every Street")

# Mount static files and templates
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static",
)
templates = Jinja2Templates(directory="templates")

# Root-level icon requests (browser defaults)
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> RedirectResponse:
    return RedirectResponse(url="/static/favicon.ico")


@app.get("/apple-touch-icon.png", include_in_schema=False)
async def apple_touch_icon() -> RedirectResponse:
    return RedirectResponse(url="/static/apple-touch-icon.png")


@app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
async def apple_touch_icon_precomposed() -> RedirectResponse:
    return RedirectResponse(url="/static/apple-touch-icon.png")

# CORS Middleware Configuration
# Get allowed origins from environment variable or use defaults
cors_origins_str = os.getenv("CORS_ALLOWED_ORIGINS", "")
if cors_origins_str:
    # Parse comma-separated list from environment
    origins = [
        origin.strip() for origin in cors_origins_str.split(",") if origin.strip()
    ]
    logger.info("CORS configured with specific origins: %s", origins)
else:
    # Development fallback - allow localhost and common dev ports
    origins = [
        "http://localhost:3000",
        "http://localhost:8080",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8080",
    ]
    logger.warning(
        "CORS_ALLOWED_ORIGINS not set. Using development defaults: %s",
        origins,
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)


# Note: setup_guard middleware removed to allow users to navigate freely
# Users can access the setup wizard at /setup when needed


# Include all the modular routers
app.include_router(pages_router)
app.include_router(admin_api_router)
app.include_router(analytics_api_router)
app.include_router(county_api_router)
app.include_router(coverage_api_router)
app.include_router(driving_routes_router)
app.include_router(export_api_router)
app.include_router(routing_router)
app.include_router(gas_api_router)
app.include_router(tracking_api_router)
app.include_router(logs_api_router)
app.include_router(map_data_router)
app.include_router(map_matching_router)

app.include_router(processing_api_router)
app.include_router(profile_api_router)
app.include_router(search_api_router)
app.include_router(setup_api_router)
app.include_router(status_router)
app.include_router(tasks_api_router)
app.include_router(trips_router)
app.include_router(visits_router)


# Global Configuration and Constants (imported from config.py)

# Database collections (for startup initialization)
# Note: Raw collection initialization removed in favor of Beanie models


# --- Application Lifecycle Events ---
@app.on_event("startup")
async def startup_event():
    """Initialize database indexes and components on application startup."""
    try:
        # Initialize Beanie ODM first
        await db_manager.init_beanie()
        logger.info("Beanie ODM initialized successfully.")

        from core.service_config import get_service_config

        await get_service_config()

        # Core database initialization is now handled by Beanie
        # await init_database()

        # Set up MongoDB logging handler
        AppState.mongo_handler = MongoDBHandler()
        await AppState.mongo_handler.setup_indexes()

        # Add the MongoDB handler to the root logger
        root_logger = logging.getLogger()
        AppState.mongo_handler.setLevel(logging.INFO)  # Log INFO and above to MongoDB
        root_logger.addHandler(AppState.mongo_handler)
        logger.info("MongoDB logging handler initialized and configured.")

        # Validate Valhalla + Nominatim configuration
        # Note: Services may not be ready yet if this is a fresh deployment
        # The Map Data Management UI allows downloading and building data
        from config import (
            get_nominatim_search_url,
            get_osm_data_path,
            get_valhalla_route_url,
            get_valhalla_status_url,
        )

        _ = get_valhalla_route_url()
        _ = get_valhalla_status_url()
        _ = get_nominatim_search_url()
        osm_path = get_osm_data_path()

        logger.info("Geo services configured for Docker internal DNS.")

        # Check OSM data path (optional - can be set up later via UI)
        if osm_path:
            osm_data_path = Path(osm_path)
            if osm_data_path.exists():
                if osm_data_path.suffix.lower() in {".osm", ".xml", ".pbf"}:
                    logger.info("OSM data file found: %s", osm_data_path)
                else:
                    logger.warning(
                        "OSM_DATA_PATH should point to .osm, .xml, or .pbf file. Got: %s",
                        osm_data_path,
                    )
            else:
                logger.info(
                    "OSM data file not yet present at %s. "
                    "Use Map Data Management to download.",
                    osm_data_path,
                )

        graph_dir = Path("data/graphs")
        graph_dir.mkdir(parents=True, exist_ok=True)
        logger.info("Graph storage directory ready: %s", graph_dir)

        # Register coverage event handlers
        from street_coverage.events import register_handlers

        register_handlers()
        logger.info("Coverage event handlers registered.")

        logger.info("Application startup completed successfully.")

    except Exception as e:
        logger.critical(
            "CRITICAL: Failed to initialize application during startup: %s",
            str(e),
            exc_info=True,
        )
        raise


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Clean up resources when shutting down."""
    await close_arq_pool()
    await db_manager.cleanup_connections()
    await cleanup_session()
    logger.info("Application shutdown completed successfully")


# --- Global Exception Handlers ---
def _prefers_html(request: Request) -> bool:
    accept_header = request.headers.get("accept", "").lower()
    return "text/html" in accept_header


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: HTTPException):
    """Handle 404 Not Found errors."""
    # Suppress noisy Chrome DevTools requests
    if ".well-known/appspecific" not in str(request.url):
        logger.warning("404 Not Found: %s. Detail: %s", request.url, exc.detail)
    if _prefers_html(request):
        return templates.TemplateResponse(
            "404.html",
            {
                "request": request,
                "path": request.url.path,
                "repo_version": get_repo_version_info(),
            },
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"error": "Endpoint not found", "detail": exc.detail},
    )


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc: Exception):
    """Handle 500 Internal Server Error errors."""
    error_id = str(uuid.uuid4())
    logger.error(
        "Internal Server Error (ID: %s): Request %s %s failed. Exception: %s",
        error_id,
        request.method,
        request.url,
        str(exc),
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal server error",
            "error_id": error_id,
            "detail": str(exc),
        },
    )


# --- Main Execution Block ---
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        reload=True,
    )
