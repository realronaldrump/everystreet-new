"""Mapbox Map Matching HTTP client.

This client is intentionally scoped to historical trip map matching. It does
not expose tokens to browser payloads and does not return raw provider
responses to persistence paths.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlparse

from config import (
    get_mapbox_map_matching_radius_meters,
    get_mapbox_map_matching_timeout_seconds,
    get_mapbox_map_matching_token,
    get_mapbox_map_matching_url,
)
from core.exceptions import ExternalServiceException
from core.http.session import get_session
from core.spatial import extract_line_sequences

_TOKEN_RE = re.compile(r"(?i)(access_token=)[^&\s]+|([ps]k\.[A-Za-z0-9._-]+)")
_COORDINATE_PAIR_RE = re.compile(r"-?\d{1,3}\.\d{4,},\s*-?\d{1,2}\.\d{4,}")


def sanitize_mapbox_message(value: Any) -> str:
    """Return a provider message safe for logs and persisted metadata."""
    text = str(value or "").strip()
    if not text:
        return "Unknown Mapbox map matching error"
    text = _TOKEN_RE.sub(lambda m: f"{m.group(1) or ''}[redacted]", text)
    text = _COORDINATE_PAIR_RE.sub("[coordinate]", text)
    return text[:240]


class MapboxMapMatchingClient:
    """Small client for Mapbox's Map Matching API."""

    MAX_COORDINATES = 100
    MIN_UNIX_TIMESTAMP = 946684800  # 2000-01-01T00:00:00Z

    def __init__(
        self,
        *,
        token: str | None = None,
        url: str | None = None,
    ) -> None:
        self._token = (token if token is not None else get_mapbox_map_matching_token())
        self._url = url or get_mapbox_map_matching_url()

    @property
    def configured(self) -> bool:
        return bool((self._token or "").strip())

    async def status(self) -> dict[str, Any]:
        return {
            "status": "ready" if self.configured else "missing_token",
            "engine": "mapbox",
        }

    async def match(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
    ) -> dict[str, Any]:
        if not self.configured:
            raise ExternalServiceException("Mapbox map matching token is not configured")
        if len(coordinates) < 2:
            raise ExternalServiceException(
                "Mapbox map matching requires at least two coordinates."
            )
        if len(coordinates) > self.MAX_COORDINATES:
            raise ExternalServiceException(
                "Mapbox map matching accepts at most 100 coordinates per request."
            )
        if not self._is_allowed_endpoint(self._url):
            raise ValueError("Mapbox map matching blocked host")

        form = self._build_form(coordinates, timestamps)
        session = await get_session()
        headers = {"Content-Type": "application/x-www-form-urlencoded"}

        async def _execute() -> dict[str, Any]:
            async with session.post(
                self._url,
                params={"access_token": self._token},
                data=form,
                headers=headers,
            ) as response:
                if response.status == 429:
                    retry_after = int(response.headers.get("Retry-After", 5))
                    raise ExternalServiceException(
                        "Mapbox map matching rate limited",
                        {"status": 429, "retry_after": retry_after},
                    )
                if response.status != 200:
                    raise ExternalServiceException(
                        f"Mapbox map matching error: {response.status}",
                        {"status": response.status},
                    )
                data = await response.json()
                if not isinstance(data, dict):
                    raise ExternalServiceException(
                        "Mapbox map matching error: unexpected response"
                    )
                return data

        try:
            async with asyncio.timeout(get_mapbox_map_matching_timeout_seconds()):
                data = await _execute()
        except TimeoutError as exc:
            raise ExternalServiceException("Mapbox map matching timeout") from exc

        return self._normalize_response(data)

    @staticmethod
    def _is_allowed_endpoint(url: str) -> bool:
        parsed = urlparse(url)
        return (
            parsed.scheme == "https"
            and parsed.hostname == "api.mapbox.com"
            and parsed.path.startswith("/matching/v5/")
        )

    @staticmethod
    def _coordinate_param(coordinates: list[list[float]]) -> str:
        return ";".join(f"{float(lon):.6f},{float(lat):.6f}" for lon, lat in coordinates)

    @staticmethod
    def _valid_timestamps(
        coordinates: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> list[int] | None:
        if not timestamps or len(timestamps) != len(coordinates):
            return None
        normalized: list[int] = []
        previous: int | None = None
        for timestamp in timestamps:
            if timestamp is None:
                return None
            current = int(timestamp)
            if current < MapboxMapMatchingClient.MIN_UNIX_TIMESTAMP:
                return None
            if previous is not None and current <= previous:
                return None
            normalized.append(current)
            previous = current
        return normalized

    def _build_form(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> dict[str, str]:
        form = {
            "coordinates": self._coordinate_param(coordinates),
            "geometries": "geojson",
            "overview": "full",
            "tidy": "true",
        }
        radius = get_mapbox_map_matching_radius_meters()
        if radius > 0:
            form["radiuses"] = ";".join(f"{radius:.1f}" for _ in coordinates)
        valid_timestamps = self._valid_timestamps(coordinates, timestamps)
        if valid_timestamps:
            form["timestamps"] = ";".join(str(value) for value in valid_timestamps)
        return form

    @staticmethod
    def _normalize_response(data: dict[str, Any]) -> dict[str, Any]:
        code = str(data.get("code") or "").strip()
        if code != "Ok":
            return {
                "code": "Error",
                "provider_code": code or "Error",
                "message": sanitize_mapbox_message(
                    data.get("message") or code or "No match"
                ),
            }

        raw_matchings = data.get("matchings") or []
        if not isinstance(raw_matchings, list) or not raw_matchings:
            return {
                "code": "Error",
                "provider_code": "NoMatch",
                "message": "Mapbox returned no match geometry",
            }

        segments: list[list[list[float]]] = []
        confidences: list[float] = []
        for matching in raw_matchings:
            if not isinstance(matching, dict):
                continue
            geometry = matching.get("geometry")
            segments.extend(extract_line_sequences(geometry))
            confidence = matching.get("confidence")
            if isinstance(confidence, int | float):
                confidences.append(float(confidence))

        usable_segments = [segment for segment in segments if len(segment) >= 2]
        if not usable_segments:
            return {
                "code": "Error",
                "provider_code": "NoGeometry",
                "message": "Mapbox returned no usable geometry",
            }

        if len(usable_segments) == 1:
            geometry: dict[str, Any] = {
                "type": "LineString",
                "coordinates": usable_segments[0],
            }
        else:
            geometry = {
                "type": "MultiLineString",
                "coordinates": usable_segments,
            }

        return {
            "code": "Ok",
            "provider_code": "Ok",
            "matchings": [{"geometry": geometry}],
            "coordinates": [point for segment in usable_segments for point in segment],
            "confidence": min(confidences) if confidences else None,
        }


__all__ = ["MapboxMapMatchingClient", "sanitize_mapbox_message"]
