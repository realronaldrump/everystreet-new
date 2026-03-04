"""Shared coverage clipping helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from shapely.geometry import mapping, shape

from core.spatial import (
    GeometryService,
    bounding_box_polygon,
    clip_lines_to_polygon,
    extract_polygon_geometry_from_geojson,
    geodesic_length_meters,
)

if TYPE_CHECKING:
    from shapely.geometry.base import BaseGeometry


class CoverageClipError(ValueError):
    """Raised when coverage clipping inputs are invalid."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(slots=True)
class CoverageClipContext:
    """Resolved clipping context for coverage-boundary operations."""

    enabled: bool = False
    area_id: str | None = None
    coverage_geometry: BaseGeometry | None = None
    prefilter_geometry: dict[str, Any] | None = None


def parse_clip_bool(value: Any) -> bool:
    """Parse common truthy query/filter values."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def resolve_coverage_clip_context(
    *,
    clip_requested: bool,
    area: Any | None,
    area_id: str | None = None,
    missing_area_message: str = "coverage_area_id is required when clip_to_coverage is true.",
) -> CoverageClipContext:
    """
    Build a clip context from a resolved coverage area document.

    Callers that need DB lookups should fetch the area first, then pass
    it here.
    """
    cleaned_area_id = str(area_id or "").strip() or None
    context = CoverageClipContext(area_id=cleaned_area_id)
    if not clip_requested:
        return context

    if area is None:
        raise CoverageClipError(missing_area_message, code="area_required")

    coverage_geometry = extract_polygon_geometry_from_geojson(
        getattr(area, "boundary", None),
    )
    if coverage_geometry is None:
        raise CoverageClipError(
            "Coverage area boundary is not a valid polygon and cannot be used for clipping.",
            code="invalid_boundary",
        )

    prefilter_geometry = bounding_box_polygon(coverage_geometry)
    if prefilter_geometry is None:
        raise CoverageClipError(
            "Coverage area boundary is degenerate and cannot be used for clipping.",
            code="degenerate_boundary",
        )

    return CoverageClipContext(
        enabled=True,
        area_id=cleaned_area_id,
        coverage_geometry=coverage_geometry,
        prefilter_geometry=prefilter_geometry,
    )


def apply_clip_prefilter(
    query: dict[str, Any],
    context: CoverageClipContext,
    *,
    geometry_field: str = "gps",
) -> dict[str, Any]:
    """Apply a bounding-box prefilter when clipping is active."""
    if context.enabled and context.prefilter_geometry:
        query[geometry_field] = {
            "$geoIntersects": {"$geometry": context.prefilter_geometry},
        }
    return query


def clip_geojson_lines(
    geometry: dict[str, Any] | None,
    context: CoverageClipContext,
) -> tuple[dict[str, Any] | None, float | None]:
    """Clip LineString/MultiLineString GeoJSON to coverage polygon."""
    if not context.enabled or context.coverage_geometry is None:
        return GeometryService.parse_geojson(geometry), None

    parsed_geometry = GeometryService.parse_geojson(geometry)
    if not parsed_geometry:
        return None, None

    geom_type = str(parsed_geometry.get("type") or "").strip()
    if geom_type not in {"LineString", "MultiLineString"}:
        return None, None

    try:
        line_geometry = shape(parsed_geometry)
    except Exception:
        return None, None
    if line_geometry.is_empty:
        return None, None

    clipped_lines = clip_lines_to_polygon(line_geometry, context.coverage_geometry)
    if clipped_lines is None or clipped_lines.is_empty:
        return None, None

    coverage_miles: float | None = None
    try:
        coverage_miles = geodesic_length_meters(clipped_lines) / 1609.344
    except Exception:
        coverage_miles = None

    return mapping(clipped_lines), coverage_miles


def clip_line_geometry(
    line_geometry: BaseGeometry | None,
    context: CoverageClipContext,
) -> BaseGeometry | None:
    """Clip a Shapely line geometry to the coverage polygon."""
    if not context.enabled:
        return line_geometry
    if context.coverage_geometry is None:
        return None
    return clip_lines_to_polygon(line_geometry, context.coverage_geometry)


__all__ = [
    "CoverageClipContext",
    "CoverageClipError",
    "apply_clip_prefilter",
    "clip_geojson_lines",
    "clip_line_geometry",
    "parse_clip_bool",
    "resolve_coverage_clip_context",
]
