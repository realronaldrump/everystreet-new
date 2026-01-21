"""Map matching service for snapping GPS coordinates to road networks."""

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient
from geo_service.geometry import GeometryService

logger = logging.getLogger(__name__)

# Type alias for the match_chunk callback
MatchChunkFunc = Callable[
    [list[list[float]], list[int | None] | None, int],
    Any,
]


class MapMatchingService:
    """Service for map matching coordinates to road networks using Valhalla."""

    def __init__(self) -> None:
        self._client = ValhallaClient()

    async def map_match_coordinates(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
        chunk_size: int = 100,
        overlap: int = 15,
        max_retries: int = 3,
        min_sub_chunk: int = 20,
        jump_threshold_m: float = 200.0,
    ) -> dict[str, Any]:
        """
        Map match coordinates using Valhalla.

        Args:
            coordinates: List of [lon, lat] coordinates
            timestamps: Optional list of Unix timestamps
            chunk_size: Maximum coordinates per API request (max 100)
            overlap: Overlap between chunks for better stitching
            max_retries: Maximum retries for failed chunks
            min_sub_chunk: Minimum coordinates for recursive splitting
            jump_threshold_m: Threshold for detecting jumps in meters

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

        return await self._process_map_matching(
            coordinates,
            timestamps,
            chunk_size,
            overlap,
            max_retries,
            min_sub_chunk,
            jump_threshold_m,
        )

    async def _process_map_matching(
        self,
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_size: int,
        overlap: int,
        max_retries: int,
        min_sub_chunk: int,
        jump_threshold_m: float,
    ) -> dict[str, Any]:
        """
        Process map matching with chunking and stitching.

        Args:
            coordinates: Coordinates to match
            all_timestamps: Optional timestamps
            chunk_size: Size of each chunk
            overlap: Overlap between chunks
            max_retries: Max retry attempts
            min_sub_chunk: Min chunk size for splitting
            jump_threshold_m: Jump detection threshold

        Returns:
            Map matching result dictionary
        """

        async def call_valhalla_api(
            coords: list[list[float]],
            timestamps_chunk: list[int | None] | None = None,
        ) -> dict[str, Any]:
            """Call Valhalla trace_route API."""
            use_timestamps = self._should_use_timestamps(coords, timestamps_chunk)
            shape = self._build_shape_points(
                coords,
                timestamps_chunk if use_timestamps else None,
            )
            try:
                return await self._execute_valhalla_request(
                    shape,
                    use_timestamps=use_timestamps,
                )
            except ExternalServiceException as exc:
                return {"code": "Error", "message": str(exc)}

        async def match_chunk(
            chunk_coords: list[list[float]],
            chunk_timestamps: list[int | None] | None = None,
            depth: int = 0,
        ) -> list[list[float]] | None:
            """Match a chunk of coordinates."""
            if not self._is_valid_chunk(chunk_coords):
                return []

            matched_coords = await self._try_match_chunk(
                chunk_coords,
                chunk_timestamps,
                call_valhalla_api,
            )
            if matched_coords is not None:
                return matched_coords

            # Try recursive splitting if allowed
            if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                return await self._match_chunk_recursive(
                    chunk_coords,
                    chunk_timestamps,
                    depth,
                    match_chunk,
                )

            return None

        # Split coordinates into chunks
        chunk_indices = self._create_chunk_indices(coordinates, chunk_size, overlap)
        logger.info(
            "Splitting %d coords into %d chunks",
            len(coordinates),
            len(chunk_indices),
        )

        # Process chunks and stitch results
        final_matched = await self._process_and_stitch_chunks(
            coordinates,
            all_timestamps,
            chunk_indices,
            match_chunk,
        )
        if isinstance(final_matched, dict):  # Error dict
            return final_matched

        # Detect and fix jumps
        final_matched = await self._fix_route_jumps(
            final_matched,
            jump_threshold_m,
            match_chunk,
        )

        logger.info("Final matched coords: %d points", len(final_matched))

        return self._create_matching_result(final_matched)

    @staticmethod
    def _build_shape_points(
        coords: list[list[float]],
        timestamps_chunk: list[int | None] | None,
    ) -> list[dict[str, float | int]]:
        """Build Valhalla shape points with optional timestamps."""
        shape = []
        for i, (lon, lat) in enumerate(coords):
            point: dict[str, float | int] = {"lon": lon, "lat": lat}
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
        shape: list[dict[str, float | int]],
        *,
        use_timestamps: bool = False,
    ) -> dict[str, Any]:
        """Execute Valhalla trace_route request with retries."""
        max_attempts = 3
        min_backoff = 1

        if use_timestamps and not any(point.get("time") for point in shape):
            use_timestamps = False

        for attempt in range(1, max_attempts + 1):
            try:
                result = await self._client.trace_route(
                    shape,
                    use_timestamps=use_timestamps or None,
                )
                geometry = result.get("geometry")
                coords = geometry.get("coordinates", []) if geometry else []
                if not geometry or not coords:
                    response = {
                        "code": "Error",
                        "message": f"Valhalla returned no geometry (input: {len(shape)} points).",
                    }
                else:
                    response = {
                        "code": "Ok",
                        "matchings": [{"geometry": geometry}],
                        "coordinates": coords,
                    }
            except ExternalServiceException:
                if attempt < max_attempts:
                    await asyncio.sleep(min_backoff * (2 ** (attempt - 1)))
                    continue
                raise
            else:
                return response

        return {"code": "Error", "message": "All retry attempts failed"}

    @staticmethod
    def _is_valid_chunk(chunk_coords: list[list[float]]) -> bool:
        """Validate chunk size."""
        if len(chunk_coords) < 2:
            return False
        if len(chunk_coords) > 100:
            logger.error("match_chunk received >100 coords unexpectedly.")
            return False
        return True

    async def _try_match_chunk(
        self,
        chunk_coords: list[list[float]],
        chunk_timestamps: list[int | None] | None,
        call_valhalla_api: Callable[..., Any],
    ) -> list[list[float]] | None:
        """Try to match a chunk using Valhalla."""
        try:
            data = await call_valhalla_api(chunk_coords, chunk_timestamps)
            if data.get("code") == "Ok" and data.get("matchings"):
                return data["matchings"][0]["geometry"]["coordinates"]

            msg = data.get("message", "Valhalla error (code != Ok)")
            logger.warning("Valhalla chunk error: %s", msg)

            if "invalid coordinates" in msg.lower():
                return await self._retry_with_filtered_coords(
                    chunk_coords,
                    call_valhalla_api,
                )

        except Exception as exc:
            logger.warning("Unexpected error in valhalla chunk: %s", str(exc))

        return None

    async def _retry_with_filtered_coords(
        self,
        chunk_coords: list[list[float]],
        call_valhalla_api: Callable[..., Any],
    ) -> list[list[float]] | None:
        """Retry matching after filtering invalid coordinates."""
        filtered = [
            c for c in chunk_coords if GeometryService.validate_coordinate_pair(c)[0]
        ]
        if len(filtered) >= 2 and len(filtered) < len(chunk_coords):
            return await self._try_match_chunk(filtered, None, call_valhalla_api)
        return None

    @staticmethod
    async def _match_chunk_recursive(
        chunk_coords: list[list[float]],
        chunk_timestamps: list[int | None] | None,
        depth: int,
        match_chunk: MatchChunkFunc,
    ) -> list[list[float]] | None:
        """Recursively split and match chunks."""
        mid = len(chunk_coords) // 2
        first_ts = chunk_timestamps[:mid] if chunk_timestamps else None
        second_ts = chunk_timestamps[mid:] if chunk_timestamps else None

        matched_first = await match_chunk(chunk_coords[:mid], first_ts, depth + 1)
        matched_second = await match_chunk(chunk_coords[mid:], second_ts, depth + 1)

        if matched_first is not None and matched_second is not None:
            # Remove duplicate point at junction
            if (
                matched_first
                and matched_second
                and matched_first[-1] == matched_second[0]
            ):
                matched_second = matched_second[1:]
            return matched_first + matched_second

        return None

    @staticmethod
    def _create_chunk_indices(
        coordinates: list[list[float]],
        chunk_size: int,
        overlap: int,
    ) -> list[tuple[int, int]]:
        """Create chunk indices with overlap."""
        n = len(coordinates)
        chunk_indices = []
        start_idx = 0
        while start_idx < n:
            end_idx = min(start_idx + chunk_size, n)
            chunk_indices.append((start_idx, end_idx))
            if end_idx == n:
                break
            start_idx = end_idx - overlap
        return chunk_indices

    @staticmethod
    async def _process_and_stitch_chunks(
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_indices: list[tuple[int, int]],
        match_chunk: MatchChunkFunc,
    ) -> list[list[float]] | dict[str, Any]:
        """Process all chunks and stitch them together."""
        final_matched: list[list[float]] = []

        for idx, (start_i, end_i) in enumerate(chunk_indices, 1):
            chunk_coords = coordinates[start_i:end_i]
            chunk_ts = (
                all_timestamps[start_i:end_i]
                if all_timestamps and len(all_timestamps) == len(coordinates)
                else None
            )

            result = await match_chunk(chunk_coords, chunk_ts, 0)
            if result is None:
                return {
                    "code": "Error",
                    "message": f"Chunk {idx} of {len(chunk_indices)} failed map matching.",
                }

            if not final_matched:
                final_matched = result
            else:
                # Remove duplicate point at junction
                if final_matched[-1] == result[0]:
                    result = result[1:]
                final_matched.extend(result)

        return final_matched

    async def _fix_route_jumps(
        self,
        coords: list[list[float]],
        threshold_m: float,
        match_chunk: MatchChunkFunc,
    ) -> list[list[float]]:
        """Detect and fix jumps in the route."""
        for _ in range(2):
            jumps = self._detect_jumps(coords, threshold_m)
            if not jumps:
                break

            coords = await self._repair_jumps(coords, jumps, match_chunk)

        return coords

    @staticmethod
    def _detect_jumps(coords: list[list[float]], threshold: float) -> list[int]:
        """Detect jumps larger than threshold in the route."""
        suspicious = []
        for i in range(len(coords) - 1):
            dist = GeometryService.haversine_distance(
                coords[i][0],
                coords[i][1],
                coords[i + 1][0],
                coords[i + 1][1],
                unit="meters",
            )
            if dist > threshold:
                suspicious.append(i)
        return suspicious

    @staticmethod
    async def _repair_jumps(
        coords: list[list[float]],
        jumps: list[int],
        match_chunk: MatchChunkFunc,
    ) -> list[list[float]]:
        """Repair detected jumps by rematching local areas."""
        new_coords = coords[:]
        offset = 0

        for j_idx in jumps:
            i = j_idx + offset
            if i < 1 or i >= len(new_coords) - 1:
                continue

            sub_coords = new_coords[i - 1 : i + 2]
            if len(sub_coords) < 2:
                continue

            local_match = await match_chunk(sub_coords, None, 0)
            if local_match and len(local_match) >= 2:
                new_coords = new_coords[: i - 1] + local_match + new_coords[i + 2 :]
                offset += len(local_match) - 3

        return new_coords

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

        return {"code": "Ok", "matchings": [{"geometry": geometry}]}
