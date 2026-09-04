from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from db.models import Trip
from exports.serializers import serialize_trip_properties, serialize_trip_record
from trips.pipeline import TripPipeline
from trips.serialization import TripSerializer
from trips.services.bouncie_ingest_runtime import process_bouncie_trips
from trips.services.historical_trip_writer import (
    BouncieHistoricalTripWriter,
    HistoricalTripWrite,
)


def _raw_trip() -> dict:
    return {
        "transactionId": "timezone-storage",
        "imei": "test-device",
        "startTime": "2025-01-01T23:55:00Z",
        "endTime": "2025-01-02T00:05:00Z",
        "timeZone": "-0600",
        "startTimeZone": None,
        "endTimeZone": "",
        "gps": {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.001, 32.001]],
        },
    }


@pytest.fixture
def pipeline(monkeypatch: pytest.MonkeyPatch) -> TripPipeline:
    pipeline = TripPipeline()
    monkeypatch.setattr(pipeline, "_enqueue_geo_coverage_sync_for_ingest", AsyncMock())
    return pipeline


@pytest.mark.parametrize("prevalidated", [False, True])
async def test_historical_writer_stores_canonical_timezone_fields(
    beanie_db, pipeline: TripPipeline, prevalidated: bool
) -> None:
    raw = _raw_trip()
    original = deepcopy(raw)
    writer = BouncieHistoricalTripWriter(pipeline)
    await writer.write(
        HistoricalTripWrite(
            raw_data=raw,
            prevalidated_data=dict(raw) if prevalidated else None,
            do_map_match=False,
            do_geocode=False,
            do_coverage=False,
            sync_mobility=False,
            bump_revision=False,
        )
    )

    stored = await beanie_db.trips.find_one({"transactionId": raw["transactionId"]})
    assert stored is not None
    assert stored["source"] == "bouncie"
    assert stored["startTimeZone"] == "-0600"
    assert stored["endTimeZone"] == "-0600"
    assert "timeZone" not in stored
    assert raw == original

    for serialize in (
        TripSerializer.to_dict,
        serialize_trip_record,
        serialize_trip_properties,
    ):
        exported = serialize(stored)
        assert exported["startTimeZone"] == "-0600"
        assert exported["endTimeZone"] == "-0600"
        assert "timeZone" not in exported


@pytest.mark.parametrize("mode", ["insert_only", "upsert_bouncie"])
async def test_historical_ingest_persists_source_timezone_when_fields_are_empty(
    beanie_db, pipeline: TripPipeline, mode: str
) -> None:
    result = await process_bouncie_trips(
        [_raw_trip()],
        pipeline=pipeline,
        mode=mode,
        do_map_match=False,
        do_geocode=False,
        do_coverage=False,
        sync_mobility=False,
        bump_revision=False,
    )
    assert result["counters"]["inserted"] == 1
    stored = await beanie_db.trips.find_one({"transactionId": "timezone-storage"})
    assert stored["startTimeZone"] == "-0600"
    assert stored["endTimeZone"] == "-0600"
    assert "timeZone" not in stored


@pytest.mark.parametrize("missing_field", ["startTimeZone", "endTimeZone"])
async def test_sync_repairs_timezone_metadata_on_an_already_processed_trip(
    beanie_db, pipeline: TripPipeline, missing_field: str
) -> None:
    existing = {
        "transactionId": "timezone-storage",
        "source": "bouncie",
        "status": "processed",
        "processing_state": "completed",
        "startTime": datetime(2025, 1, 1, 23, 55, tzinfo=UTC),
        "endTime": datetime(2025, 1, 2, 0, 5, tzinfo=UTC),
        "startTimeZone": "-0600",
        "endTimeZone": "-0600",
        "inactive": True,
        missing_field: None,
    }
    await Trip(**existing).insert()
    kwargs = {
        "pipeline": pipeline,
        "mode": "upsert_bouncie",
        "do_map_match": False,
        "do_geocode": False,
        "do_coverage": False,
        "sync_mobility": False,
        "bump_revision": False,
    }
    result = await process_bouncie_trips([_raw_trip()], **kwargs)
    assert result["counters"]["updated"] == 1
    stored = await beanie_db.trips.find_one({"transactionId": "timezone-storage"})
    assert stored["startTimeZone"] == "-0600"
    assert stored["endTimeZone"] == "-0600"
    assert stored["inactive"] is True
    assert await beanie_db.trips.count_documents({}) == 1

    repeated = await process_bouncie_trips([_raw_trip()], **kwargs)
    assert repeated["counters"]["skipped_existing"] == 1
    assert repeated["counters"]["updated"] == 0
