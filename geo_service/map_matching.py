"""Map matching service for snapping GPS coordinates to road networks."""

import logging
from typing import Any

from config import get_valhalla_max_shape_points
from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient
from geo_service.geometry import GeometryService

logger = logging.getLogger(__name__)


class MapMatchingService:
    """Service for map matching coordinates to road networks using Valhalla."""

    def __init__(self) -> None:
        self._client = ValhallaClient()

    async def map_match_coordinates(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
        chunk_size: int | None = None,
    ) -> dict[str, Any]:
        """
        Map match coordinates using Valhalla.

        Args:
            coordinates: List of [lon, lat] coordinates
            timestamps: Optional list of Unix timestamps
            chunk_size: Maximum coordinates per API request

        Returns:
            Dictionary with map matching results
        """
        if not coordinates:
            return {
                "code": "Error",
                "message": "No coordinates provided for map matching.",
            }

        if len(coordinates) < 2:
            return {
                "code": "Error",
                "message": "At least two coordinates are required for map matching.",
            }

        filtered_coords, filtered_timestamps = self._filter_coordinates(
            coordinates,
            timestamps,
        )
        if len(filtered_coords) < 2:
            return {
                "code": "Error",
                "message": "No valid coordinates available for map matching.",
            }

        max_points = chunk_size or get_valhalla_max_shape_points()
        if max_points < 2:
            max_points = 2

        if len(filtered_coords) <= max_points:
            return await self._map_match_chunk(filtered_coords, filtered_timestamps)

        return await self._map_match_chunked(
            filtered_coords,
            filtered_timestamps,
            max_points,
        )

    @staticmethod
    def _filter_coordinates(
        coordinates: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> tuple[list[list[float]], list[int | None] | None]:
        """Filter invalid coordinates and align timestamps."""
        valid_coords: list[list[float]] = []
        valid_timestamps: list[int | None] | None = [] if timestamps else None

        for idx, coord in enumerate(coordinates):
            is_valid, _ = GeometryService.validate_coordinate_pair(coord)
            if not is_valid:
                continue
            valid_coords.append(coord)
            if valid_timestamps is not None:
                if idx < len(timestamps or []):
                    valid_timestamps.append((timestamps or [])[idx])

        if valid_timestamps is not None and len(valid_timestamps) != len(valid_coords):
            valid_timestamps = None

        return valid_coords, valid_timestamps

    async def _map_match_chunk(
        self,
        coords: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> dict[str, Any]:
        """Map match a single chunk of coordinates."""
        use_timestamps = self._should_use_timestamps(coords, timestamps)
        shape = self._build_shape_points(
            coords,
            timestamps if use_timestamps else None,
        )
        try:
            return await self._execute_valhalla_request(
                shape,
                use_timestamps=use_timestamps,
            )
        except ExternalServiceException as exc:
            return {"code": "Error", "message": str(exc)}

    async def _map_match_chunked(
        self,
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_size: int,
    ) -> dict[str, Any]:
        """Process map matching in fixed-size chunks (no overlap)."""
        chunk_indices = self._create_chunk_indices(coordinates, chunk_size)
        logger.info(
            "Splitting %d coords into %d chunks",
            len(coordinates),
            len(chunk_indices),
        )

        final_matched: list[list[float]] = []

        for idx, (start_i, end_i) in enumerate(chunk_indices, 1):
            chunk_coords = coordinates[start_i:end_i]
            chunk_ts = (
                all_timestamps[start_i:end_i]
                if all_timestamps and len(all_timestamps) == len(coordinates)
                else None
            )

            result = await self._map_match_chunk(chunk_coords, chunk_ts)
            if result.get("code") != "Ok":
                return {
                    "code": "Error",
                    "message": (
                        f"Chunk {idx} of {len(chunk_indices)} failed map matching. "
                        f"{result.get('message', '')}".strip()
                    ),
                }

            matched = (
                result.get("matchings", [{}])[0]
                .get("geometry", {})
                .get("coordinates", [])
            )
            if not matched:
                return {
                    "code": "Error",
                    "message": (
                        f"Chunk {idx} of {len(chunk_indices)} returned no geometry."
                    ),
                }

            if not final_matched:
                final_matched = matched
            else:
                if final_matched[-1] == matched[0]:
                    matched = matched[1:]
                final_matched.extend(matched)

        logger.info("Final matched coords: %d points", len(final_matched))
        return self._create_matching_result(final_matched)

    @staticmethod
    def _build_shape_points(
        coords: list[list[float]],
        timestamps_chunk: list[int | None] | None,
    ) -> list[dict[str, float | int | str]]:
        """Build Valhalla shape points with optional timestamps."""
        shape = []
        last_idx = len(coords) - 1
        for i, (lon, lat) in enumerate(coords):
            point: dict[str, float | int | str] = {"lon": lon, "lat": lat}
            point["type"] = "break" if i in (0, last_idx) else "via"
            if (
                timestamps_chunk
                and i < len(timestamps_chunk)
                and timestamps_chunk[i] is not None
            ):
                timestamp = timestamps_chunk[i]
                if timestamp is not None:
                    point["time"] = int(timestamp)
            shape.append(point)
        return shape

    @staticmethod
    def _should_use_timestamps(
        coords: list[list[float]],
        timestamps_chunk: list[int | None] | None,
    ) -> bool:
        if not timestamps_chunk or len(timestamps_chunk) != len(coords):
            return False
        last_ts: int | None = None
        for timestamp in timestamps_chunk:
            if timestamp is None:
                return False
            if last_ts is not None and timestamp < last_ts:
                return False
            last_ts = timestamp
        return True

    async def _execute_valhalla_request(
        self,
        shape: list[dict[str, float | int | str]],
        *,
        use_timestamps: bool = False,
    ) -> dict[str, Any]:
        """Execute Valhalla trace_route request."""
        if use_timestamps and not any(point.get("time") for point in shape):
            use_timestamps = False

        result = await self._client.trace_route(
            shape,
            use_timestamps=use_timestamps or None,
        )
        geometry = result.get("geometry")
        coords = geometry.get("coordinates", []) if geometry else []
        if not geometry or not coords:
            return {
                "code": "Error",
                "message": f"Valhalla returned no geometry (input: {len(shape)} points).",
            }

        return {
            "code": "Ok",
            "matchings": [{"geometry": geometry}],
            "coordinates": coords,
        }

    @staticmethod
    def _create_chunk_indices(
        coordinates: list[list[float]],
        chunk_size: int,
    ) -> list[tuple[int, int]]:
        """Create chunk indices without overlap."""
        n = len(coordinates)
        return [
            (start, min(start + chunk_size, n))
            for start in range(0, n, chunk_size)
        ]

    @staticmethod
    def _create_matching_result(coords: list[list[float]]) -> dict[str, Any]:
        """Create final matching result dictionary."""
        geometry = GeometryService.geometry_from_coordinate_pairs(
            coords,
            allow_point=False,
            dedupe=False,
            validate=False,
        )
        if geometry is None:
            return {
                "code": "Error",
                "message": "Map matching produced insufficient coordinates.",
            }

        return {
            "code": "Ok",
            "matchings": [{"geometry": geometry}],
            "coordinates": coords,
        }
