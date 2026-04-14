from analytics.services.trip_analytics_service import TripAnalyticsService


def test_time_heatmap_organizer_returns_complete_weekday_hour_grid() -> None:
    results = [
        {
            "_id": {"dayOfWeek": 2, "hour": 7},
            "tripCount": 3,
            "totalDistance": 18.5,
        },
        {
            "_id": {"dayOfWeek": 1, "hour": 18},
            "tripCount": 2,
            "totalDistance": 7.25,
        },
    ]

    heatmap = TripAnalyticsService._organize_time_heatmap_data(results)

    assert len(heatmap) == 168
    monday_7 = next(cell for cell in heatmap if cell["day"] == 1 and cell["hour"] == 7)
    sunday_18 = next(
        cell for cell in heatmap if cell["day"] == 0 and cell["hour"] == 18
    )
    tuesday_9 = next(cell for cell in heatmap if cell["day"] == 2 and cell["hour"] == 9)

    assert monday_7 == {"day": 1, "hour": 7, "count": 3, "distance": 18.5}
    assert sunday_18 == {"day": 0, "hour": 18, "count": 2, "distance": 7.25}
    assert tuesday_9 == {"day": 2, "hour": 9, "count": 0, "distance": 0.0}
