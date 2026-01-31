"""
Valhalla HTTP client utilities.

Centralizes routing and map matching calls against the self-hosted
Valhalla US9 instance.
"""

from __future__ import annotations

import logging
from typing import Any

from config import (
    require_valhalla_route_url,
    require_valhalla_status_url,
    require_valhalla_trace_attributes_url,
    require_valhalla_trace_route_url,
)
from core.exceptions import ExternalServiceException
from core.http.request import request_json
from core.http.retry import retry_async
from core.http.session import get_session

logger = logging.getLogger(__name__)


class ValhallaClient:
    def __init__(self) -> None:
        self._status_url = require_valhalla_status_url()
        self._route_url = require_valhalla_route_url()
        self._trace_route_url = require_valhalla_trace_route_url()
        self._trace_attributes_url = require_valhalla_trace_attributes_url()

    @retry_async()
    async def status(self) -> dict[str, Any]:
        session = await get_session()
        data = await request_json(
            "GET",
            self._status_url,
            session=session,
            service_name="Valhalla status",
        )
        if not isinstance(data, dict):
            msg = "Valhalla status error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._status_url})
        return data

    @retry_async()
    async def route(
        self,
        locations: list[tuple[float, float]] | list[list[float]],
        *,
        costing: str = "auto",
        timeout: float | None = None,
    ) -> dict[str, Any]:
        normalized_locations: list[tuple[float, float]] = []
        for item in locations:
            try:
                lon = float(item[0])
                lat = float(item[1])
            except (TypeError, ValueError, IndexError):
                continue
            normalized_locations.append((lon, lat))

        if len(normalized_locations) < 2:
            msg = "Valhalla route requires at least two locations."
            raise ExternalServiceException(msg)

        payload = {
            "locations": [
                {"lon": lon, "lat": lat} for lon, lat in normalized_locations
            ],
            "costing": costing,
            "directions_options": {"units": "kilometers"},
            "shape_format": "geojson",
        }
        session = await get_session()
        data = await request_json(
            "POST",
            self._route_url,
            session=session,
            json=payload,
            service_name="Valhalla route",
            timeout=timeout,
        )
        if not isinstance(data, dict):
            msg = "Valhalla route error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._route_url})
        return self._normalize_route_response(data)

    @retry_async()
    async def trace_route(
        self,
        shape: list[dict[str, float | int | str]],
        *,
        costing: str = "auto",
        use_timestamps: bool | None = None,
    ) -> dict[str, Any]:
        if len(shape) < 2:
            msg = "Valhalla trace_route requires at least two points."
            raise ExternalServiceException(
                msg,
            )
        payload = {
            "shape": shape,
            "costing": costing,
            "shape_match": "map_snap",
            "shape_format": "geojson",
        }
        if use_timestamps is not None:
            payload["use_timestamps"] = use_timestamps
        session = await get_session()
        data = await request_json(
            "POST",
            self._trace_route_url,
            session=session,
            json=payload,
            service_name="Valhalla trace_route",
        )
        if not isinstance(data, dict):
            msg = "Valhalla trace_route error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._trace_route_url})
        return self._normalize_trace_response(data)

    @retry_async()
    async def trace_attributes(
        self,
        shape: list[dict[str, float | int | str]],
        *,
        costing: str = "auto",
    ) -> dict[str, Any]:
        if len(shape) < 2:
            msg = "Valhalla trace_attributes requires at least two points."
            raise ExternalServiceException(
                msg,
            )
        payload = {
            "shape": shape,
            "costing": costing,
            "shape_match": "map_snap",
            "shape_format": "geojson",
        }
        session = await get_session()
        data = await request_json(
            "POST",
            self._trace_attributes_url,
            session=session,
            json=payload,
            service_name="Valhalla trace_attributes",
        )
        if not isinstance(data, dict):
            msg = "Valhalla trace_attributes error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._trace_attributes_url})
        return data

    @staticmethod
    def _normalize_route_response(data: dict[str, Any]) -> dict[str, Any]:
        trip = data.get("trip") or {}
        legs = trip.get("legs") or []
        summary = legs[0].get("summary") if legs else {}
        coords = ValhallaClient._extract_shape_coordinates(data)
        geometry = {"type": "LineString", "coordinates": coords} if coords else None
        distance_km = summary.get("length", 0) if summary else 0
        return {
            "geometry": geometry,
            "duration_seconds": summary.get("time", 0) if summary else 0,
            "distance_meters": distance_km * 1000,
            "raw": data,
        }

    @staticmethod
    def _normalize_trace_response(data: dict[str, Any]) -> dict[str, Any]:
        coords = ValhallaClient._extract_shape_coordinates(data)
        geometry = {"type": "LineString", "coordinates": coords} if coords else None
        return {"geometry": geometry, "raw": data}

    @staticmethod
    def _extract_shape_coordinates(data: dict[str, Any]) -> list[list[float]]:
        trip = data.get("trip") if isinstance(data, dict) else None
        shape_format: str | None = None
        candidates: list[Any] = []

        if isinstance(trip, dict):
            shape_format = trip.get("shape_format") or shape_format
            candidates.append(trip.get("shape"))
            legs = trip.get("legs")
            if isinstance(legs, list) and legs:
                first_leg = legs[0]
                if isinstance(first_leg, dict):
                    shape_format = first_leg.get("shape_format") or shape_format
                    candidates.append(first_leg.get("shape"))

        if isinstance(data, dict):
            shape_format = data.get("shape_format") or shape_format
            candidates.append(data.get("shape"))

        for shape in candidates:
            coords = ValhallaClient._coerce_shape_coordinates(
                shape,
                shape_format=shape_format,
            )
            if coords:
                return coords

        return []

    @staticmethod
    def _coerce_shape_coordinates(
        shape: Any,
        *,
        shape_format: str | None = None,
    ) -> list[list[float]]:
        if shape is None:
            return []

        if isinstance(shape, str):
            return ValhallaClient._decode_polyline_shape(
                shape,
                shape_format=shape_format,
            )

        if isinstance(shape, dict):
            coords = shape.get("coordinates")
        elif isinstance(shape, list):
            coords = shape
        else:
            return []

        if not isinstance(coords, list):
            return []

        normalized: list[list[float]] = []
        for point in coords:
            if isinstance(point, dict):
                lon = point.get("lon")
                lat = point.get("lat")
            else:
                if not isinstance(point, (list, tuple)) or len(point) < 2:
                    continue
                lon, lat = point[0], point[1]
            if lon is None or lat is None:
                continue
            try:
                normalized.append([float(lon), float(lat)])
            except (TypeError, ValueError):
                continue

        return normalized

    @staticmethod
    def _decode_polyline_shape(
        shape: str,
        *,
        shape_format: str | None = None,
    ) -> list[list[float]]:
        if not shape:
            return []

        precisions: list[int]
        if shape_format == "polyline5":
            precisions = [5]
        elif shape_format == "polyline6":
            precisions = [6]
        else:
            precisions = [6, 5]

        for precision in precisions:
            coords = ValhallaClient._decode_polyline(shape, precision)
            if coords and ValhallaClient._coords_in_range(coords):
                return coords

        return []

    @staticmethod
    def _coords_in_range(coords: list[list[float]]) -> bool:
        for lon, lat in coords:
            if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
                return False
        return True

    @staticmethod
    def _decode_polyline(encoded: str, precision: int) -> list[list[float]]:
        if not encoded:
            return []

        coords: list[list[float]] = []
        index = 0
        lat = 0
        lon = 0
        length = len(encoded)
        factor = float(10**precision)

        def next_value() -> int:
            nonlocal index
            result = 0
            shift = 0
            while True:
                if index >= length:
                    raise ValueError("Invalid polyline encoding")
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            if result & 1:
                return ~(result >> 1)
            return result >> 1

        try:
            while index < length:
                lat += next_value()
                lon += next_value()
                coords.append([lon / factor, lat / factor])
        except ValueError:
            return []

        return coords
