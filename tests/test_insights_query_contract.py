"""Insights populations and exact destination drilldowns stay consistent."""

from unittest.mock import AsyncMock

import pytest

from analytics.services.dashboard_service import DashboardService
from analytics.services.drilldown_service import DrilldownService
from analytics.services.insight_query import destination_label_expr, insight_query
from analytics.services.time_analytics_service import TimeAnalyticsService
from analytics.services.trip_analytics_service import TripAnalyticsService


@pytest.mark.asyncio
async def test_all_insight_views_exclude_invalid_and_inactive_trips(monkeypatch):
    query = {"source": "upload", "invalid": True, "inactive": True}
    for module, service, args in [
        ("dashboard_service", DashboardService.get_driving_insights, ()),
        ("dashboard_service", DashboardService.get_metrics, ()),
        ("trip_analytics_service", TripAnalyticsService.get_trip_analytics, ()),
        (
            "time_analytics_service",
            TimeAnalyticsService.get_time_period_trips,
            ("hour", 7),
        ),
        ("drilldown_service", DrilldownService.get_drilldown_trips, ("trips",)),
    ]:
        aggregate = AsyncMock(return_value=[])
        monkeypatch.setattr(f"analytics.services.{module}.aggregate_to_list", aggregate)
        kwargs = (
            {"include_movement": False}
            if service == DashboardService.get_driving_insights
            else {}
        )
        await service(query, *args, **kwargs)
        population = aggregate.call_args_list[0].args[1][0]["$match"]
        assert population["source"] == "bouncie"
        assert population["invalid"] == {"$ne": True}
        assert population["inactive"] == {"$ne": True}
    assert query["invalid"] is True  # Never mutate a caller's query.


@pytest.mark.asyncio
async def test_destination_filter_is_exact_and_runs_before_limit(monkeypatch):
    aggregate = AsyncMock(return_value=[])
    monkeypatch.setattr(
        "analytics.services.drilldown_service.aggregate_to_list", aggregate
    )
    date_clause = {"$gte": ["$startTime", "selected-start"]}
    await DrilldownService.get_drilldown_trips(
        {"$expr": date_clause},
        "trips",
        100,
        destination="$Home",
    )
    pipeline = aggregate.call_args.args[1]
    assert pipeline[0]["$match"]["$expr"] == {
        "$and": [
            date_clause,
            {"$eq": [destination_label_expr(), {"$literal": "$Home"}]},
        ]
    }
    assert {"$limit": 100} in pipeline


@pytest.mark.asyncio
async def test_chart_distances_use_numeric_nonnegative_values(monkeypatch):
    aggregate = AsyncMock(return_value=[])
    monkeypatch.setattr(
        "analytics.services.trip_analytics_service.aggregate_to_list", aggregate
    )
    await TripAnalyticsService.get_trip_analytics({})
    pipeline = aggregate.call_args.args[1]
    assert (
        pipeline[1]["$addFields"]["numericDistance"]["$convert"]["input"] == "$distance"
    )
    assert pipeline[2]["$group"]["totalDistance"] == {
        "$sum": {"$max": [0, "$numericDistance"]}
    }


def test_insight_query_preserves_range_and_enforces_population():
    original = {"$expr": {"$literal": True}}
    assert insight_query(original) == {
        **original,
        "source": "bouncie",
        "invalid": {"$ne": True},
        "inactive": {"$ne": True},
    }
