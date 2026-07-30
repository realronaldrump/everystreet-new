from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from db.models import Trip
from trips.services.trip_query_service import TripQueryService


@pytest.mark.asyncio
async def test_get_trips_datatable_includes_canonical_timezone_fields(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-timezone",
        source="bouncie",
        startTime=datetime(2026, 3, 1, 10, 0, tzinfo=UTC),
        endTime=datetime(2026, 3, 1, 11, 0, tzinfo=UTC),
        startTimeZone="America/Chicago",
        endTimeZone="America/Chicago",
        gps={
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
        distance=10.0,
        maxSpeed=50.0,
    ).insert()

    result = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[],
        columns=[],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    assert result["recordsFiltered"] == 1
    row = result["data"][0]
    assert row["startTimeZone"] == "America/Chicago"
    assert row["endTimeZone"] == "America/Chicago"
    assert "timeZone" not in row


@pytest.mark.asyncio
async def test_get_trips_datatable_treats_search_as_literal(beanie_db) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-literal",
        source="bouncie",
        imei="plain-imei",
        startTime=datetime(2026, 3, 1, 10, 0, tzinfo=UTC),
        endTime=datetime(2026, 3, 1, 11, 0, tzinfo=UTC),
    ).insert()

    result = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value=".*",
        order=[],
        columns=[],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    assert result["recordsFiltered"] == 0
    assert result["data"] == []


@pytest.mark.asyncio
async def test_estimated_cost_sort_uses_historical_price_and_fuel_product(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db
    captured_pipeline: list[dict] | None = None

    async def capture_aggregation(_model, pipeline, **_kwargs):
        nonlocal captured_pipeline
        captured_pipeline = pipeline
        return []

    monkeypatch.setattr(
        "trips.services.trip_query_service.aggregate_to_list",
        capture_aggregation,
    )

    await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[{"column": 0, "dir": "desc"}],
        columns=[{"data": "estimated_cost"}],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    assert captured_pipeline is not None
    lookup_stage = next(
        stage
        for stage in captured_pipeline
        if stage.get("$lookup", {}).get("from") == "gas_fillups"
    )
    lookup_conditions = lookup_stage["$lookup"]["pipeline"][0]["$match"]["$expr"][
        "$and"
    ]
    assert {"$ne": ["$imei", None]} in lookup_conditions
    assert {"$ne": ["$imei", ""]} in lookup_conditions
    assert {"$ne": ["$$tripImei", None]} in lookup_conditions
    assert {"$ne": ["$$tripImei", ""]} in lookup_conditions
    estimated_cost_stage = next(
        stage
        for stage in captured_pipeline
        if "estimatedCostSort" in stage.get("$addFields", {})
    )
    assert estimated_cost_stage["$addFields"]["estimatedCostSort"]["$cond"][1] == {
        "$multiply": ["$costFuel", "$costPrice"]
    }
    sort_stage = next(
        stage
        for stage in captured_pipeline
        if "estimatedCostSort" in stage.get("$sort", {})
    )
    assert sort_stage["$sort"]["estimatedCostSort"] == -1


@pytest.mark.asyncio
async def test_datatable_filtered_summary_and_badges_cover_all_pages(beanie_db) -> None:
    del beanie_db
    base = datetime(2026, 3, 1, 10, 0, tzinfo=UTC)
    for index in range(30):
        start = base.replace(minute=index)
        await Trip(
            transactionId=f"tx-summary-{index}",
            source="bouncie",
            imei="summary-imei",
            startTime=start,
            endTime=start + timedelta(hours=1),
            distance=10.0 + index,
            fuelConsumed=1.0,
            inactive=index == 0,
            startLocation={"formatted_address": "Origin"},
            destination={"formatted_address": "Destination"},
        ).insert()

    result = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[],
        columns=[],
        filters={"distance_min": "10"},
        start_date=None,
        end_date=None,
        price_map={},
    )

    assert len(result["data"]) == 10
    assert result["recordsFiltered"] == 30
    assert result["filteredSummary"] == {
        "totalTrips": 29,
        "totalDistance": pytest.approx(725.0),
        "distanceTripCount": 29,
        "totalDurationSeconds": pytest.approx(29 * 3600.0),
        "durationTripCount": 29,
        "totalFuel": pytest.approx(29.0),
        "fuelTripCount": 29,
        "longestDistance": pytest.approx(39.0),
    }
    longest = next(row for row in result["data"] if row["distance"] == 39.0)
    assert longest["isLongest"] is True
    assert all(row["isFrequentRoute"] for row in result["data"])


@pytest.mark.asyncio
async def test_datatable_filtered_summary_does_not_label_partial_sums_as_totals(
    beanie_db,
) -> None:
    del beanie_db
    start = datetime(2026, 3, 2, 10, 0, tzinfo=UTC)
    await Trip(
        transactionId="tx-partial-distance",
        source="bouncie",
        startTime=start,
        endTime=start + timedelta(minutes=30),
        distance=10.0,
        fuelConsumed=None,
    ).insert()
    await Trip(
        transactionId="tx-partial-fuel",
        source="bouncie",
        startTime=start + timedelta(hours=1),
        endTime=None,
        distance=None,
        fuelConsumed=1.0,
    ).insert()

    result = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[],
        columns=[],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    summary = result["filteredSummary"]
    assert summary["totalTrips"] == 2
    assert summary["distanceTripCount"] == 1
    assert summary["totalDistance"] is None
    assert summary["durationTripCount"] == 1
    assert summary["totalDurationSeconds"] is None
    assert summary["fuelTripCount"] == 1
    assert summary["totalFuel"] is None
