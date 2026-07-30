from datetime import UTC, datetime, timedelta

from recurring_routes.services.place_pair_analysis import _compute_facets_from_trips
from recurring_routes.services.temporal_analytics import build_temporal_facet_pipeline


def test_build_temporal_facet_pipeline_limits_to_most_recent_months() -> None:
    pipeline = build_temporal_facet_pipeline(
        match_query={"recurringRouteId": "route-1"},
        tz_expr="UTC",
        month_limit=24,
    )

    assert pipeline[1]["$addFields"]["duration_seconds"]["$cond"]["else"] is None
    assert pipeline[2]["$project"]["duration"] == "$duration_seconds"

    by_month = pipeline[3]["$facet"]["byMonth"]
    assert by_month == [
        {
            "$group": {
                "_id": "$yearMonth",
                "count": {"$sum": 1},
                "totalDistance": {"$sum": "$distance"},
                "avgDistance": {"$avg": "$distance"},
                "avgDuration": {"$avg": "$duration"},
            },
        },
        {"$sort": {"_id": -1}},
        {"$limit": 24},
        {"$sort": {"_id": 1}},
    ]


def test_place_pair_fallback_ignores_legacy_duration_field() -> None:
    start = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)

    facets = _compute_facets_from_trips(
        [
            {
                "startTime": start,
                "endTime": start + timedelta(minutes=10),
                "startTimeZone": "UTC",
                "distance": 5.0,
                "duration": 1.0,
            }
        ]
    )

    assert facets["stats"][0]["totalDuration"] == 600.0
    assert facets["stats"][0]["avgDuration"] == 600.0
