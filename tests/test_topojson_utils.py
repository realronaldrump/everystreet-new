from __future__ import annotations

from shapely.geometry import shape

from county.services.topojson_utils import topojson_to_geojson


def test_topojson_to_geojson_drops_degenerate_multipolygon_rings() -> None:
    topology = {
        "type": "Topology",
        "objects": {
            "counties": {
                "type": "GeometryCollection",
                "geometries": [
                    {
                        "type": "MultiPolygon",
                        "id": "08013",
                        "properties": {"name": "Boulder"},
                        "arcs": [
                            [[0]],
                            [[1], [2]],
                        ],
                    },
                ],
            },
        },
        "arcs": [
            [[10, 10], [0, 0]],
            [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]],
            [[0, 0], [1, 0], [-1, 0]],
        ],
    }

    features = topojson_to_geojson(topology, "counties")

    assert len(features) == 1
    geometry = features[0]["geometry"]
    assert geometry["type"] == "MultiPolygon"
    assert len(geometry["coordinates"]) == 1
    assert len(geometry["coordinates"][0]) == 1
    assert shape(geometry).is_valid


def test_topojson_to_geojson_closes_open_polygon_shells() -> None:
    topology = {
        "type": "Topology",
        "objects": {
            "counties": {
                "type": "GeometryCollection",
                "geometries": [
                    {
                        "type": "Polygon",
                        "id": "08031",
                        "properties": {"name": "Denver"},
                        "arcs": [[0], [1]],
                    },
                ],
            },
        },
        "arcs": [
            [[0, 0], [1, 0], [0, 1], [-1, 0]],
            [[5, 5], [0, 0]],
        ],
    }

    features = topojson_to_geojson(topology, "counties")

    assert len(features) == 1
    rings = features[0]["geometry"]["coordinates"]
    assert len(rings) == 1
    assert rings[0][0] == rings[0][-1]
    assert shape(features[0]["geometry"]).is_valid


def test_topojson_to_geojson_keeps_repairable_degenerate_polygon_shells() -> None:
    topology = {
        "type": "Topology",
        "objects": {
            "counties": {
                "type": "GeometryCollection",
                "geometries": [
                    {
                        "type": "Polygon",
                        "id": "51610",
                        "properties": {"name": "Falls Church"},
                        "arcs": [[0], [1]],
                    },
                ],
            },
        },
        "arcs": [
            [[0, 0], [1, 1], [-1, -1]],
            [[5, 5], [0, 0]],
        ],
    }

    features = topojson_to_geojson(topology, "counties")

    assert len(features) == 1
    rings = features[0]["geometry"]["coordinates"]
    assert len(rings) == 1
    assert shape(features[0]["geometry"]).geom_type == "Polygon"
