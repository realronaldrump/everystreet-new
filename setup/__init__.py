"""Setup API package."""

from fastapi import APIRouter

from setup.routes import bouncie, configuration, wizard

router = APIRouter()
router.include_router(wizard.router, tags=["setup"])
router.include_router(bouncie.router, tags=["bouncie-oauth"])
router.include_router(configuration.router, tags=["setup-config"])

__all__ = ["router"]
