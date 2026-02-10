"""Trip map matching services using Valhalla."""

from __future__ import annotations

import logging
from typing import Any

from core.clients.valhalla import ValhallaClient
from core.date_utils import get_current_utc_time
from core.exceptions import ExternalServiceException
from core.spatial import GeometryService, extract_timestamps_for_coordinates

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

        from config import get_valhalla_max_shape_points

        max_points = chunk_size or get_valhalla_max_shape_points()
        max_points = max(max_points, 2)

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
        valid_coords: list[list[float]] = []
        valid_timestamps: list[int | None] | None = [] if timestamps else None

        for idx, coord in enumerate(coordinates):
            is_valid, _ = GeometryService.validate_coordinate_pair(coord)
            if not is_valid:
                continue
            valid_coords.append(coord)
            if valid_timestamps is not None and idx < len(timestamps or []):
                valid_timestamps.append((timestamps or [])[idx])

        if valid_timestamps is not None and len(valid_timestamps) != len(valid_coords):
            valid_timestamps = None

        return valid_coords, valid_timestamps

    async def _map_match_chunk(
        self,
        coords: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> dict[str, Any]:
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
        n = len(coordinates)
        return [
            (start, min(start + chunk_size, n)) for start in range(0, n, chunk_size)
        ]

    @staticmethod
    def _create_matching_result(coords: list[list[float]]) -> dict[str, Any]:
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


class TripMapMatcher:
    """Apply map matching to trip data."""

    def __init__(self, map_matching_service: MapMatchingService | None = None) -> None:
        self.map_matching_service = map_matching_service or MapMatchingService()

    async def map_match(
        self,
        processed_data: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        try:
            transaction_id = processed_data.get("transactionId", "unknown")

            def set_match_status(value: str) -> None:
                processed_data["matchStatus"] = value

            gps_data = processed_data.get("gps")
            if not gps_data or not isinstance(gps_data, dict):
                logger.debug("Trip %s has no GPS data for map matching", transaction_id)
                set_match_status("skipped:no-gps")
                return "skipped", processed_data

            gps_type = gps_data.get("type")

            if gps_type == "Point":
                logger.info(
                    "Trip %s: GPS is a single Point, skipping map matching",
                    transaction_id,
                )
                set_match_status("skipped:single-point")
                return "skipped", processed_data

            if gps_type == "LineString":
                coords = gps_data.get("coordinates", [])
                if len(coords) < 2:
                    logger.warning(
                        "Trip %s: Insufficient coordinates for map matching",
                        transaction_id,
                    )
                    set_match_status("skipped:insufficient-coordinates")
                    return "skipped", processed_data
            else:
                logger.warning(
                    "Trip %s: Unexpected GPS type '%s'",
                    transaction_id,
                    gps_type,
                )
                set_match_status(f"skipped:unsupported-gps-type:{gps_type}")
                return "skipped", processed_data

            timestamps = extract_timestamps_for_coordinates(coords, processed_data)
            match_result = await self.map_matching_service.map_match_coordinates(
                coords,
                timestamps,
            )

            if match_result.get("code") != "Ok":
                error_msg = match_result.get("message", "Unknown map matching error")
                logger.error(
                    "Map matching failed for trip %s: %s",
                    transaction_id,
                    error_msg,
                )
                set_match_status(f"error:{error_msg}")
                return "failed", processed_data

            validated_matched_gps = self._validate_matched_geometry(
                match_result,
                transaction_id,
            )

            if validated_matched_gps:
                processed_data["matchedGps"] = validated_matched_gps
                processed_data["matched_at"] = get_current_utc_time()
                geom_type = validated_matched_gps.get("type", "unknown")
                set_match_status(f"matched:{str(geom_type).lower()}")
                logger.debug("Map matched trip %s successfully", transaction_id)
                return "matched", processed_data

            logger.info("No valid matchedGps data for trip %s", transaction_id)
            set_match_status("no-valid-geometry")

        except Exception as exc:
            logger.warning(
                "Map matching error for trip %s (continuing): %s",
                processed_data.get("transactionId", "unknown"),
                exc,
            )
            processed_data["matchStatus"] = "error:exception"
        return "failed", processed_data

    @staticmethod
    def _validate_matched_geometry(
        match_result: dict[str, Any],
        transaction_id: str,
    ) -> dict[str, Any] | None:
        if not match_result.get("matchings") or not match_result["matchings"][0].get(
            "geometry",
        ):
            return None

        matched_geometry = match_result["matchings"][0]["geometry"]
        geom_type = matched_geometry.get("type")
        geom_coords = matched_geometry.get("coordinates")

        if geom_type == "LineString":
            if isinstance(geom_coords, list) and len(geom_coords) >= 2:
                start_point = tuple(geom_coords[0])
                if all(tuple(p) == start_point for p in geom_coords[1:]):
                    logger.warning(
                        "Trip %s: Matched LineString has identical points",
                        transaction_id,
                    )
                    return {
                        "type": "Point",
                        "coordinates": geom_coords[0],
                    }
                return matched_geometry
        elif (
            geom_type == "Point"
            and isinstance(geom_coords, list)
            and len(geom_coords) == 2
        ):
            return matched_geometry

        return None


__all__ = [
    "MapMatchingService",
    "TripMapMatcher",
    "extract_timestamps_for_coordinates",
]
