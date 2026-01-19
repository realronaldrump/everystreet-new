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
        shape: list[dict[str, float | int]],
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
        shape: list[dict[str, float]],
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
        candidates: list[Any] = []

        if isinstance(trip, dict):
            candidates.append(trip.get("shape"))
            legs = trip.get("legs")
            if isinstance(legs, list) and legs:
                first_leg = legs[0]
                if isinstance(first_leg, dict):
                    candidates.append(first_leg.get("shape"))

        if isinstance(data, dict):
            candidates.append(data.get("shape"))

        for shape in candidates:
            coords = ValhallaClient._coerce_shape_coordinates(shape)
            if coords:
                return coords

        return []

    @staticmethod
    def _coerce_shape_coordinates(shape: Any) -> list[list[float]]:
        if shape is None:
            return []

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
                if not isinstance(point, list | tuple) or len(point) < 2:
                    continue
                lon, lat = point[0], point[1]
            if lon is None or lat is None:
                continue
            try:
                normalized.append([float(lon), float(lat)])
            except (TypeError, ValueError):
                continue

        return normalized
