from __future__ import annotations

from typing import Any

import pytest

from core.date_utils import get_current_utc_time
from db.models import Trip
from trips.pipeline import TripPipeline


class StubMatcher:
    def __init__(self, status: str = "matched") -> None:
        self.status = status

    async def map_match(self, processed_data: dict[str, Any]):
        if self.status == "matched":
            processed_data["matchedGps"] = processed_data.get("gps")
            processed_data["matchStatus"] = "matched:linestring"
            return "matched", processed_data

        processed_data["matchStatus"] = "error:valhalla"
        return "failed", processed_data


class StubGeocoder:
    async def geocode(self, processed_data: dict[str, Any]) -> dict[str, Any]:
        processed_data["startLocation"] = {"formatted_address": "Start"}
        processed_data["destination"] = {"formatted_address": "End"}
        processed_data["geocoded_at"] = get_current_utc_time()
        return processed_data


def _build_raw_trip(transaction_id: str) -> dict[str, Any]:
    return {
        "transactionId": transaction_id,
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:10:00Z",
    }


async def _noop_coverage(*_args: Any, **_kwargs: Any) -> int:
    return 0


@pytest.mark.asyncio
async def test_trip_pipeline_happy_path(beanie_db) -> None:
    calls: list[tuple[dict[str, Any], Any]] = []

    async def coverage_stub(trip_data: dict[str, Any], trip_id: Any) -> int:
        calls.append((trip_data, trip_id))
        return 1

    pipeline = TripPipeline(
        geo_service=StubGeocoder(),
        matcher=StubMatcher(),
        coverage_service=coverage_stub,
    )

    trip = await pipeline.process_raw_trip(
        _build_raw_trip("tx-1"),
        source="test",
        do_map_match=True,
        do_geocode=True,
        do_coverage=True,
    )

    assert trip is not None
    assert trip.transactionId == "tx-1"
    assert trip.processing_state == "map_matched"
    assert trip.matchedGps is not None
    assert trip.startGeoPoint is not None
    assert trip.destinationGeoPoint is not None
    assert len(calls) == 1
    assert calls[0][1] is not None

    saved = await Trip.find_one(Trip.transactionId == "tx-1")
    assert saved is not None


@pytest.mark.asyncio
async def test_trip_pipeline_invalid_trip_returns_none(beanie_db) -> None:
    pipeline = TripPipeline(
        geo_service=StubGeocoder(),
        matcher=StubMatcher(),
        coverage_service=_noop_coverage,
    )

    trip = await pipeline.process_raw_trip({"transactionId": "bad-trip"})
    assert trip is None


@pytest.mark.asyncio
async def test_trip_pipeline_handles_map_match_failure(beanie_db) -> None:
    pipeline = TripPipeline(
        geo_service=StubGeocoder(),
        matcher=StubMatcher(status="failed"),
        coverage_service=_noop_coverage,
    )

    trip = await pipeline.process_raw_trip(
        _build_raw_trip("tx-2"),
        source="test",
        do_map_match=True,
        do_geocode=True,
        do_coverage=True,
    )

    assert trip is not None
    assert trip.processing_state == "completed"
    assert trip.matchStatus is not None
    assert trip.matchStatus.startswith("error:")


@pytest.mark.asyncio
async def test_trip_pipeline_insert_only_inserts_new_trip(beanie_db) -> None:
    calls: list[tuple[dict[str, Any], Any]] = []

    async def coverage_stub(trip_data: dict[str, Any], trip_id: Any) -> int:
        calls.append((trip_data, trip_id))
        return 1

    pipeline = TripPipeline(
        geo_service=StubGeocoder(),
        matcher=StubMatcher(),
        coverage_service=coverage_stub,
    )

    trip = await pipeline.process_raw_trip_insert_only(
        _build_raw_trip("tx-insert-only-1"),
        source="test",
        do_map_match=False,
        do_geocode=True,
        do_coverage=True,
    )

    assert trip is not None
    assert trip.transactionId == "tx-insert-only-1"
    assert len(calls) == 1

    saved = await Trip.find_one(Trip.transactionId == "tx-insert-only-1")
    assert saved is not None


@pytest.mark.asyncio
async def test_trip_pipeline_insert_only_skips_existing_trip_without_modification(
    beanie_db,
) -> None:
    coverage_calls: list[tuple[dict[str, Any], Any]] = []

    async def coverage_stub(trip_data: dict[str, Any], trip_id: Any) -> int:
        coverage_calls.append((trip_data, trip_id))
        return 1

    pipeline = TripPipeline(
        geo_service=StubGeocoder(),
        matcher=StubMatcher(),
        coverage_service=coverage_stub,
    )

    existing = Trip(**_build_raw_trip("tx-existing-1"))
    existing.source = "seed"
    existing.matchStatus = "seed-match"
    await existing.insert()

    result = await pipeline.process_raw_trip_insert_only(
        _build_raw_trip("tx-existing-1"),
        source="new-source",
        do_map_match=False,
        do_geocode=True,
        do_coverage=True,
    )

    assert result is None
    assert len(coverage_calls) == 0

    saved = await Trip.find_one(Trip.transactionId == "tx-existing-1")
    assert saved is not None
    assert saved.source == "seed"
    assert saved.matchStatus == "seed-match"
