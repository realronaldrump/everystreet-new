"""Search API package."""

from fastapi import APIRouter

from search.routes import search

router = APIRouter()
router.include_router(search.router, tags=["search"])

__all__ = ["router"]
