from core.spatial import GeometryService, derive_geo_points, is_valid_geojson_geometry


def test_validate_coordinate_pair() -> None:
    valid, coords = GeometryService.validate_coordinate_pair([-97.0, 32.0])
    assert valid
    assert coords == [-97.0, 32.0]

    invalid, coords = GeometryService.validate_coordinate_pair([200.0, 0.0])
    assert not invalid
    assert coords is None


def test_geometry_from_coordinate_pairs_dedupe() -> None:
    coords = [[-97.0, 32.0], [-97.0, 32.0], [-96.9, 32.1], ["bad", 0]]
    geometry = GeometryService.geometry_from_coordinate_pairs(coords, dedupe=True)

    assert geometry is not None
    assert geometry["type"] == "LineString"
    assert geometry["coordinates"] == [[-97.0, 32.0], [-96.9, 32.1]]


def test_is_valid_geojson_geometry() -> None:
    assert is_valid_geojson_geometry(
        {"type": "Point", "coordinates": [-97.0, 32.0]},
    )
    assert is_valid_geojson_geometry(
        {
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
    )
    assert not is_valid_geojson_geometry(
        {"type": "Point", "coordinates": [-200.0, 0.0]},
    )


def test_derive_geo_points() -> None:
    line_gps = {
        "type": "LineString",
        "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
    }
    start, end = derive_geo_points(line_gps)
    assert start == {"type": "Point", "coordinates": [-97.0, 32.0]}
    assert end == {"type": "Point", "coordinates": [-97.1, 32.1]}

    point_gps = {"type": "Point", "coordinates": [-97.0, 32.0]}
    start, end = derive_geo_points(point_gps)
    assert start == end
