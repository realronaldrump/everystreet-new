"""Admin API package."""

from fastapi import APIRouter

from admin.api import collections, settings

router = APIRouter()
router.include_router(settings.router, tags=["admin-settings"])
router.include_router(collections.router, tags=["admin-collections"])

__all__ = ["router"]
