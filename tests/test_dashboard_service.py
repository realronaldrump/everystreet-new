from __future__ import annotations

from datetime import UTC, datetime

import pytest

from analytics.services.dashboard_service import DashboardService


@pytest.mark.asyncio
async def test_get_driving_insights_skips_placeholder_destination_labels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    aggregate_results = [
        [
            {
                "total_trips": 740,
                "total_distance": 10234.5,
            },
        ],
        [
            {
                "_id": None,
                "visits": 690,
                "distance": 8120,
                "total_duration": 40,
                "last_visit": datetime(2026, 2, 1, tzinfo=UTC),
            },
            {
                "_id": "Office",
                "visits": 37,
                "distance": 540,
                "total_duration": 20,
                "last_visit": datetime(2026, 2, 2, tzinfo=UTC),
                "isCustomPlace": True,
            },
            {
                "_id": {"formatted_address": "123 Main St"},
                "visits": 29,
                "distance": 410,
                "total_duration": 18,
                "last_visit": datetime(2026, 2, 3, tzinfo=UTC),
            },
            {
                "_id": "None",
                "visits": 28,
                "distance": 390,
                "total_duration": 11,
                "last_visit": datetime(2026, 2, 4, tzinfo=UTC),
            },
        ],
        [],
    ]
    call_index = {"value": 0}

    async def fake_aggregate_to_list(*_args, **_kwargs):
        result = aggregate_results[call_index["value"]]
        call_index["value"] += 1
        return result

    async def fake_mobility_insights(_query):
        return {"trip_count": 0, "hex_cells": []}

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )
    monkeypatch.setattr(
        "analytics.services.dashboard_service.MobilityInsightsService.get_mobility_insights",
        fake_mobility_insights,
    )

    result = await DashboardService.get_driving_insights({})

    assert result["most_visited"]["location"] == "Office"
    assert result["most_visited"]["count"] == 37
    assert result["most_visited"]["isCustomPlace"] is True
    assert [row["location"] for row in result["top_destinations"]] == [
        "Office",
        "123 Main St",
    ]


@pytest.mark.asyncio
async def test_get_driving_insights_movement_fallback_includes_metric_basis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    aggregate_results = [
        [
            {
                "total_trips": 2,
                "total_distance": 24.5,
            },
        ],
        [],
        [],
    ]
    call_index = {"value": 0}

    async def fake_aggregate_to_list(*_args, **_kwargs):
        result = aggregate_results[call_index["value"]]
        call_index["value"] += 1
        return result

    async def failing_mobility(_query):
        raise RuntimeError("mobility failed")

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )
    monkeypatch.setattr(
        "analytics.services.dashboard_service.MobilityInsightsService.get_mobility_insights",
        failing_mobility,
    )

    result = await DashboardService.get_driving_insights({})

    movement = result["movement"]
    assert movement["trip_count"] == 0
    assert movement["profiled_trip_count"] == 0
    assert movement["metric_basis"]["top_streets_primary"] == "trip_count"
    assert movement["metric_basis"]["top_segments_primary"] == "traversals"
    assert movement["metric_basis"]["map_cells_intensity"] == "traversals"
