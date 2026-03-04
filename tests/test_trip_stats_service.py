from __future__ import annotations

import pytest

from trips.services.trip_stats_service import TripStatsService


@pytest.mark.asyncio
async def test_geocode_trips_rejects_negative_interval_days() -> None:
    service = TripStatsService(trip_service=object())  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="Invalid date range"):
        await service.geocode_trips(interval_days=-1)
