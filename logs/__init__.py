"""Server logs API package."""

from fastapi import APIRouter

from logs.routes import logs

router = APIRouter()
router.include_router(logs.router, tags=["logs"])

__all__ = ["router"]
