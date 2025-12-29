"""Centralized geometry helpers for GeoJSON, distance, and validation."""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from typing import Any


class GeometryService:
    """Authoritative geometry operations for the application."""

    EARTH_RADIUS_M = 6371000.0

    @staticmethod
    def validate_coordinate_pair(
        coord: Sequence[Any],
    ) -> tuple[bool, list[float] | None]:
        """Validate a [lon, lat] coordinate pair."""
        if not isinstance(coord, (list, tuple)) or len(coord) < 2:
            return False, None
        try:
            lon = float(coord[0])
            lat = float(coord[1])
        except (TypeError, ValueError, IndexError):
            return False, None
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            return False, None
        return True, [lon, lat]

    @staticmethod
    def validate_bounding_box(
        min_lat: float,
        min_lon: float,
        max_lat: float,
        max_lon: float,
    ) -> bool:
        """Validate bounding box coordinate ranges."""
        valid_min, _ = GeometryService.validate_coordinate_pair([min_lon, min_lat])
        valid_max, _ = GeometryService.validate_coordinate_pair([max_lon, max_lat])
        return valid_min and valid_max

    @staticmethod
    def haversine_distance(
        lon1: float,
        lat1: float,
        lon2: float,
        lat2: float,
        unit: str = "meters",
    ) -> float:
        """Calculate the great-circle distance using the Haversine formula."""
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlmb = math.radians(lon2 - lon1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
        )
        distance_m = (
            2 * GeometryService.EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))
        )
        if unit == "meters":
            return distance_m
        if unit == "miles":
            return distance_m / 1609.344
        if unit == "km":
            return distance_m / 1000.0
        raise ValueError("Invalid unit. Use 'meters', 'miles', or 'km'.")

    @staticmethod
    def parse_geojson(value: Any) -> dict[str, Any] | None:
        """Parse GeoJSON geometry from a dict or JSON string."""
        if value is None:
            return None
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                return None
        if isinstance(value, dict):
            if value.get("type") == "Feature":
                geometry = value.get("geometry")
                return geometry if isinstance(geometry, dict) else None
            if "type" in value:
                return value
        return None

    @staticmethod
    def geometry_from_document(
        doc: dict[str, Any],
        geometry_field: str,
    ) -> dict[str, Any] | None:
        """Extract GeoJSON geometry from a document field."""
        if not isinstance(doc, dict):
            return None
        return GeometryService.parse_geojson(doc.get(geometry_field))

    @staticmethod
    def geometry_from_coordinate_pairs(
        coords: Iterable[Sequence[Any]],
        *,
        allow_point: bool = True,
        dedupe: bool = False,
        validate: bool = True,
    ) -> dict[str, Any] | None:
        """Build a GeoJSON Point/LineString from coordinate pairs."""
        if not coords:
            return None

        cleaned: list[list[float]] = []
        for coord in coords:
            if validate:
                is_valid, pair = GeometryService.validate_coordinate_pair(coord)
                if not is_valid or pair is None:
                    continue
            else:
                try:
                    pair = [float(coord[0]), float(coord[1])]
                except (TypeError, ValueError, IndexError):
                    continue
            cleaned.append(pair)

        if not cleaned:
            return None

        if dedupe:
            unique: list[list[float]] = []
            for coord in cleaned:
                if not unique or coord != unique[-1]:
                    unique.append(coord)
            cleaned = unique

        if len(cleaned) == 1:
            return {"type": "Point", "coordinates": cleaned[0]} if allow_point else None
        if len(cleaned) < 2:
            return None
        return {"type": "LineString", "coordinates": cleaned}

    @staticmethod
    def geometry_from_coordinate_dicts(
        coords: Iterable[dict[str, Any]],
        *,
        lon_key: str = "lon",
        lat_key: str = "lat",
        allow_point: bool = True,
        dedupe: bool = True,
        validate: bool = True,
    ) -> dict[str, Any] | None:
        """Build GeoJSON from dicts containing lon/lat keys."""
        pairs: list[list[Any]] = []
        for item in coords:
            if not isinstance(item, dict):
                continue
            lon = item.get(lon_key)
            lat = item.get(lat_key)
            if lon is None or lat is None:
                continue
            pairs.append([lon, lat])
        return GeometryService.geometry_from_coordinate_pairs(
            pairs,
            allow_point=allow_point,
            dedupe=dedupe,
            validate=validate,
        )

    @staticmethod
    def geometry_from_shapely(value: Any) -> dict[str, Any] | None:
        """Convert a shapely geometry into GeoJSON geometry."""
        if value is None:
            return None
        if hasattr(value, "__geo_interface__"):
            geo = value.__geo_interface__
            return dict(geo) if isinstance(geo, dict) else None
        return None

    @staticmethod
    def bounding_box_polygon(
        min_lat: float,
        min_lon: float,
        max_lat: float,
        max_lon: float,
    ) -> dict[str, Any] | None:
        """Create a GeoJSON Polygon for a bounding box."""
        if not GeometryService.validate_bounding_box(
            min_lat, min_lon, max_lat, max_lon
        ):
            return None
        coords = [
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]
        return {"type": "Polygon", "coordinates": [coords]}

    @staticmethod
    def feature_from_geometry(
        geometry: dict[str, Any] | None,
        properties: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build a GeoJSON Feature from geometry and properties."""
        return {
            "type": "Feature",
            "geometry": geometry,
            "properties": properties or {},
        }

    @staticmethod
    def feature_from_document(
        doc: dict[str, Any],
        geometry_field: str,
        properties: dict[str, Any] | None = None,
        *,
        exclude_fields: set[str] | None = None,
    ) -> dict[str, Any] | None:
        """Build a GeoJSON Feature from a document field."""
        geometry = GeometryService.geometry_from_document(doc, geometry_field)
        if geometry is None:
            return None
        if properties is None:
            excluded = set(exclude_fields or ())
            excluded.add(geometry_field)
            properties = {k: v for k, v in doc.items() if k not in excluded}
        return GeometryService.feature_from_geometry(geometry, properties)

    @staticmethod
    def feature_collection(features: list[dict[str, Any]]) -> dict[str, Any]:
        """Build a GeoJSON FeatureCollection."""
        return {"type": "FeatureCollection", "features": features}
