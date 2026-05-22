"""Trip map matching services using Valhalla."""

from __future__ import annotations

import logging
from itertools import pairwise
from typing import Any

from core.date_utils import get_current_utc_time
from core.exceptions import ExternalServiceException
from core.mapping.factory import get_router
from core.spatial import (
    GeometryService,
    extract_line_sequences,
    extract_timestamps_for_coordinates,
)

logger = logging.getLogger(__name__)


class MapMatchingService:
    """Service for map matching coordinates to road networks using Valhalla."""

    _MIN_QUALITY_RAW_DISTANCE_MILES = 0.5
    _MIN_MATCHED_DISTANCE_RATIO = 0.65
    _MAX_MATCHED_DISTANCE_RATIO = 1.75
    _MIN_ENDPOINT_TOLERANCE_MILES = 0.5
    _MAX_ENDPOINT_TOLERANCE_MILES = 2.0
    _ENDPOINT_TOLERANCE_RATIO = 0.10
    _MIN_RECOVERY_COORDINATES = 10
    _MAX_RECOVERY_DEPTH = 5
    _MAX_RECOVERY_JOIN_MILES = 0.05
    _MAX_OVERLAP_CONNECTOR_MILES = 0.08
    _MAX_RAW_GAP_FOR_MATCHED_DISCONTINUITY_MILES = 0.12

    def __init__(self, router: Any | None = None) -> None:
        self._router = router

    async def _get_router(self) -> Any:
        if self._router is None:
            self._router = await get_router()
        return self._router

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
            return await self._map_match_chunk_with_recovery(
                filtered_coords,
                filtered_timestamps,
            )

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
            result = await self._execute_valhalla_request(
                shape,
                use_timestamps=use_timestamps,
            )
        except ExternalServiceException as exc:
            return {"code": "Error", "message": str(exc)}
        if result.get("code") != "Ok":
            return result
        geometry = result.get("matchings", [{}])[0].get("geometry")
        quality_error = self.validate_matched_geometry_quality(coords, geometry)
        if quality_error:
            return {"code": "Error", "message": quality_error}
        return result

    async def _map_match_chunk_with_recovery(
        self,
        coords: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> dict[str, Any]:
        result = await self._map_match_chunk(coords, timestamps)
        if result.get("code") == "Ok":
            return result

        message = str(result.get("message") or "")
        if not self._is_too_short_quality_error(message):
            return result

        recovered = await self._recover_failed_chunk_as_result(coords, timestamps)
        if recovered.get("code") == "Ok":
            logger.info(
                "Recovered low-quality map match by splitting %d input coordinates",
                len(coords),
            )
            return recovered

        logger.info(
            "Segmented recovery did not produce an acceptable match for %d input "
            "coordinates: %s",
            len(coords),
            recovered.get("message"),
        )
        return result

    # Number of GPS points to duplicate at each chunk boundary so that
    # Valhalla can produce a seamless match across chunks.
    _CHUNK_OVERLAP = 20

    # Maximum distance (in degrees, ~1.1 km at mid-latitudes) between
    # consecutive matched points before we consider the result broken.
    _MAX_MATCHED_JUMP_DEG = 0.01

    # Tolerance for overlap trimming — matched points within this many
    # degrees (~100 m) of the previous chunk's tail are considered part
    # of the overlap region and are dropped.
    _OVERLAP_TRIM_TOL_DEG = 0.001

    async def _map_match_chunked(
        self,
        coordinates: list[list[float]],
        all_timestamps: list[int | None] | None,
        chunk_size: int,
    ) -> dict[str, Any]:
        chunk_indices = self._create_chunk_indices_with_overlap(
            coordinates,
            chunk_size,
            self._CHUNK_OVERLAP,
        )
        logger.info(
            "Splitting %d coords into %d overlapping chunks (overlap=%d)",
            len(coordinates),
            len(chunk_indices),
            self._CHUNK_OVERLAP,
        )

        final_segments: list[list[list[float]]] = []

        for idx, (start_i, end_i) in enumerate(chunk_indices, 1):
            chunk_coords = coordinates[start_i:end_i]
            chunk_ts = (
                all_timestamps[start_i:end_i]
                if all_timestamps and len(all_timestamps) == len(coordinates)
                else None
            )

            result = await self._map_match_chunk(chunk_coords, chunk_ts)
            if result.get("code") != "Ok":
                logger.warning(
                    "Chunk %d of %d failed map matching, attempting sub-chunk retry. %s",
                    idx,
                    len(chunk_indices),
                    result.get("message", "").strip(),
                )
                recovered = await self._retry_failed_chunk(chunk_coords, chunk_ts)
                if not recovered:
                    logger.warning(
                        "Chunk %d: sub-chunk retry also failed, skipping",
                        idx,
                    )
                    continue
                matched_segments = recovered
            else:
                matched_segments = self._extract_matched_segments(result)
            if not matched_segments:
                logger.warning(
                    "Chunk %d of %d returned no geometry.",
                    idx,
                    len(chunk_indices),
                )
                continue

            self._append_matched_segments(final_segments, matched_segments)

        if not final_segments:
            return {
                "code": "Error",
                "message": "All chunks failed map matching or returned no geometry.",
            }

        all_segments = self._normalize_matched_segments(final_segments)
        if not all_segments:
            return {
                "code": "Error",
                "message": (
                    "Map matching produced discontinuous geometry "
                    "(large jump between consecutive points)."
                ),
            }

        total_points = sum(len(s) for s in all_segments)
        logger.info(
            "Final matched: %d segment(s), %d total points",
            len(all_segments),
            total_points,
        )

        result = (
            self._create_matching_result(all_segments[0])
            if len(all_segments) == 1
            else self._create_multi_matching_result(all_segments)
        )
        if result.get("code") != "Ok":
            return result

        geometry = result.get("matchings", [{}])[0].get("geometry")
        quality_error = self.validate_matched_geometry_quality(coordinates, geometry)
        if quality_error:
            return {"code": "Error", "message": quality_error}
        return result

    async def _recover_failed_chunk_as_result(
        self,
        coords: list[list[float]],
        timestamps: list[int | None] | None,
    ) -> dict[str, Any]:
        recovered_segments = await self._retry_failed_chunk(coords, timestamps)
        recovered_segments = self._normalize_matched_segments(recovered_segments)
        if not recovered_segments:
            return {
                "code": "Error",
                "message": "Segmented recovery produced no usable geometry.",
            }

        result = (
            self._create_matching_result(recovered_segments[0])
            if len(recovered_segments) == 1
            else self._create_multi_matching_result(recovered_segments)
        )
        if result.get("code") != "Ok":
            return result

        geometry = result.get("matchings", [{}])[0].get("geometry")
        quality_error = self.validate_matched_geometry_quality(coords, geometry)
        if quality_error:
            return {"code": "Error", "message": quality_error}
        return result

    @classmethod
    def validate_matched_geometry_quality(
        cls,
        input_coordinates: list[list[float]],
        matched_geometry: dict[str, Any] | None,
    ) -> str | None:
        raw_line = cls._normalize_coordinate_pairs(input_coordinates)
        if len(raw_line) < 2:
            return None

        raw_distance_miles = cls._line_distance_miles([raw_line])
        if raw_distance_miles < cls._MIN_QUALITY_RAW_DISTANCE_MILES:
            return None

        matched_lines = extract_line_sequences(matched_geometry)
        if not matched_lines:
            return "low-quality-match:no-lines"

        matched_distance_miles = cls._line_distance_miles(matched_lines)
        if matched_distance_miles <= 0:
            return "low-quality-match:empty-distance"

        distance_ratio = matched_distance_miles / raw_distance_miles
        if distance_ratio < cls._MIN_MATCHED_DISTANCE_RATIO:
            return f"low-quality-match:too-short:{distance_ratio:.2f}"
        if distance_ratio > cls._MAX_MATCHED_DISTANCE_RATIO:
            return f"low-quality-match:too-long:{distance_ratio:.2f}"

        start_delta = cls._coordinate_distance_miles(
            raw_line[0],
            matched_lines[0][0],
        )
        end_delta = cls._coordinate_distance_miles(
            raw_line[-1],
            matched_lines[-1][-1],
        )
        endpoint_delta = max(start_delta, end_delta)
        endpoint_tolerance = min(
            cls._MAX_ENDPOINT_TOLERANCE_MILES,
            max(
                cls._MIN_ENDPOINT_TOLERANCE_MILES,
                raw_distance_miles * cls._ENDPOINT_TOLERANCE_RATIO,
            ),
        )
        if endpoint_delta > endpoint_tolerance:
            return f"low-quality-match:endpoint-drift:{endpoint_delta:.2f}mi"

        discontinuity_error = cls._validate_matched_segment_continuity(
            raw_line,
            matched_lines,
        )
        if discontinuity_error:
            return discontinuity_error

        return None

    @classmethod
    def _validate_matched_segment_continuity(
        cls,
        raw_line: list[list[float]],
        matched_lines: list[list[list[float]]],
    ) -> str | None:
        if len(matched_lines) <= 1:
            return None

        raw_max_gap = cls._max_adjacent_gap_miles(raw_line)
        if raw_max_gap > cls._MAX_RAW_GAP_FOR_MATCHED_DISCONTINUITY_MILES:
            return None

        matched_max_gap = 0.0
        for previous, current in pairwise(matched_lines):
            if not previous or not current:
                continue
            matched_max_gap = max(
                matched_max_gap,
                cls._coordinate_distance_miles(previous[-1], current[0]),
            )

        if matched_max_gap > cls._MAX_RECOVERY_JOIN_MILES:
            return f"low-quality-match:discontinuous:{matched_max_gap:.2f}mi"

        return None

    @classmethod
    def _max_adjacent_gap_miles(cls, coords: list[list[float]]) -> float:
        max_gap = 0.0
        for previous, current in pairwise(coords):
            max_gap = max(max_gap, cls._coordinate_distance_miles(previous, current))
        return max_gap

    @staticmethod
    def _is_too_short_quality_error(message: str) -> bool:
        return message.startswith("low-quality-match:too-short:")

    @staticmethod
    def _normalize_coordinate_pairs(
        coordinates: list[list[float]],
    ) -> list[list[float]]:
        normalized: list[list[float]] = []
        for coord in coordinates:
            is_valid, pair = GeometryService.validate_coordinate_pair(coord)
            if is_valid and pair is not None:
                normalized.append(pair)
        return normalized

    @classmethod
    def _line_distance_miles(cls, lines: list[list[list[float]]]) -> float:
        distance = 0.0
        for line in lines:
            for start, end in pairwise(line):
                distance += cls._coordinate_distance_miles(start, end)
        return distance

    @staticmethod
    def _coordinate_distance_miles(
        start: list[float],
        end: list[float],
    ) -> float:
        return GeometryService.haversine_distance(
            start[0],
            start[1],
            end[0],
            end[1],
            unit="miles",
        )

    @classmethod
    def _find_overlap_trim(
        cls,
        existing: list[list[float]],
        new_chunk: list[list[float]],
    ) -> int:
        """
        Find the number of leading points to trim from *new_chunk*.

        Walk through the head of *new_chunk* and find the last point within
        the overlap tolerance of the existing tail. A trim is accepted only
        when the next retained point is still close enough to continue the
        line without adding a visible connector.
        """
        if not existing or not new_chunk:
            return 0

        tail = existing[-1]
        best_trim = 0
        search_limit = min(len(new_chunk), cls._CHUNK_OVERLAP * 4)
        for i in range(search_limit):
            dx = new_chunk[i][0] - tail[0]
            dy = new_chunk[i][1] - tail[1]
            if (
                abs(dx) < cls._OVERLAP_TRIM_TOL_DEG
                and abs(dy) < cls._OVERLAP_TRIM_TOL_DEG
            ):
                trim = i + 1
                if trim >= len(new_chunk):
                    best_trim = trim
                    continue
                connector_miles = cls._coordinate_distance_miles(
                    tail,
                    new_chunk[trim],
                )
                if connector_miles <= cls._MAX_OVERLAP_CONNECTOR_MILES:
                    best_trim = trim
        return best_trim

    @classmethod
    def _salvage_continuous_segments(
        cls,
        coords: list[list[float]],
    ) -> list[list[list[float]]]:
        """
        Split at discontinuities and return ALL contiguous segments.

        Instead of rejecting the entire match when one jump is found,
        this keeps every usable piece of geometry so that coverage is
        not lost due to a single GPS jump mid-trip.

        Returns a list of coordinate lists (one per contiguous segment).
        """
        if len(coords) < 2:
            return [coords] if coords else []

        # Build list of contiguous segments
        segments: list[list[list[float]]] = []
        current: list[list[float]] = [coords[0]]

        for i in range(1, len(coords)):
            dx = abs(coords[i][0] - coords[i - 1][0])
            dy = abs(coords[i][1] - coords[i - 1][1])
            if dx > cls._MAX_MATCHED_JUMP_DEG or dy > cls._MAX_MATCHED_JUMP_DEG:
                logger.warning(
                    "Matched geometry has %.4f° jump at index %d — splitting",
                    max(dx, dy),
                    i,
                )
                if len(current) >= 2:
                    segments.append(current)
                current = [coords[i]]
            else:
                current.append(coords[i])

        if len(current) >= 2:
            segments.append(current)

        if not segments:
            return []

        if len(segments) > 1:
            logger.info(
                "Salvaged %d contiguous segments with %d total points "
                "(split at %d discontinuities)",
                len(segments),
                sum(len(s) for s in segments),
                len(segments) - 1,
            )
        return segments

    @classmethod
    def _merge_close_segments(
        cls,
        segments: list[list[list[float]]],
    ) -> list[list[list[float]]]:
        """Merge adjacent segments whose gap is within 2x the jump threshold."""
        if len(segments) <= 1:
            return segments
        threshold = cls._MAX_MATCHED_JUMP_DEG * 2
        merged: list[list[list[float]]] = [list(segments[0])]
        for seg in segments[1:]:
            dx = abs(seg[0][0] - merged[-1][-1][0])
            dy = abs(seg[0][1] - merged[-1][-1][1])
            if dx <= threshold and dy <= threshold:
                merged[-1].extend(seg)
            else:
                merged.append(list(seg))
        return merged

    async def _retry_failed_chunk(
        self,
        coords: list[list[float]],
        timestamps: list[int | None] | None,
        depth: int = 0,
    ) -> list[list[list[float]]]:
        """Split a failed chunk and return validated matched line segments."""
        if (
            len(coords) < self._MIN_RECOVERY_COORDINATES
            or depth >= self._MAX_RECOVERY_DEPTH
        ):
            return []

        mid = len(coords) // 2
        # Cap overlap so each half is strictly smaller than the input
        overlap = min(self._CHUNK_OVERLAP, mid // 2)
        halves = [
            (
                coords[: mid + overlap],
                timestamps[: mid + overlap] if timestamps else None,
            ),
            (
                coords[mid - overlap :],
                timestamps[mid - overlap :] if timestamps else None,
            ),
        ]

        segments: list[list[list[float]]] = []
        for sub_coords, sub_ts in halves:
            result = await self._map_match_chunk(sub_coords, sub_ts)
            if result.get("code") == "Ok":
                self._append_matched_segments(
                    segments,
                    self._extract_matched_segments(result),
                )
            else:
                recovered = await self._retry_failed_chunk(
                    sub_coords, sub_ts, depth + 1
                )
                if recovered:
                    self._append_matched_segments(segments, recovered)

        segments = self._normalize_matched_segments(segments)

        logger.info(
            "Recovered %d segment(s) via sub-chunk retry (depth %d)",
            len(segments),
            depth,
        )
        return segments

    @staticmethod
    def _extract_matched_segments(result: dict[str, Any]) -> list[list[list[float]]]:
        geometry = result.get("matchings", [{}])[0].get("geometry")
        return extract_line_sequences(geometry)

    @classmethod
    def _append_matched_segments(
        cls,
        existing: list[list[list[float]]],
        incoming: list[list[list[float]]],
    ) -> None:
        for segment in cls._normalize_matched_segments(incoming):
            if not existing:
                existing.append(list(segment))
                continue

            previous = existing[-1]
            trim = cls._find_overlap_trim(previous, segment)
            if trim > 0:
                previous.extend(segment[trim:])
                continue

            gap_miles = cls._coordinate_distance_miles(previous[-1], segment[0])
            if gap_miles <= cls._MAX_RECOVERY_JOIN_MILES:
                previous.extend(segment)
                continue

            existing.append(list(segment))

    @classmethod
    def _normalize_matched_segments(
        cls,
        segments: list[list[list[float]]],
    ) -> list[list[list[float]]]:
        normalized: list[list[list[float]]] = []
        for segment in segments:
            normalized.extend(
                salvaged
                for salvaged in cls._salvage_continuous_segments(segment)
                if len(salvaged) >= 2
            )
        return normalized

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

        client = await self._get_router()
        result = await client.trace_attributes(
            shape,
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
    def _create_chunk_indices_with_overlap(
        coordinates: list[list[float]],
        chunk_size: int,
        overlap: int,
    ) -> list[tuple[int, int]]:
        """Create chunk boundaries with *overlap* shared points between consecutive
        chunks.
        """
        n = len(coordinates)
        if n <= chunk_size:
            return [(0, n)]
        step = max(1, chunk_size - overlap)
        indices: list[tuple[int, int]] = []
        start = 0
        while start < n:
            end = min(start + chunk_size, n)
            indices.append((start, end))
            if end >= n:
                break
            start += step
        return indices

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

    @staticmethod
    def _create_multi_matching_result(
        segments: list[list[list[float]]],
    ) -> dict[str, Any]:
        """Create a MultiLineString result from multiple contiguous segments."""
        geometry = {
            "type": "MultiLineString",
            "coordinates": segments,
        }
        all_coords = [coord for seg in segments for coord in seg]
        return {
            "code": "Ok",
            "matchings": [{"geometry": geometry}],
            "coordinates": all_coords,
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
                quality_error = MapMatchingService.validate_matched_geometry_quality(
                    coords,
                    validated_matched_gps,
                )
                if quality_error:
                    logger.warning(
                        "Map matching produced low-quality geometry for trip %s: %s",
                        transaction_id,
                        quality_error,
                    )
                    set_match_status(f"error:{quality_error}")
                    return "failed", processed_data

                processed_data["matchedGps"] = validated_matched_gps
                processed_data["matched_at"] = get_current_utc_time()
                geom_type = validated_matched_gps.get("type", "unknown")
                set_match_status(f"matched:{str(geom_type).lower()}")
                logger.debug("Map matched trip %s successfully", transaction_id)
                return "matched", processed_data

            logger.info("No valid matchedGps data for trip %s", transaction_id)
            set_match_status("error:no-geometry")

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
        elif geom_type == "MultiLineString":
            if isinstance(geom_coords, list) and len(geom_coords) >= 1:
                # Filter out degenerate lines (single point or all identical)
                valid_lines = []
                for line_coords in geom_coords:
                    if isinstance(line_coords, list) and len(line_coords) >= 2:
                        start = tuple(line_coords[0])
                        if not all(tuple(p) == start for p in line_coords[1:]):
                            valid_lines.append(line_coords)
                if not valid_lines:
                    return None
                if len(valid_lines) == 1:
                    return {
                        "type": "LineString",
                        "coordinates": valid_lines[0],
                    }
                return {
                    "type": "MultiLineString",
                    "coordinates": valid_lines,
                }
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
