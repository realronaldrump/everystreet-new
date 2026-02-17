from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import h3
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


async def _seed_trip_with_profile(
    *,
    transaction_id: str,
    imei: str,
    cell_counts: list[dict[str, object]],
    segment_counts: list[dict[str, object]] | None = None,
) -> Trip:
    now = datetime.now(UTC)
    trip = Trip(
        transactionId=transaction_id,
        imei=imei,
        startTime=now - timedelta(minutes=30),
        endTime=now - timedelta(minutes=10),
        gps={
            "type": "LineString",
            "coordinates": [
                [-122.4312, 37.7731],
                [-122.4250, 37.7765],
            ],
        },
        mobility_synced_at=now,
    )
    await trip.insert()

    profile = TripMobilityProfile(
        trip_id=trip.id,
        transaction_id=transaction_id,
        imei=imei,
        start_time=trip.startTime,
        end_time=trip.endTime,
        h3_resolution=11,
        sample_spacing_m=30.0,
        source_geometry="gps",
        total_distance_miles=3.2,
        cell_counts=cell_counts,
        segment_counts=segment_counts or [],
        updated_at=now,
    )
    await profile.insert()
    return trip


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
    assert "metric_basis" in insights
    assert insights["metric_basis"]["top_streets_primary"] == "trip_count"
    assert insights["metric_basis"]["top_segments_primary"] == "traversals"
    assert insights["metric_basis"]["map_cells_intensity"] == "traversals"


@pytest.mark.asyncio
async def test_top_street_uses_distinct_trip_count_not_cell_traversals(
    mobility_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        MobilityInsightsService,
        "sync_unsynced_trips_for_query",
        AsyncMock(return_value=(0, 0)),
    )

    c1 = h3.latlng_to_cell(37.7749, -122.4194, 11)
    c2 = h3.latlng_to_cell(37.7810, -122.4194, 11)
    c3 = h3.latlng_to_cell(37.7870, -122.4194, 11)

    await _seed_trip_with_profile(
        transaction_id="trip-long-street-1",
        imei="imei-long-1",
        cell_counts=[
            {"h3": c1, "traversals": 38, "distance_miles": 0.8},
            {"h3": c2, "traversals": 34, "distance_miles": 0.9},
            {"h3": c3, "traversals": 29, "distance_miles": 0.7},
        ],
        segment_counts=[
            {
                "segment_key": f"{c1}|{c2}",
                "h3_a": c1,
                "h3_b": c2,
                "traversals": 30,
                "distance_miles": 0.9,
            },
        ],
    )

    for cell in (c1, c2, c3):
        await H3StreetLabelCache(
            h3_cell=cell,
            resolution=11,
            street_name="Long Street",
            normalized_street_name="long street",
        ).insert()

    insights = await MobilityInsightsService.get_mobility_insights({})
    assert insights["top_streets"]
    top = insights["top_streets"][0]
    assert top["street_name"] == "Long Street"
    assert top["trip_count"] == 1
    assert top["traversals"] == 101
    assert top["traversals"] > top["trip_count"]


@pytest.mark.asyncio
async def test_top_street_sort_prioritizes_trip_count_over_traversals(
    mobility_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        MobilityInsightsService,
        "sync_unsynced_trips_for_query",
        AsyncMock(return_value=(0, 0)),
    )

    alpha_cell = h3.latlng_to_cell(37.7600, -122.4300, 11)
    beta_cell = h3.latlng_to_cell(37.7900, -122.4100, 11)

    await _seed_trip_with_profile(
        transaction_id="trip-alpha-1",
        imei="imei-alpha-1",
        cell_counts=[{"h3": alpha_cell, "traversals": 11, "distance_miles": 0.6}],
    )
    await _seed_trip_with_profile(
        transaction_id="trip-alpha-2",
        imei="imei-alpha-2",
        cell_counts=[{"h3": alpha_cell, "traversals": 9, "distance_miles": 0.4}],
    )
    await _seed_trip_with_profile(
        transaction_id="trip-beta-1",
        imei="imei-beta-1",
        cell_counts=[{"h3": beta_cell, "traversals": 120, "distance_miles": 1.5}],
    )

    await H3StreetLabelCache(
        h3_cell=alpha_cell,
        resolution=11,
        street_name="Alpha Avenue",
        normalized_street_name="alpha avenue",
    ).insert()
    await H3StreetLabelCache(
        h3_cell=beta_cell,
        resolution=11,
        street_name="Beta Boulevard",
        normalized_street_name="beta boulevard",
    ).insert()

    insights = await MobilityInsightsService.get_mobility_insights({})
    streets = insights["top_streets"]
    assert streets[0]["street_name"] == "Alpha Avenue"
    assert streets[0]["trip_count"] == 2
    assert streets[1]["street_name"] == "Beta Boulevard"
    assert streets[1]["trip_count"] == 1
    assert streets[1]["traversals"] > streets[0]["traversals"]


@pytest.mark.asyncio
async def test_top_segments_include_trip_count_and_traversal_contract(
    mobility_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        MobilityInsightsService,
        "sync_unsynced_trips_for_query",
        AsyncMock(return_value=(0, 0)),
    )

    seg_a = h3.latlng_to_cell(37.7680, -122.4450, 11)
    seg_b = h3.latlng_to_cell(37.7720, -122.4380, 11)
    seg_key = "|".join(sorted([seg_a, seg_b]))

    await _seed_trip_with_profile(
        transaction_id="trip-segment-1",
        imei="imei-seg-1",
        cell_counts=[{"h3": seg_a, "traversals": 6, "distance_miles": 0.4}],
        segment_counts=[
            {
                "segment_key": seg_key,
                "h3_a": min(seg_a, seg_b),
                "h3_b": max(seg_a, seg_b),
                "traversals": 14,
                "distance_miles": 0.8,
            },
        ],
    )
    await _seed_trip_with_profile(
        transaction_id="trip-segment-2",
        imei="imei-seg-2",
        cell_counts=[{"h3": seg_b, "traversals": 7, "distance_miles": 0.5}],
        segment_counts=[
            {
                "segment_key": seg_key,
                "h3_a": min(seg_a, seg_b),
                "h3_b": max(seg_a, seg_b),
                "traversals": 9,
                "distance_miles": 0.6,
            },
        ],
    )

    await H3StreetLabelCache(
        h3_cell=seg_a,
        resolution=11,
        street_name="Segment Street",
        normalized_street_name="segment street",
    ).insert()
    await H3StreetLabelCache(
        h3_cell=seg_b,
        resolution=11,
        street_name="Segment Street",
        normalized_street_name="segment street",
    ).insert()

    insights = await MobilityInsightsService.get_mobility_insights({})
    assert insights["top_segments"]
    top_segment = insights["top_segments"][0]
    assert "trip_count" in top_segment
    assert "traversals" in top_segment
    assert top_segment["trip_count"] == 2
    assert top_segment["traversals"] == 23
