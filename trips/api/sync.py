"""Read-only Historical Trip reconciliation status."""

from __future__ import annotations

from fastapi import APIRouter

from trips.services.trip_sync_service import TripSyncService

router = APIRouter()


@router.get("/api/actions/trips/sync/status", response_model=dict)
async def get_trip_sync_status():
    """Return worker-owned trip reconciliation status."""
    return await TripSyncService.get_sync_status()
