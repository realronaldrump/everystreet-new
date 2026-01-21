"""Driving navigation API package."""

from fastapi import APIRouter

from driving.routes import routes

router = APIRouter()
router.include_router(routes.router, tags=["driving"])

__all__ = ["router"]
