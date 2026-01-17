"""
Valhalla HTTP client utilities.

Centralizes routing and map matching calls against the self-hosted
Valhalla US9 instance.
"""

from __future__ import annotations

import logging
from typing import Any

from core.exceptions import ExternalServiceException
from core.http.session import get_session
from core.http.retry import retry_async
from config import (
    require_valhalla_route_url,
    require_valhalla_status_url,
    require_valhalla_trace_attributes_url,
    require_valhalla_trace_route_url,
)

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
        async with session.get(self._status_url) as response:
            if response.status != 200:
                body = await response.text()
                raise ExternalServiceException(
                    f"Valhalla status error: {response.status}",
                    {"body": body},
                )
            return await response.json()

    @retry_async()
    async def route(
        self,
        locations: list[tuple[float, float]],
        *,
        costing: str = "auto",
    ) -> dict[str, Any]:
        if len(locations) < 2:
            raise ExternalServiceException(
                "Valhalla route requires at least two locations.",
            )
        payload = {
            "locations": [{"lon": lon, "lat": lat} for lon, lat in locations],
            "costing": costing,
            "directions_options": {"units": "kilometers"},
            "shape_format": "geojson",
        }
        session = await get_session()

        async with session.post(self._route_url, json=payload) as response:
            if response.status != 200:
                body = await response.text()
                raise ExternalServiceException(
                    f"Valhalla route error: {response.status}",
                    {"body": body},
                )
            data = await response.json()
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
            raise ExternalServiceException(
                "Valhalla trace_route requires at least two points.",
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

        async with session.post(self._trace_route_url, json=payload) as response:
            if response.status != 200:
                body = await response.text()
                raise ExternalServiceException(
                    f"Valhalla trace_route error: {response.status}",
                    {"body": body},
                )
            data = await response.json()
        return self._normalize_trace_response(data)

    @retry_async()
    async def trace_attributes(
        self,
        shape: list[dict[str, float]],
        *,
        costing: str = "auto",
    ) -> dict[str, Any]:
        if len(shape) < 2:
            raise ExternalServiceException(
                "Valhalla trace_attributes requires at least two points.",
            )
        payload = {
            "shape": shape,
            "costing": costing,
            "shape_match": "map_snap",
            "shape_format": "geojson",
        }
        session = await get_session()

        async with session.post(self._trace_attributes_url, json=payload) as response:
            if response.status != 200:
                body = await response.text()
                raise ExternalServiceException(
                    f"Valhalla trace_attributes error: {response.status}",
                    {"body": body},
                )
            data = await response.json()
        return data

    @staticmethod
    def _normalize_route_response(data: dict[str, Any]) -> dict[str, Any]:
        trip = data.get("trip") or {}
        legs = trip.get("legs") or []
        summary = legs[0].get("summary") if legs else {}
        geometry = None
        if trip.get("shape"):
            geometry = {
                "type": "LineString",
                "coordinates": trip.get("shape", {}).get("coordinates", []),
            }
        distance_km = summary.get("length", 0) if summary else 0
        return {
            "geometry": geometry,
            "duration_seconds": summary.get("time", 0) if summary else 0,
            "distance_meters": distance_km * 1000,
            "raw": data,
        }

    @staticmethod
    def _normalize_trace_response(data: dict[str, Any]) -> dict[str, Any]:
        trip = data.get("trip") or {}
        shape = trip.get("shape") or {}
        geometry = {
            "type": "LineString",
            "coordinates": shape.get("coordinates", []),
        }
        return {
            "geometry": geometry,
            "raw": data,
        }
