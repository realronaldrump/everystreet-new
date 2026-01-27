from geo_service.map_matching import MapMatchingService


def test_build_shape_points_sets_break_and_via_types() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1], [-1.2, 1.2]]

    shape = MapMatchingService._build_shape_points(coords, None)

    assert shape[0]["type"] == "break"
    assert shape[1]["type"] == "via"
    assert shape[2]["type"] == "break"
