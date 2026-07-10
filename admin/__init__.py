"""Admin API package."""

from fastapi import APIRouter

from admin.api import settings

router = APIRouter()
router.include_router(settings.router, tags=["admin-settings"])

__all__ = ["router"]
