from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from analytics.services.mobility_insights_service import MobilityInsightsService
from db.models import H3StreetLabelCache, Trip, TripMobilityProfile


@pytest.fixture
async def mobility_db():
    client = AsyncMongoMockClient()
    database = client["test_mobility_db"]
    await init_beanie(
        database=database,
        document_models=[Trip, TripMobilityProfile, H3StreetLabelCache],
    )
    return database


@pytest.mark.asyncio
async def test_sync_trip_creates_profile_and_marks_trip_synced(mobility_db) -> None:
    now = datetime.now(UTC)
    trip = Trip(
        transactionId="trip-sync-1",
        imei="imei-a",
        startTime=now - timedelta(minutes=20),
        endTime=now - timedelta(minutes=5),
        gps={
            "type": "LineString",
            "coordinates": [
                [-122.4312, 37.7731],
                [-122.4250, 37.7765],
                [-122.4185, 37.7801],
            ],
        },
    )
    await trip.insert()

    synced = await MobilityInsightsService.sync_trip(trip)
    assert synced is True

    profile = await TripMobilityProfile.find_one({"trip_id": trip.id})
    assert profile is not None
    assert profile.transaction_id == "trip-sync-1"
    assert profile.cell_counts
    assert profile.segment_counts

    refreshed = await Trip.get(trip.id)
    assert refreshed is not None
    assert refreshed.mobility_synced_at is not None


@pytest.mark.asyncio
async def test_get_mobility_insights_aggregates_segments_and_streets(mobility_db) -> None:
    now = datetime.now(UTC)
    trip = Trip(
        transactionId="trip-sync-2",
        imei="imei-b",
        startTime=now - timedelta(hours=1),
        endTime=now - timedelta(minutes=30),
        gps={
            "type": "LineString",
            "coordinates": [
                [-122.4462, 37.7685],
                [-122.4365, 37.7728],
                [-122.4270, 37.7772],
                [-122.4174, 37.7816],
            ],
        },
    )
    await trip.insert()
    await MobilityInsightsService.sync_trip(trip)

    profile = await TripMobilityProfile.find_one({"trip_id": trip.id})
    assert profile is not None
    assert profile.cell_counts

    # Seed the street-name cache so top-street grouping can be asserted
    first_cell = profile.cell_counts[0].h3
    await H3StreetLabelCache(
        h3_cell=first_cell,
        resolution=profile.h3_resolution,
        street_name="Market Street",
        normalized_street_name="market street",
    ).insert()

    insights = await MobilityInsightsService.get_mobility_insights({})

    assert insights["trip_count"] == 1
    assert insights["profiled_trip_count"] == 1
    assert insights["hex_cells"]
    assert insights["top_segments"]
    assert "label" in insights["top_segments"][0]
    assert "|" not in insights["top_segments"][0]["label"]
    assert insights["map_center"] is not None
    assert any(
        cell.get("street_name") == "Market Street"
        for cell in insights.get("hex_cells", [])
    )
    assert any(
        row.get("street_name") == "Market Street"
        for row in insights.get("top_streets", [])
    )
