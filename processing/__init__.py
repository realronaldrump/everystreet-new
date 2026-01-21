"""Processing API package."""

from fastapi import APIRouter

from processing.routes import processing

router = APIRouter()
router.include_router(processing.router, tags=["processing"])

__all__ = ["router"]
