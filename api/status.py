"""System status API endpoints."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status

from db.models import AppSettings
from tasks.arq import get_arq_pool

router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("/live")
async def liveness_probe() -> dict[str, bool]:
    """Cheap liveness probe for Docker and ingress health checks."""
    return {"ok": True}


@router.get("/ready")
async def readiness_probe() -> dict[str, bool]:
    """Verify the data plane and worker are usable before serving traffic."""
    try:
        await AppSettings.find_one()
        redis = await get_arq_pool()
        await redis.ping()
        raw_heartbeat = await redis.get("arq:worker:heartbeat")
        if not raw_heartbeat:
            raise RuntimeError("Worker heartbeat is missing")
        heartbeat_value = (
            raw_heartbeat.decode()
            if isinstance(raw_heartbeat, bytes | bytearray)
            else str(raw_heartbeat)
        )
        heartbeat = datetime.fromisoformat(heartbeat_value)
        if heartbeat.tzinfo is None:
            heartbeat = heartbeat.replace(tzinfo=UTC)
        if (datetime.now(UTC) - heartbeat).total_seconds() > 180:
            raise RuntimeError("Worker heartbeat is stale")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    return {"ok": True}
