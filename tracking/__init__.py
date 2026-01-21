"""Live tracking API package."""

from fastapi import APIRouter

from tracking.routes import live, webhooks

router = APIRouter()
router.include_router(live.router, tags=["tracking-live"])
router.include_router(webhooks.router, tags=["tracking-webhooks"])

__all__ = ["router"]
