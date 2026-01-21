"""Profile API package."""

from fastapi import APIRouter

from profile.routes import profile

router = APIRouter()
router.include_router(profile.router, tags=["profile"])

__all__ = ["router"]
