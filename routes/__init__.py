"""Routes package for the unified coverage system.

This package contains FastAPI routers for the new coverage API:
- areas: Unified area CRUD operations
- viewport: Viewport-based street/coverage queries
- overrides: Manual coverage overrides
- routing: On-demand route generation
"""

from routes.areas import router as areas_router
from routes.overrides import router as overrides_router
from routes.routing import router as routing_router
from routes.viewport import router as viewport_router

__all__ = ["areas_router", "viewport_router", "overrides_router", "routing_router"]
