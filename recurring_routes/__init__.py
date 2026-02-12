"""
Recurring routes (route templates) module.

Derives route templates from stored trips and exposes APIs + pages for
browsing them.
"""

from fastapi import APIRouter

from recurring_routes.api import pages, routes

router = APIRouter()

router.include_router(pages.router, tags=["Pages"])
router.include_router(routes.router, tags=["recurring-routes"])

__all__ = ["router"]
