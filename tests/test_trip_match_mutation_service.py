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
        self.calls: list[dict[str, Any]] = []

    async def map_match_coordinates(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "coordinates": coordinates,
                "timestamps": timestamps,
                "kwargs": kwargs,
            }
        )
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


def test_extract_unix_timestamps_interpolates_from_trip_bounds() -> None:
    coords = [[-97.0, 32.0], [-97.1, 32.1], [-97.2, 32.2]]
    trip_data = {
        "startTime": datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        "endTime": datetime(2025, 1, 1, 12, 0, 10, tzinfo=UTC),
    }

    timestamps = (
        HistoricalTripMatchMutationService._extract_unix_timestamps_for_coordinates(
            coords,
            trip_data,
        )
    )

    assert timestamps == [1735732800, 1735732805, 1735732810]


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

    matcher = _MapMatcherStub(
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
    service = HistoricalTripMatchMutationService(matcher)

    result = await service.rematch_trip(trip)
    saved = await Trip.find_one(Trip.transactionId == "tx-match-success")

    assert result.outcome == "matched"
    assert saved is not None
    assert saved.matchStatus == "matched:linestring"
    assert saved.matchedGps is not None
    assert saved.matchedMapPath is not None
    assert matcher.calls[0]["kwargs"]["mapbox_timestamps"] == [
        1735732800,
        1735733400,
    ]
    assert bump_revision.await_count == 1
    assert sync_trip.await_count == 1


@pytest.mark.asyncio
async def test_rematch_trip_persists_provider_metadata(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    trip = _trip("tx-match-provider-metadata")
    await trip.insert()
    monkeypatch.setattr(
        trip_match_mutation_service,
        "bump_trip_map_revision",
        AsyncMock(),
    )
    monkeypatch.setattr(
        trip_match_mutation_service.MobilityInsightsService,
        "sync_trip",
        AsyncMock(),
    )

    service = HistoricalTripMatchMutationService(
        _MapMatcherStub(
            {
                "code": "Ok",
                "provider": "mapbox",
                "fallback_used": True,
                "confidence": 0.84,
                "attempts": [
                    {
                        "provider": "valhalla",
                        "status": "failed",
                        "message": "low-quality-match:too-short",
                    },
                    {"provider": "mapbox", "status": "matched"},
                ],
                "mapbox_requests": 1,
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

    result = await service.rematch_trip(trip, provider_policy="auto")
    saved = await Trip.find_one(Trip.transactionId == "tx-match-provider-metadata")

    assert result.outcome == "matched"
    assert result.provider == "mapbox"
    assert result.fallback_used is True
    assert result.mapbox_requests == 1
    assert saved is not None
    assert saved.matchedGps is not None
    assert saved.matchedMapPath is not None
    assert saved.matchProvider == "mapbox"
    assert saved.matchFallbackUsed is True
    assert saved.matchConfidence == 0.84
    assert saved.matchAttemptSummary == [
        {
            "provider": "valhalla",
            "status": "failed",
            "message": "low-quality-match:too-short",
        },
        {"provider": "mapbox", "status": "matched"},
    ]


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


@pytest.mark.asyncio
async def test_rematch_trip_rejects_low_quality_matched_geometry(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    trip = _trip("tx-match-low-quality")
    trip.matchedGps = {
        "type": "LineString",
        "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
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
        _MapMatcherStub(
            {
                "code": "Ok",
                "matchings": [
                    {
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[-97.0, 32.0], [-97.001, 32.001]],
                        }
                    }
                ],
            }
        )
    )

    result = await service.rematch_trip(trip)
    saved = await Trip.find_one(Trip.transactionId == "tx-match-low-quality")

    assert result.outcome == "failed"
    assert saved is not None
    assert saved.matchStatus is not None
    assert saved.matchStatus.startswith("error:low-quality-match:too-short")
    assert saved.matchedGps is None
    assert saved.matchedMapPath is None
    assert bump_revision.await_count == 1
    assert sync_trip.await_count == 1


@pytest.mark.asyncio
async def test_clear_match_clears_provider_metadata(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    trip = _trip("tx-clear-provider-metadata")
    trip.matchedGps = {
        "type": "LineString",
        "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
    }
    trip.matchStatus = "matched:linestring"
    trip.matchProvider = "mapbox"
    trip.matchFallbackUsed = True
    trip.matchConfidence = 0.75
    trip.matchAttemptSummary = [{"provider": "mapbox", "status": "matched"}]
    await trip.insert()
    monkeypatch.setattr(
        trip_match_mutation_service,
        "bump_trip_map_revision",
        AsyncMock(),
    )
    monkeypatch.setattr(
        trip_match_mutation_service.MobilityInsightsService,
        "sync_trip",
        AsyncMock(),
    )

    service = HistoricalTripMatchMutationService()

    result = await service.clear_match(trip)
    saved = await Trip.find_one(Trip.transactionId == "tx-clear-provider-metadata")

    assert result.outcome == "skipped"
    assert saved is not None
    assert saved.matchedGps is None
    assert saved.matchedMapPath is None
    assert saved.matchStatus is None
    assert saved.matchProvider is None
    assert saved.matchFallbackUsed is None
    assert saved.matchConfidence is None
    assert saved.matchAttemptSummary is None
