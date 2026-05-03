from __future__ import annotations

from datetime import UTC, datetime

from trips.services.bouncie_ingest_runtime import filter_trips_to_window


def test_filter_trips_to_window_includes_boundary_times() -> None:
    window_start = datetime(2020, 3, 1, 0, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 0, 0, 0, tzinfo=UTC)

    trips = [
        {
            "transactionId": "a",
            "startTime": window_start,
            "endTime": window_end,
        },
        {
            "transactionId": "b",
            "startTime": "2020-03-01T00:00:00Z",
            "endTime": "2020-03-08T00:00:00Z",
        },
    ]

    kept = filter_trips_to_window(
        trips,
        window_start=window_start,
        window_end=window_end,
    )
    assert {t["transactionId"] for t in kept} == {"a", "b"}


def test_filter_trips_to_window_keeps_overlapping_trips() -> None:
    window_start = datetime(2020, 3, 1, 0, 0, 0, tzinfo=UTC)
    window_end = datetime(2020, 3, 8, 0, 0, 0, tzinfo=UTC)

    trips = [
        # Fully before window
        {
            "transactionId": "before",
            "startTime": "2020-02-29T22:00:00Z",
            "endTime": "2020-02-29T23:00:00Z",
        },
        # Overlaps start boundary
        {
            "transactionId": "overlaps-start",
            "startTime": "2020-02-29T23:59:59Z",
            "endTime": "2020-03-01T00:10:00Z",
        },
        # Overlaps end boundary
        {
            "transactionId": "overlaps-end",
            "startTime": "2020-03-07T23:50:00Z",
            "endTime": "2020-03-08T00:00:01Z",
        },
        # Fully after window
        {
            "transactionId": "after",
            "startTime": "2020-03-08T00:00:01Z",
            "endTime": "2020-03-08T00:10:00Z",
        },
        # Inside window
        {
            "transactionId": "ok",
            "startTime": "2020-03-02T00:00:00Z",
            "endTime": "2020-03-02T00:10:00Z",
        },
    ]

    kept = filter_trips_to_window(
        trips,
        window_start=window_start,
        window_end=window_end,
    )
    assert [t["transactionId"] for t in kept] == [
        "overlaps-start",
        "overlaps-end",
        "ok",
    ]
