"""Utilities for compact SVG previews of line geometry."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from core.spatial import extract_line_sequences, normalize_coordinate_list


def _flatten_line_coords(geometry: dict[str, Any] | None) -> list[list[float]]:
    sequences = extract_line_sequences(geometry)
    if not sequences:
        return []

    flattened: list[list[float]] = []
    for line in sequences:
        if not line:
            continue
        if flattened and flattened[-1] == line[0]:
            flattened.extend(line[1:])
        else:
            flattened.extend(line)
    return normalize_coordinate_list(flattened)


def build_line_preview_svg_path(
    geometry: dict[str, Any] | None,
    *,
    width: float = 100.0,
    height: float = 40.0,
    padding: float = 4.0,
    max_points: int = 64,
) -> str | None:
    """Build a compact SVG path string for LineString/MultiLineString geometry."""
    if not geometry:
        return None

    coords = _flatten_line_coords(geometry)
    if len(coords) < 2:
        return None

    if len(coords) > max_points:
        step = max(1, len(coords) // max_points)
        sampled = coords[::step]
        if sampled[-1] != coords[-1]:
            sampled.append(coords[-1])
        coords = sampled

    lons = [pt[0] for pt in coords]
    lats = [pt[1] for pt in coords]
    min_lon = min(lons)
    max_lon = max(lons)
    min_lat = min(lats)
    max_lat = max(lats)

    if min_lon == max_lon:
        min_lon -= 0.0001
        max_lon += 0.0001
    if min_lat == max_lat:
        min_lat -= 0.0001
        max_lat += 0.0001

    span_lon = max_lon - min_lon
    span_lat = max_lat - min_lat
    if span_lon <= 0 or span_lat <= 0:
        return None

    scale_x = (width - (padding * 2)) / span_lon
    scale_y = (height - (padding * 2)) / span_lat

    def project(pt: Sequence[float]) -> tuple[float, float]:
        x = padding + (pt[0] - min_lon) * scale_x
        y = padding + (max_lat - pt[1]) * scale_y
        return x, y

    points = [project(pt) for pt in coords]
    path_parts = [f"M {points[0][0]:.1f},{points[0][1]:.1f}"]
    path_parts.extend(f"L {x:.1f},{y:.1f}" for x, y in points[1:])
    return " ".join(path_parts)


__all__ = ["build_line_preview_svg_path"]
