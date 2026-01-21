"""County API package."""

from fastapi import APIRouter

from county.routes import county

router = APIRouter()
router.include_router(county.router, tags=["counties"])

__all__ = ["router"]
