from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock

import pytest

from db.models import Trip
from trips.services import trip_match_mutation_service
from trips.services.trip_match_mutation_service import (
    HistoricalTripMatchMutationService,
)


class _MapMatcherStub:
    def __init__(self, result: dict[str, Any]) -> None:
        self.result = result

    async def map_match_coordinates(
        self,
        _coordinates: list[list[float]],
        _timestamps: list[int | None] | None = None,
    ) -> dict[str, Any]:
        return self.result


def _trip(transaction_id: str) -> Trip:
    return Trip(
        transactionId=transaction_id,
        source="bouncie",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 10, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    )


@pytest.mark.asyncio
async def test_rematch_trip_persists_success_once(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    trip = _trip("tx-match-success")
    await trip.insert()
    bump_revision = AsyncMock()
    sync_trip = AsyncMock()
    monkeypatch.setattr(
        trip_match_mutation_service,
        "bump_trip_map_revision",
        bump_revision,
    )
    monkeypatch.setattr(
        trip_match_mutation_service.MobilityInsightsService,
        "sync_trip",
        sync_trip,
    )

    service = HistoricalTripMatchMutationService(
        _MapMatcherStub(
            {
                "code": "Ok",
                "matchings": [
                    {
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
                        }
                    }
                ],
            }
        )
    )

    result = await service.rematch_trip(trip)
    saved = await Trip.find_one(Trip.transactionId == "tx-match-success")

    assert result.outcome == "matched"
    assert saved is not None
    assert saved.matchStatus == "matched:linestring"
    assert saved.matchedGps is not None
    assert saved.matchedMapPath is not None
    assert bump_revision.await_count == 1
    assert sync_trip.await_count == 1


@pytest.mark.asyncio
async def test_rematch_trip_persists_failure_and_clears_existing_match(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    trip = _trip("tx-match-failure")
    trip.matchedGps = {
        "type": "LineString",
        "coordinates": [[-98.0, 33.0], [-98.1, 33.1]],
    }
    trip.matchStatus = "matched:legacy"
    await trip.insert()
    bump_revision = AsyncMock()
    sync_trip = AsyncMock()
    monkeypatch.setattr(
        trip_match_mutation_service,
        "bump_trip_map_revision",
        bump_revision,
    )
    monkeypatch.setattr(
        trip_match_mutation_service.MobilityInsightsService,
        "sync_trip",
        sync_trip,
    )

    service = HistoricalTripMatchMutationService(
        _MapMatcherStub({"code": "Ok", "matchings": []})
    )

    result = await service.rematch_trip(trip)
    saved = await Trip.find_one(Trip.transactionId == "tx-match-failure")

    assert result.outcome == "failed"
    assert saved is not None
    assert saved.matchStatus == "error:no-geometry"
    assert saved.matchedGps is None
    assert saved.matchedMapPath is None
    assert bump_revision.await_count == 1
    assert sync_trip.await_count == 1
