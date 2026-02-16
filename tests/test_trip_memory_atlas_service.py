from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from trips.services.memory_atlas_service import (
    build_postcard_image,
    compute_moment_anchor,
    delete_generated_file,
    select_best_trip_for_moment,
)


def _sample_trip() -> dict:
    start = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)
    end = start + timedelta(minutes=30)
    return {
        "transactionId": "trip-1",
        "startTime": start,
        "endTime": end,
        "distance": 12.5,
        "gps": {
            "type": "LineString",
            "coordinates": [
                [-84.39, 33.75],
                [-84.35, 33.76],
                [-84.31, 33.78],
            ],
        },
    }


def test_compute_moment_anchor_prefers_exif_location() -> None:
    trip = _sample_trip()
    coords = trip["gps"]["coordinates"]

    result = compute_moment_anchor(
        trip=trip,
        coordinates=coords,
        lat=33.755,
        lon=-84.38,
        capture_time=None,
        fallback_fraction=0.5,
    )

    assert result["anchor_strategy"] == "exif_gps"
    assert result["anchor_confidence"] >= 0.85
    assert result["lat"] == 33.755
    assert result["lon"] == -84.38


def test_compute_moment_anchor_falls_back_to_timestamp() -> None:
    trip = _sample_trip()
    coords = trip["gps"]["coordinates"]
    capture_time = datetime(2025, 1, 1, 12, 15, tzinfo=UTC)

    result = compute_moment_anchor(
        trip=trip,
        coordinates=coords,
        lat=None,
        lon=None,
        capture_time=capture_time,
        fallback_fraction=0.2,
    )

    assert result["anchor_strategy"] == "timestamp_interp"
    assert result["anchor_confidence"] > 0.5
    assert result["lat"] is not None
    assert result["lon"] is not None


def test_build_postcard_image_writes_png_file() -> None:
    trip = _sample_trip()
    output_path = build_postcard_image(trip=trip, moments=[])
    path = Path(output_path)

    try:
        assert path.exists() is True
        assert path.suffix.lower() in {".png", ".svg"}
    finally:
        delete_generated_file(output_path)


def test_select_best_trip_for_moment_prefers_time_window_match() -> None:
    trip_a = SimpleNamespace(
        id="a",
        transactionId="trip-a",
        startTime=datetime(2025, 1, 1, 10, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 10, 30, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-84.40, 33.74], [-84.35, 33.76]],
        },
    )
    trip_b = SimpleNamespace(
        id="b",
        transactionId="trip-b",
        startTime=datetime(2025, 1, 1, 12, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 12, 30, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-84.20, 33.70], [-84.15, 33.72]],
        },
    )
    match = select_best_trip_for_moment(
        trips=[trip_a, trip_b],
        coordinates_by_trip_id={
            "a": [[-84.40, 33.74], [-84.35, 33.76]],
            "b": [[-84.20, 33.70], [-84.15, 33.72]],
        },
        capture_time=datetime(2025, 1, 1, 10, 10, tzinfo=UTC),
        lat=33.75,
        lon=-84.37,
    )
    assert match["trip"] is trip_a
    assert str(match["strategy"]).startswith("time_window")
    assert float(match["confidence"]) >= 0.8


def test_select_best_trip_for_moment_uses_location_fallback() -> None:
    trip_a = SimpleNamespace(
        id="a",
        transactionId="trip-a",
        startTime=datetime(2025, 1, 1, 8, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 8, 20, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-84.40, 33.74], [-84.35, 33.76]],
        },
    )
    trip_b = SimpleNamespace(
        id="b",
        transactionId="trip-b",
        startTime=datetime(2025, 1, 1, 9, 0, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 9, 20, tzinfo=UTC),
        gps={
            "type": "LineString",
            "coordinates": [[-84.20, 33.70], [-84.15, 33.72]],
        },
    )
    match = select_best_trip_for_moment(
        trips=[trip_a, trip_b],
        coordinates_by_trip_id={
            "a": [[-84.40, 33.74], [-84.35, 33.76]],
            "b": [[-84.20, 33.70], [-84.15, 33.72]],
        },
        capture_time=None,
        lat=33.705,
        lon=-84.195,
        max_location_distance_meters=2500.0,
    )
    assert match["trip"] is trip_b
    assert match["strategy"] == "nearest_route_location"
