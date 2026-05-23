"""System status API endpoints."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("/live")
async def liveness_probe() -> dict[str, bool]:
    """Cheap liveness probe for Docker and ingress health checks."""
    return {"ok": True}
