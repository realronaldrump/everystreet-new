import logging
import os
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from admin_api import router as admin_api_router
from analytics_api import router as analytics_api_router
from config import MAPBOX_ACCESS_TOKEN
from county_api import router as county_api_router
from coverage_api import router as coverage_api_router
from db import db_manager, init_database
from driving_routes import router as driving_routes_router
from export_api import router as export_api_router
from gas_api import router as gas_api_router
from live_tracking import initialize_db as initialize_live_tracking_db
from live_tracking_api import router as live_tracking_api_router
from logs_api import router as logs_api_router
from matched_trips_api import router as matched_trips_api_router
from mongodb_logging_handler import MongoDBHandler
from pages import router as pages_router
from processing_api import router as processing_api_router
from profile_api import router as profile_api_router
from search_api import router as search_api_router
from tasks_api import router as tasks_api_router
from trip_processor import TripProcessor
from trips import router as trips_router
from upload_api import router as upload_api_router
from utils import cleanup_session
from visits import init_collections
from visits import router as visits_router

load_dotenv()

# Basic logging configuration
logging.basicConfig(
    level=logging.INFO,  # Changed to INFO to capture more logs
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# MongoDB logging handler will be added during startup
mongo_handler = None

# Initialize FastAPI App
app = FastAPI(title="Every Street")

# Mount static files and templates
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static",
)
templates = Jinja2Templates(directory="templates")

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

# Include all the modular routers
app.include_router(pages_router)
app.include_router(admin_api_router)
app.include_router(analytics_api_router)
app.include_router(county_api_router)
app.include_router(coverage_api_router)
app.include_router(driving_routes_router)
app.include_router(export_api_router)
app.include_router(gas_api_router)
app.include_router(live_tracking_api_router)
app.include_router(logs_api_router)
app.include_router(matched_trips_api_router)
app.include_router(processing_api_router)
app.include_router(profile_api_router)
app.include_router(search_api_router)
app.include_router(tasks_api_router)
app.include_router(trips_router)
app.include_router(upload_api_router)
app.include_router(visits_router)


# Global Configuration and Constants (imported from config.py)

# Database collections (for startup initialization)
trips_collection = db_manager.db["trips"]
places_collection = db_manager.db["places"]
live_trips_collection = db_manager.db["live_trips"]
archived_live_trips_collection = db_manager.db["archived_live_trips"]
app_settings_collection = db_manager.db["app_settings"]


# --- Application Lifecycle Events ---
@app.on_event("startup")
async def startup_event():
    """Initialize database indexes and components on application startup."""
    global mongo_handler

    try:
        await init_database()  # This already creates many indexes
        logger.info("Core database initialized successfully (indexes, etc.).")

        # Set up MongoDB logging handler
        mongo_handler = MongoDBHandler(db_manager.db, "server_logs")
        await mongo_handler.setup_indexes()

        # Add the MongoDB handler to the root logger
        root_logger = logging.getLogger()
        mongo_handler.setLevel(logging.INFO)  # Log INFO and above to MongoDB
        root_logger.addHandler(mongo_handler)
        logger.info("MongoDB logging handler initialized and configured.")

        initialize_live_tracking_db(live_trips_collection)
        logger.info("Live tracking DB collections initialized.")

        init_collections(places_collection, trips_collection)
        logger.info("Visits collections initialized.")

        TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN
        )  # Initializes the class, not an instance for immediate use
        logger.info("TripProcessor class initialized (available for use).")

        logger.info("Application startup completed successfully.")

    except Exception as e:
        logger.critical(
            "CRITICAL: Failed to initialize application during startup: %s",
            str(e),
            exc_info=True,
        )
        raise


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources when shutting down."""
    await db_manager.cleanup_connections()
    await cleanup_session()
    logger.info("Application shutdown completed successfully")


# --- Global Exception Handlers ---
@app.exception_handler(404)
async def not_found_handler(request: Request, exc: HTTPException):
    """Handle 404 Not Found errors."""
    logger.warning("404 Not Found: %s. Detail: %s", request.url, exc.detail)
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
        exc_info=True,
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
