from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from trips.services import trip_display_geometry
from trips.services.trip_display_geometry import derive_trip_display_geometry


def _trip_doc(coords: list[list[float]], *, start: datetime | None = None) -> dict:
    start_time = start or datetime(2026, 4, 14, 12, 0, tzinfo=UTC)
    return {
        "transactionId": "display-test",
        "gps": {"type": "LineString", "coordinates": coords},
        "coordinates": [
            {
                "lon": lon,
                "lat": lat,
                "timestamp": start_time + timedelta(seconds=index * 30),
            }
            for index, (lon, lat) in enumerate(coords)
        ],
    }


def test_display_geometry_trims_noisy_parking_garage_start() -> None:
    start = datetime(2026, 4, 14, 12, 0, tzinfo=UTC)
    coords = [
        [-97.0, 32.0],
        [-97.02, 32.02],
        [-97.019, 32.021],
        [-97.0005, 32.0005],
        [-97.001, 32.001],
        [-97.002, 32.002],
        [-97.003, 32.003],
    ]
    trip = _trip_doc(coords, start=start)
    trip["coordinates"] = [
        {"lon": coords[0][0], "lat": coords[0][1], "timestamp": start},
        {
            "lon": coords[1][0],
            "lat": coords[1][1],
            "timestamp": start + timedelta(seconds=5),
        },
        {
            "lon": coords[2][0],
            "lat": coords[2][1],
            "timestamp": start + timedelta(seconds=10),
        },
        {
            "lon": coords[3][0],
            "lat": coords[3][1],
            "timestamp": start + timedelta(seconds=30),
        },
        {
            "lon": coords[4][0],
            "lat": coords[4][1],
            "timestamp": start + timedelta(seconds=60),
        },
        {
            "lon": coords[5][0],
            "lat": coords[5][1],
            "timestamp": start + timedelta(seconds=90),
        },
        {
            "lon": coords[6][0],
            "lat": coords[6][1],
            "timestamp": start + timedelta(seconds=120),
        },
    ]

    result = derive_trip_display_geometry(trip)

    assert result.status == "cleaned"
    assert result.geometry == {"type": "LineString", "coordinates": coords[3:]}
    assert result.summary["endpoint_trim_start"] == 3
    assert "trimmed_noisy_start" in result.summary["reasons"]


def test_display_geometry_removes_single_isolated_spike() -> None:
    start = datetime(2026, 4, 14, 12, 0, tzinfo=UTC)
    coords = [
        [-97.0, 32.0],
        [-98.0, 33.0],
        [-97.001, 32.001],
        [-97.002, 32.002],
    ]
    trip = _trip_doc(coords, start=start)

    result = derive_trip_display_geometry(trip)

    assert result.status == "cleaned"
    assert result.geometry == {
        "type": "LineString",
        "coordinates": [coords[0], coords[2], coords[3]],
    }
    assert result.summary["removed_points"] == 1
    assert "removed_isolated_spikes" in result.summary["reasons"]


def test_display_geometry_splits_mid_trip_large_jump() -> None:
    coords = [
        [-97.0, 32.0],
        [-97.001, 32.001],
        [-96.0, 33.0],
        [-96.001, 33.001],
    ]
    trip = _trip_doc(coords)

    result = derive_trip_display_geometry(trip)

    assert result.status == "cleaned"
    assert result.geometry == {
        "type": "MultiLineString",
        "coordinates": [[coords[0], coords[1]], [coords[2], coords[3]]],
    }
    assert result.summary["split_count"] == 1
    assert "split_implausible_jumps" in result.summary["reasons"]


def test_display_geometry_preserves_valid_sparse_trip() -> None:
    start = datetime(2026, 4, 14, 12, 0, tzinfo=UTC)
    coords = [[-97.0, 32.0], [-97.5, 32.5], [-98.0, 33.0]]
    trip = _trip_doc(coords, start=start)
    trip["coordinates"][1]["timestamp"] = start + timedelta(hours=1)
    trip["coordinates"][2]["timestamp"] = start + timedelta(hours=2)

    result = derive_trip_display_geometry(trip)

    assert result.status == "unchanged"
    assert result.geometry == {"type": "LineString", "coordinates": coords}
    assert result.summary["removed_points"] == 0
    assert result.summary["split_count"] == 0


def test_display_geometry_preserves_valid_short_trip_endpoint() -> None:
    coords = [[-97.0, 32.0], [-97.0005, 32.0005], [-97.001, 32.001]]
    trip = _trip_doc(coords)

    result = derive_trip_display_geometry(trip)

    assert result.status == "unchanged"
    assert result.geometry == {"type": "LineString", "coordinates": coords}
    assert result.summary["endpoint_trim_start"] == 0
    assert result.summary["endpoint_trim_end"] == 0


def test_display_geometry_service_does_not_import_live_trip_modules() -> None:
    source = Path(trip_display_geometry.__file__).read_text()

    assert "tracking.services" not in source
    assert "tracking.api" not in source
    assert "active_trip" not in source
    assert "trip_updates" not in source
