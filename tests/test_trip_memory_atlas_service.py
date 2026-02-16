from datetime import UTC, datetime, timedelta
from pathlib import Path

from trips.services.memory_atlas_service import (
    build_postcard_image,
    compute_moment_anchor,
    delete_generated_file,
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
