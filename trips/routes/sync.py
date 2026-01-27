"""API routes for trips sync actions."""

from __future__ import annotations

import asyncio
import json
import logging
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from core.api import api_route
from trips.models import TripSyncConfigUpdate, TripSyncRequest
from trips.services.trip_sync_service import TripSyncService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/actions/trips/sync/status", response_model=dict)
@api_route(logger)
async def get_trip_sync_status():
    """Get current trip sync status and last activity."""
    return await TripSyncService.get_sync_status()


@router.post("/api/actions/trips/sync", response_model=dict)
@api_route(logger)
async def start_trip_sync(payload: TripSyncRequest | None = None):
    """Trigger a trip sync action."""
    if payload is None:
        payload = TripSyncRequest()
    return await TripSyncService.start_sync(payload)


@router.delete("/api/actions/trips/sync/{job_id}", response_model=dict)
@api_route(logger)
async def cancel_trip_sync(job_id: str):
    """Cancel an active trip sync action."""
    return await TripSyncService.cancel_sync(job_id)


@router.get("/api/actions/trips/sync/config", response_model=dict)
@api_route(logger)
async def get_trip_sync_config():
    """Get sync defaults for trips."""
    return await TripSyncService.get_sync_config()


@router.post("/api/actions/trips/sync/config", response_model=dict)
@api_route(logger)
async def update_trip_sync_config(payload: TripSyncConfigUpdate):
    """Update sync defaults for trips."""
    return await TripSyncService.update_sync_config(payload)


@router.get("/api/actions/trips/sync/sse", response_model=None)
@api_route(logger)
async def stream_trip_sync_updates():
    """Stream trip sync updates via SSE."""

    async def event_generator():
        last_payload = None
        poll_count = 0
        max_polls = 3600

        while poll_count < max_polls:
            poll_count += 1
            try:
                payload = await TripSyncService.get_sync_status()
                payload_json = json.dumps(payload, default=str)
                if payload_json != last_payload:
                    yield f"data: {payload_json}\n\n"
                    last_payload = payload_json
                elif poll_count % 7 == 0:
                    yield ": keepalive\n\n"
                await asyncio.sleep(2)
            except Exception:
                logger.exception("Error streaming trip sync status")
                await asyncio.sleep(2)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
