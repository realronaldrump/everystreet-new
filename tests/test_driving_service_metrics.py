from driving.services.driving_service import _segment_midpoint_coords


def test_segment_midpoint_follows_polyline_length() -> None:
    geometry = {
        "type": "LineString",
        "coordinates": [[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]],
    }

    assert _segment_midpoint_coords(geometry) == (5.0, 10.0)
