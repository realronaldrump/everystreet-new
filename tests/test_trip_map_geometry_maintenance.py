from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from db.models import Trip
from tasks import maintenance
from trips.services.trip_display_geometry import DISPLAY_GEOMETRY_VERSION
from trips.services.trip_map_geometry import build_encoded_path_metadata


class _JobHandleStub:
    def __init__(self) -> None:
        self.update = AsyncMock()


@pytest.mark.asyncio
async def test_map_geometry_backfill_normalizes_only_degenerate_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await init_mock_beanie(Trip)

    display_point = Trip(
        transactionId="tx-display-point",
        source="bouncie",
        startTime=datetime(2024, 1, 1, tzinfo=UTC),
        endTime=datetime(2024, 1, 1, 0, 1, tzinfo=UTC),
        gps={"type": "Point", "coordinates": [-97.0, 32.0]},
        displayGps={"type": "Point", "coordinates": [-97.0, 32.0]},
        displayGpsStatus="unchanged",
        displayGpsVersion=DISPLAY_GEOMETRY_VERSION,
    )
    await display_point.insert()

    display_line = {
        "type": "LineString",
        "coordinates": [[-97.0, 32.0], [-97.0001, 32.0001]],
    }
    matched_point = Trip(
        transactionId="tx-matched-point",
        source="bouncie",
        startTime=datetime(2026, 1, 1, tzinfo=UTC),
        endTime=datetime(2026, 1, 1, 0, 1, tzinfo=UTC),
        gps=display_line,
        displayGps=display_line,
        displayGpsStatus="unchanged",
        displayGpsVersion=DISPLAY_GEOMETRY_VERSION,
        displayMapPath=build_encoded_path_metadata(
            display_line,
            geometry_source="displayGps",
        ),
        matchedGps={"type": "Point", "coordinates": [-97.0, 32.0]},
        matchStatus="matched:linestring",
        matchProvider="valhalla",
    )
    await matched_point.insert()

    job_handle = _JobHandleStub()
    monkeypatch.setattr(
        maintenance,
        "create_job",
        AsyncMock(return_value=job_handle),
    )
    sync_trip = AsyncMock()
    monkeypatch.setattr(
        maintenance.MobilityInsightsService,
        "sync_trip",
        sync_trip,
    )
    monkeypatch.setattr(maintenance, "bump_trip_map_revision", AsyncMock())

    result = await maintenance._backfill_trip_display_geometry_logic()

    saved_display_point = await Trip.find_one(
        Trip.transactionId == "tx-display-point",
    )
    saved_matched_point = await Trip.find_one(
        Trip.transactionId == "tx-matched-point",
    )
    assert result["processed_count"] == 1
    assert result["normalized_degenerate_matches"] == 1
    assert saved_display_point is not None
    assert saved_display_point.displayGps is not None
    assert saved_display_point.displayGps["type"] == "Point"
    assert saved_matched_point is not None
    assert saved_matched_point.matchedGps is None
    assert saved_matched_point.matchedMapPath is None
    assert saved_matched_point.matchStatus == "skipped:degenerate-match"
    assert saved_matched_point.matchProvider is None
    assert sync_trip.await_count == 1
