from recurring_routes.services.temporal_analytics import build_temporal_facet_pipeline


def test_build_temporal_facet_pipeline_limits_to_most_recent_months() -> None:
    pipeline = build_temporal_facet_pipeline(
        match_query={"recurringRouteId": "route-1"},
        tz_expr="UTC",
        month_limit=24,
    )

    by_month = pipeline[2]["$facet"]["byMonth"]
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
