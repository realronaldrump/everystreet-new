"""TopoJSON conversion helpers for county/state boundary datasets."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def topojson_to_geojson(
    topology: dict[str, Any], object_name: str
) -> list[dict[str, Any]]:
    """
    Convert a TopoJSON object into GeoJSON features.

    Supports `Polygon` and `MultiPolygon` geometry types with optional TopoJSON
    transform metadata.
    """
    features: list[dict[str, Any]] = []

    if "objects" not in topology or object_name not in topology["objects"]:
        return features

    arcs = topology.get("arcs", [])
    transform_data = topology.get("transform")

    def decode_coordinates(arc: list) -> list:
        coords = []
        x, y = 0, 0

        for point in arc:
            x += point[0]
            y += point[1]

            if transform_data:
                scale = transform_data.get("scale", [1, 1])
                translate = transform_data.get("translate", [0, 0])
                lon = x * scale[0] + translate[0]
                lat = y * scale[1] + translate[1]
                coords.append([lon, lat])
            else:
                coords.append([x, y])

        return coords

    def decode_arc(arc_index: int) -> list:
        if arc_index < 0:
            arc = arcs[~arc_index]
            coords = decode_coordinates(arc)
            return list(reversed(coords))
        arc = arcs[arc_index]
        return decode_coordinates(arc)

    def arcs_to_coordinates(arc_indices: list) -> list:
        coords = []
        for arc_idx in arc_indices:
            arc_coords = decode_arc(arc_idx)
            if coords:
                coords.extend(arc_coords[1:])
            else:
                coords.extend(arc_coords)
        return coords

    obj = topology["objects"][object_name]
    geometries = obj.get("geometries", [])

    for geom in geometries:
        geom_type = geom.get("type")
        arcs_data = geom.get("arcs", [])

        try:
            if geom_type == "Polygon":
                rings = [arcs_to_coordinates(ring) for ring in arcs_data]
                features.append(
                    {
                        "type": "Feature",
                        "id": geom.get("id"),
                        "properties": geom.get("properties", {}),
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": rings,
                        },
                    }
                )
                continue

            if geom_type == "MultiPolygon":
                polygons = []
                for polygon_arcs in arcs_data:
                    rings = [arcs_to_coordinates(ring) for ring in polygon_arcs]
                    polygons.append(rings)
                features.append(
                    {
                        "type": "Feature",
                        "id": geom.get("id"),
                        "properties": geom.get("properties", {}),
                        "geometry": {
                            "type": "MultiPolygon",
                            "coordinates": polygons,
                        },
                    }
                )
        except Exception as exc:
            logger.warning("Error converting TopoJSON geometry: %s", exc)

    return features


__all__ = ["topojson_to_geojson"]
