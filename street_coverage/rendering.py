"""Render actual covered portions while preserving parent street identity."""

import numpy as np
import shapely
from shapely.geometry import box, mapping, shape
from shapely.ops import substring, transform

from core.date_utils import normalize_to_utc_datetime
from core.spatial import get_local_transformers
from street_coverage.intervals import missing_intervals

# Six decimal places of a degree is about 0.1 m: finer than any map zoom.
MAP_COORDINATE_DECIMALS = 6


def local_projection(geometries):
    """One local metric projection shared by every street in a response.

    Building a projection is far slower than cutting a line, so a response
    builds one for its whole extent instead of one per street.
    """
    lines = [shape(value) if isinstance(value, dict) else value for value in geometries]
    lines = [line for line in lines if not line.is_empty]
    if not lines:
        return None
    return get_local_transformers(box(*shapely.total_bounds(lines)))


def _rounded(geometry, decimals):
    if decimals is None:
        return mapping(geometry)
    return mapping(shapely.transform(geometry, lambda xy: np.round(xy, decimals)))


def _cut(line, pieces, projection, decimals):
    forward, inverse = projection or get_local_transformers(line)
    projected = transform(forward, line)
    for piece in pieces:
        geometry = substring(projected, piece[0], piece[1], normalized=True)
        if geometry.geom_type != "LineString" or geometry.is_empty:
            continue
        yield piece, _rounded(transform(inverse, geometry), decimals)


def feature_parts(feature, projection=None, *, decimals=None):
    properties = feature["properties"]
    sid = properties["segment_id"]
    if properties["status"] == "undriveable" or not properties.get("intervals"):
        geometry = feature["geometry"]
        return [
            {
                **feature,
                "id": sid,
                "geometry": geometry
                if decimals is None
                else _rounded(shape(geometry), decimals),
                "properties": {
                    **properties,
                    "section_length_miles": properties["length_miles"],
                },
            }
        ]
    pieces = [
        (row["start"], row["end"], "driven", row["first_driven_at"])
        for row in properties["discovery_intervals"]
    ]
    pieces.extend(
        (a, b, "undriven", None) for a, b in missing_intervals(properties["intervals"])
    )
    parts = []
    line = shape(feature["geometry"])
    for index, ((start, end, status, first_at), geometry) in enumerate(
        _cut(line, pieces, projection, decimals)
    ):
        parts.append(
            {
                "type": "Feature",
                "id": f"{sid}:{index}",
                "geometry": geometry,
                "properties": {
                    **properties,
                    "segment_status": properties["status"],
                    "status": status,
                    "first_driven_at": normalize_to_utc_datetime(first_at).isoformat()
                    if first_at
                    else None,
                    "section_length_miles": properties["length_miles"] * (end - start),
                },
            }
        )
    return parts


def slim_parts(feature, keep, projection, *, decimals=MAP_COORDINATE_DECIMALS):
    """Map-ready portions carrying only the properties a map layer reads."""
    return [
        {
            "type": "Feature",
            "id": part["id"],
            "geometry": part["geometry"],
            "properties": {
                key: part["properties"].get(key)
                for key in keep
                if part["properties"].get(key) is not None
            },
        }
        for part in feature_parts(feature, projection, decimals=decimals)
    ]
