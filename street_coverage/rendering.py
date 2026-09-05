"""Render actual covered portions while preserving parent street identity."""

from shapely.geometry import mapping, shape
from shapely.ops import substring, transform

from core.date_utils import normalize_to_utc_datetime
from core.spatial import get_local_transformers
from street_coverage.intervals import missing_intervals


def feature_parts(feature):
    properties = feature["properties"]
    sid = properties["segment_id"]
    if properties["status"] == "undriveable" or not properties.get("intervals"):
        return [
            {
                **feature,
                "id": sid,
                "properties": {
                    **properties,
                    "section_length_miles": properties["length_miles"],
                },
            }
        ]
    line = shape(feature["geometry"])
    forward, inverse = get_local_transformers(line)
    projected = transform(forward, line)
    parts = []
    pieces = [
        (row["start"], row["end"], "driven", row["first_driven_at"])
        for row in properties["discovery_intervals"]
    ]
    pieces.extend(
        (a, b, "undriven", None) for a, b in missing_intervals(properties["intervals"])
    )
    for index, (start, end, status, first_at) in enumerate(pieces):
        geometry = substring(projected, start, end, normalized=True)
        if geometry.geom_type != "LineString" or geometry.is_empty:
            continue
        parts.append(
            {
                "type": "Feature",
                "id": f"{sid}:{index}",
                "geometry": mapping(transform(inverse, geometry)),
                "properties": {
                    **properties,
                    "segment_status": properties["status"],
                    "status": status,
                    "first_driven_at": normalize_to_utc_datetime(first_at).isoformat() if first_at else None,
                    "section_length_miles": properties["length_miles"] * (end - start),
                },
            }
        )
    return parts
