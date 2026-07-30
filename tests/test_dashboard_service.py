from __future__ import annotations

from datetime import UTC, datetime

import pytest

from analytics.services.dashboard_service import DashboardService
from db.aggregation_utils import build_mongo_tz_valid_expr


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
async def test_get_driving_insights_movement_default_includes_metric_basis(
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
        msg = "mobility failed"
        raise RuntimeError(msg)

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
    assert movement["analyzed_trip_count"] == 0
    assert movement["analysis_scope"]["geometry_source"] == "matchedGps"
    assert movement["metric_basis"]["top_streets_primary"] == "times_driven"
    assert movement["metric_basis"]["top_segments_primary"] == "times_driven"
    assert movement["metric_basis"]["map_cells_intensity"] == "times_driven"
    assert movement["validation"]["errors"] == []


@pytest.mark.asyncio
async def test_get_driving_insights_pairs_fuel_and_distance_for_mpg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pipelines: list[list[dict]] = []

    async def fake_aggregate_to_list(_model, pipeline, **_kwargs):
        pipelines.append(pipeline)
        return []

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )

    await DashboardService.get_driving_insights({}, include_movement=False)

    group = pipelines[0][2]["$group"]
    fuel_condition = group["fuel_consumed_for_mpg"]["$sum"]["$cond"][0]
    distance_condition = group["fuel_distance"]["$sum"]["$cond"][0]
    assert fuel_condition == distance_condition
    assert group["fuel_consumed_for_mpg"]["$sum"]["$cond"][1] == "$insightFuel"
    assert group["fuel_distance"]["$sum"]["$cond"][1] == "$insightDistance"


@pytest.mark.asyncio
async def test_get_metrics_returns_aggregated_trip_totals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_aggregate_to_list(*_args, **_kwargs):
        return [
            {
                "total_trips": 2,
                "total_distance": 30.0,
                "avg_distance": 15.0,
                "max_speed": 70.0,
                "avg_speed": 30.0,
                "total_duration_seconds": 3600.0,
                "start_hours_local": [10, 12],
            },
        ]

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )

    result = await DashboardService.get_metrics({})

    assert result["total_trips"] == 2
    assert result["total_distance"] == "30.0"
    assert result["avg_distance"] == "15.0"
    assert result["avg_start_time"] == "11:00 AM"
    assert result["total_driving_time"] == "1:00"
    assert result["avg_speed"] == "30.0"
    assert result["max_speed"] == "70.0"


@pytest.mark.asyncio
async def test_get_metrics_preserves_minutes_and_wraps_midnight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_pipeline = None

    async def fake_aggregate_to_list(_model, pipeline, **_kwargs):
        nonlocal captured_pipeline
        captured_pipeline = pipeline
        return [
            {
                "total_trips": 2,
                "total_distance": 110.0,
                "avg_distance": 55.0,
                "max_speed": 70.0,
                "avg_speed": 10.0,
                "total_duration_seconds": 3600.0,
                "start_hours_local": [23.5, 0.5],
            }
        ]

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )

    result = await DashboardService.get_metrics({})

    assert result["avg_start_time"] == "12:00 AM"
    assert result["avg_speed"] == "10.0"
    assert captured_pipeline is not None
    add_fields = captured_pipeline[1]["$addFields"]
    assert "$minute" in str(add_fields["startHourLocal"])
    timezone_guard = add_fields["startHourLocal"]["$cond"]["if"]["$and"]
    assert build_mongo_tz_valid_expr("startTime") in timezone_guard
    group = captured_pipeline[2]["$group"]
    assert "paired_distance" in group
    assert "paired_duration_seconds" in group


@pytest.mark.asyncio
async def test_get_metrics_reports_undefined_opposite_start_times(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_aggregate_to_list(*_args, **_kwargs):
        return [{"total_trips": 2, "start_hours_local": [0.0, 12.0]}]

    monkeypatch.setattr(
        "analytics.services.dashboard_service.aggregate_to_list",
        fake_aggregate_to_list,
    )

    result = await DashboardService.get_metrics({})

    assert result["avg_start_time"] == "--:--"
