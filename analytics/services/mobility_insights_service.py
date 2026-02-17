"""Automatic H3-based mobility insights for streets and segments."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import h3
from beanie import PydanticObjectId
from shapely.geometry import LineString
from shapely.ops import transform

from core.clients.nominatim import GeocodingService
from core.spatial import (
    GeometryService,
    geodesic_distance_meters,
    get_local_transformers,
)
from db.aggregation import aggregate_to_list
from db.models import H3StreetLabelCache, Trip, TripMobilityProfile

logger = logging.getLogger(__name__)


H3_RESOLUTION = 11
H3_SAMPLE_SPACING_M = 30.0
MAX_SYNC_TRIPS_PER_REQUEST = 250
MAX_HEX_CELLS = 800
MAX_SEGMENTS = 300
MAX_STREETS = 25
MAX_HEX_STREET_LOOKUPS = 160
MAX_SEGMENT_LABEL_LOOKUPS = 20
MAX_PATH_TRIPS_FOR_RENDER = 1200
MAX_PATHS_PER_ENTITY = 220
METERS_TO_MILES = 0.000621371


def _combine_query(*clauses: dict[str, Any] | None) -> dict[str, Any]:
    clean = [clause for clause in clauses if clause]
    if not clean:
        return {}
    if len(clean) == 1:
        return clean[0]
    return {"$and": clean}


def _normalize_line_coords(coords: Any) -> list[list[float]]:
    if not isinstance(coords, list):
        return []
    normalized: list[list[float]] = []
    for coord in coords:
        is_valid, pair = GeometryService.validate_coordinate_pair(coord)
        if not is_valid or pair is None:
            continue
        if not normalized or pair != normalized[-1]:
            normalized.append(pair)
    return normalized


def _line_sequences_from_geometry(geometry: dict[str, Any]) -> list[list[list[float]]]:
    geometry_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geometry_type == "LineString":
        line = _normalize_line_coords(coords)
        return [line] if len(line) >= 2 else []
    if geometry_type == "MultiLineString" and isinstance(coords, list):
        lines: list[list[list[float]]] = []
        for line_coords in coords:
            line = _normalize_line_coords(line_coords)
            if len(line) >= 2:
                lines.append(line)
        return lines
    return []


def _sample_line_points(line_coords: list[list[float]], spacing_m: float) -> list[list[float]]:
    if len(line_coords) < 2:
        return []

    line = LineString(line_coords)
    if line.is_empty:
        return []

    to_meters, to_wgs84 = get_local_transformers(line)
    line_m = transform(to_meters, line)
    total_length_m = float(line_m.length or 0.0)
    if total_length_m <= 0.0:
        return line_coords

    step = max(5.0, float(spacing_m))
    sampled: list[list[float]] = []
    distance_m = 0.0
    while distance_m < total_length_m:
        point_m = line_m.interpolate(distance_m)
        point_wgs = transform(to_wgs84, point_m)
        sampled.append([float(point_wgs.x), float(point_wgs.y)])
        distance_m += step

    sampled.append(line_coords[-1])

    deduped: list[list[float]] = []
    for point in sampled:
        if not deduped or point != deduped[-1]:
            deduped.append(point)
    return deduped


def _segment_key(cell_a: str, cell_b: str) -> tuple[str, str, str]:
    if cell_a <= cell_b:
        return f"{cell_a}|{cell_b}", cell_a, cell_b
    return f"{cell_b}|{cell_a}", cell_b, cell_a


def _normalize_street_name(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    return " ".join(cleaned.split())


def _normalize_street_key(value: str | None) -> str:
    normalized = _normalize_street_name(value)
    return normalized.casefold() if isinstance(normalized, str) else ""


def _sanitize_path(path: list[list[float]]) -> list[list[float]]:
    cleaned: list[list[float]] = []
    for point in path:
        is_valid, pair = GeometryService.validate_coordinate_pair(point)
        if not is_valid or pair is None:
            continue
        if not cleaned or pair != cleaned[-1]:
            cleaned.append(pair)
    return cleaned


def _append_path_segment(
    container: dict[str, list[list[list[float]]]],
    key: str,
    segment: list[list[float]],
    *,
    max_paths_per_key: int = MAX_PATHS_PER_ENTITY,
) -> None:
    if not key:
        return
    cleaned = _sanitize_path(segment)
    if len(cleaned) < 2:
        return
    paths = container.setdefault(key, [])
    if paths and paths[-1] and paths[-1][-1] == cleaned[0]:
        merged = _sanitize_path([*paths[-1], *cleaned[1:]])
        if len(merged) >= 2:
            paths[-1] = merged
        return
    if len(paths) >= max_paths_per_key:
        return
    paths.append(cleaned)


def _entity_has_paths(item: dict[str, Any]) -> bool:
    paths = item.get("paths")
    return isinstance(paths, list) and any(
        isinstance(path, list) and len(path) >= 2 for path in paths
    )


class MobilityInsightsService:
    """Builds and serves automatic movement insights using H3 traversal stats."""

    _geocoder = GeocodingService()

    @classmethod
    def _select_trip_geometry(
        cls,
        trip_data: dict[str, Any],
    ) -> tuple[list[list[list[float]]], str | None]:
        matched = GeometryService.parse_geojson(trip_data.get("matchedGps"))
        if isinstance(matched, dict):
            lines = _line_sequences_from_geometry(matched)
            if lines:
                return lines, "matchedGps"

        gps = GeometryService.parse_geojson(trip_data.get("gps"))
        if isinstance(gps, dict):
            lines = _line_sequences_from_geometry(gps)
            if lines:
                return lines, "gps"

        return [], None

    @classmethod
    def _build_trip_stats(
        cls,
        line_sequences: list[list[list[float]]],
        *,
        resolution: int,
        spacing_m: float,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], float]:
        cell_acc: dict[str, dict[str, float]] = defaultdict(
            lambda: {"traversals": 0.0, "distance_m": 0.0},
        )
        segment_acc: dict[str, dict[str, Any]] = {}
        total_distance_m = 0.0

        for line_coords in line_sequences:
            sampled = _sample_line_points(line_coords, spacing_m)
            if len(sampled) < 2:
                continue

            sampled_cells: list[str] = []
            sampled_points: list[list[float]] = []
            for lon, lat in sampled:
                try:
                    cell = h3.latlng_to_cell(lat, lon, resolution)
                except Exception:
                    continue
                sampled_cells.append(str(cell))
                sampled_points.append([lon, lat])

            if len(sampled_cells) < 2:
                continue

            for idx in range(1, len(sampled_cells)):
                prev_cell = sampled_cells[idx - 1]
                curr_cell = sampled_cells[idx]
                prev_lon, prev_lat = sampled_points[idx - 1]
                curr_lon, curr_lat = sampled_points[idx]
                segment_distance_m = geodesic_distance_meters(
                    prev_lon,
                    prev_lat,
                    curr_lon,
                    curr_lat,
                )
                if segment_distance_m <= 0:
                    continue

                total_distance_m += segment_distance_m
                if prev_cell == curr_cell:
                    entry = cell_acc[curr_cell]
                    entry["traversals"] += 1.0
                    entry["distance_m"] += segment_distance_m
                    continue

                cell_acc[prev_cell]["traversals"] += 1.0
                cell_acc[curr_cell]["traversals"] += 1.0
                half_distance = segment_distance_m / 2.0
                cell_acc[prev_cell]["distance_m"] += half_distance
                cell_acc[curr_cell]["distance_m"] += half_distance

                key, cell_a, cell_b = _segment_key(prev_cell, curr_cell)
                segment_entry = segment_acc.get(key)
                if segment_entry is None:
                    segment_entry = {
                        "segment_key": key,
                        "h3_a": cell_a,
                        "h3_b": cell_b,
                        "traversals": 0.0,
                        "distance_m": 0.0,
                    }
                    segment_acc[key] = segment_entry
                segment_entry["traversals"] += 1.0
                segment_entry["distance_m"] += segment_distance_m

        cell_counts = [
            {
                "h3": cell,
                "traversals": int(values["traversals"]),
                "distance_miles": round(values["distance_m"] * METERS_TO_MILES, 4),
            }
            for cell, values in cell_acc.items()
            if values["traversals"] > 0
        ]
        segment_counts = [
            {
                "segment_key": values["segment_key"],
                "h3_a": values["h3_a"],
                "h3_b": values["h3_b"],
                "traversals": int(values["traversals"]),
                "distance_miles": round(values["distance_m"] * METERS_TO_MILES, 4),
            }
            for values in segment_acc.values()
            if values["traversals"] > 0
        ]

        cell_counts.sort(key=lambda item: (-item["traversals"], -item["distance_miles"]))
        segment_counts.sort(
            key=lambda item: (-item["traversals"], -item["distance_miles"]),
        )
        return cell_counts, segment_counts, total_distance_m * METERS_TO_MILES

    @classmethod
    async def _set_trip_synced(cls, trip_id: PydanticObjectId, synced_at: datetime) -> None:
        trip = await Trip.get(trip_id)
        if not trip:
            return
        trip.mobility_synced_at = synced_at
        await trip.save()

    @classmethod
    async def sync_trip(cls, trip: Trip) -> bool:
        """Compute and persist one trip's H3 traversal profile."""
        if trip.id is None:
            return False

        trip_data = trip.model_dump()
        lines, geometry_source = cls._select_trip_geometry(trip_data)
        synced_at = datetime.now(UTC)

        if not lines:
            await TripMobilityProfile.find({"trip_id": trip.id}).delete()
            await cls._set_trip_synced(trip.id, synced_at)
            return False

        cell_counts, segment_counts, total_distance_miles = cls._build_trip_stats(
            lines,
            resolution=H3_RESOLUTION,
            spacing_m=H3_SAMPLE_SPACING_M,
        )

        profile = await TripMobilityProfile.find_one({"trip_id": trip.id})
        if profile is None:
            profile = TripMobilityProfile(
                trip_id=trip.id,
                transaction_id=trip.transactionId,
                imei=trip.imei,
                start_time=trip.startTime,
                end_time=trip.endTime,
            )

        profile.transaction_id = trip.transactionId
        profile.imei = trip.imei
        profile.start_time = trip.startTime
        profile.end_time = trip.endTime
        profile.h3_resolution = H3_RESOLUTION
        profile.sample_spacing_m = H3_SAMPLE_SPACING_M
        profile.source_geometry = geometry_source or "gps"
        profile.total_distance_miles = round(total_distance_miles, 4)
        profile.cell_counts = cell_counts
        profile.segment_counts = segment_counts
        profile.updated_at = synced_at

        if profile.id is None:
            await profile.insert()
        else:
            await profile.save()

        await cls._set_trip_synced(trip.id, synced_at)
        return True

    @classmethod
    async def remove_trip(cls, trip_id: PydanticObjectId) -> None:
        """Delete mobility profile for a trip that has been removed."""
        await TripMobilityProfile.find({"trip_id": trip_id}).delete()

    @classmethod
    async def sync_unsynced_trips_for_query(
        cls,
        query: dict[str, Any],
        *,
        limit: int = MAX_SYNC_TRIPS_PER_REQUEST,
    ) -> tuple[int, int]:
        """Sync a bounded batch of unsynced trips matching the date/vehicle query."""
        base_query = _combine_query(
            query,
            {"invalid": {"$ne": True}},
            {"$or": [{"matchedGps": {"$ne": None}}, {"gps": {"$ne": None}}]},
        )
        unsynced_query = _combine_query(base_query, {"mobility_synced_at": None})

        pending_before = await Trip.find(unsynced_query).count()
        if pending_before <= 0:
            return 0, 0

        trips = await Trip.find(unsynced_query).sort([("startTime", 1)]).limit(limit).to_list()
        synced = 0
        for trip in trips:
            try:
                await cls.sync_trip(trip)
                synced += 1
            except Exception:
                logger.exception(
                    "Failed syncing mobility profile for trip %s",
                    trip.transactionId,
                )

        pending_after = max(0, pending_before - synced)
        return synced, pending_after

    @classmethod
    async def _street_name_for_cell(
        cls,
        cell_id: str,
        *,
        resolution: int,
    ) -> str | None:
        cached = await H3StreetLabelCache.find_one({"h3_cell": cell_id})
        if cached:
            cached.last_used_at = datetime.now(UTC)
            await cached.save()
            return cached.street_name

        try:
            lat, lon = h3.cell_to_latlng(cell_id)
        except Exception:
            return None

        street_name: str | None = None
        display_name: str | None = None
        try:
            response = await cls._geocoder.reverse_geocode(lat, lon)
            if isinstance(response, dict):
                address = response.get("address") or {}
                if isinstance(address, dict):
                    street_name = (
                        address.get("road")
                        or address.get("pedestrian")
                        or address.get("residential")
                        or address.get("footway")
                        or address.get("path")
                        or address.get("cycleway")
                    )
                display_name = response.get("display_name")
        except Exception:
            logger.debug("Street reverse geocode failed for H3 cell %s", cell_id)

        street_name = _normalize_street_name(street_name)
        display_name = _normalize_street_name(display_name)
        if street_name is None and display_name:
            # Use the first display-name token as a fallback label.
            street_name = _normalize_street_name(display_name.split(",")[0])

        cache_doc = H3StreetLabelCache(
            h3_cell=cell_id,
            resolution=resolution,
            street_name=street_name,
            normalized_street_name=(
                street_name.casefold() if isinstance(street_name, str) else None
            ),
            display_name=display_name,
            fetched_at=datetime.now(UTC),
            last_used_at=datetime.now(UTC),
        )
        with suppress(Exception):
            await cache_doc.insert()
        return street_name

    @classmethod
    async def _build_top_streets(
        cls,
        query: dict[str, Any],
        hex_cells: list[dict[str, Any]],
        *,
        resolution: int,
        street_limit: int = MAX_STREETS,
        street_names_by_cell: dict[str, str | None] | None = None,
        source_geometry: str | None = None,
    ) -> list[dict[str, Any]]:
        ranked_cells = hex_cells[:MAX_HEX_STREET_LOOKUPS]
        if not ranked_cells:
            return []

        semaphore = asyncio.Semaphore(8)

        async def resolve_street_name(cell_id: str) -> str | None:
            if street_names_by_cell is not None:
                resolved = _normalize_street_name(street_names_by_cell.get(cell_id))
                if resolved:
                    return resolved
            async with semaphore:
                street = await cls._street_name_for_cell(
                    cell_id,
                    resolution=resolution,
                )
                return _normalize_street_name(street)

        candidate_cells = [str(cell.get("hex") or "") for cell in ranked_cells if cell.get("hex")]
        if not candidate_cells:
            return []

        missing_labels = [
            cell_id
            for cell_id in candidate_cells
            if not _normalize_street_name((street_names_by_cell or {}).get(cell_id))
        ]
        if missing_labels:
            resolved_pairs = await asyncio.gather(
                *(resolve_street_name(cell_id) for cell_id in missing_labels),
            )
            if street_names_by_cell is None:
                street_names_by_cell = {}
            for idx, cell_id in enumerate(missing_labels):
                street_names_by_cell[cell_id] = resolved_pairs[idx]

        start_time = time.perf_counter()
        trip_query = _combine_query(query, {"invalid": {"$ne": True}})
        street_trip_pipeline = [
            {"$match": trip_query},
            {
                "$lookup": {
                    "from": "trip_mobility_profiles",
                    "localField": "_id",
                    "foreignField": "trip_id",
                    "as": "mobility",
                },
            },
            {"$unwind": "$mobility"},
            *(
                [{"$match": {"mobility.source_geometry": source_geometry}}]
                if source_geometry
                else []
            ),
            {"$unwind": "$mobility.cell_counts"},
            {"$match": {"mobility.cell_counts.h3": {"$in": candidate_cells}}},
            {
                "$group": {
                    "_id": {
                        "trip_id": "$_id",
                        "h3": "$mobility.cell_counts.h3",
                    },
                    "traversals": {"$sum": "$mobility.cell_counts.traversals"},
                    "distance_miles": {"$sum": "$mobility.cell_counts.distance_miles"},
                },
            },
        ]

        dedupe_rows = await aggregate_to_list(Trip, street_trip_pipeline)

        grouped: dict[str, dict[str, Any]] = {}
        for row in dedupe_rows:
            row_id = row.get("_id") or {}
            trip_id = row_id.get("trip_id")
            cell_id = str(row_id.get("h3") or "")
            if not trip_id or not cell_id:
                continue

            street_name = _normalize_street_name((street_names_by_cell or {}).get(cell_id))
            if not street_name:
                continue

            key = street_name.casefold()
            bucket = grouped.get(key)
            if bucket is None:
                bucket = {
                    "street_name": street_name,
                    "trip_ids": set(),
                    "cell_ids": set(),
                    "traversals": 0,
                    "distance_miles": 0.0,
                }
                grouped[key] = bucket

            bucket["trip_ids"].add(str(trip_id))
            bucket["cell_ids"].add(cell_id)
            bucket["traversals"] += int(row.get("traversals") or 0)
            bucket["distance_miles"] += float(row.get("distance_miles") or 0.0)

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        logger.debug(
            "Mobility street dedupe computed in %.1fms (candidate_cells=%d rows=%d streets=%d)",
            elapsed_ms,
            len(candidate_cells),
            len(dedupe_rows),
            len(grouped),
        )

        top_streets = sorted(
            (
                {
                    "street_name": bucket["street_name"],
                    "street_key": _normalize_street_key(bucket["street_name"]),
                    "trip_count": len(bucket["trip_ids"]),
                    "traversals": int(bucket["traversals"]),
                    "times_driven": int(bucket["traversals"]),
                    "distance_miles": round(float(bucket["distance_miles"]), 2),
                    "cells": len(bucket["cell_ids"]),
                }
                for bucket in grouped.values()
            ),
            key=lambda row: (
                -int(row["traversals"]),
                -float(row["distance_miles"]),
                -int(row["trip_count"]),
            ),
        )[:street_limit]
        return top_streets

    @classmethod
    async def _build_top_streets_fallback(
        cls,
        hex_cells: list[dict[str, Any]],
        *,
        resolution: int,
        street_limit: int = MAX_STREETS,
        street_names_by_cell: dict[str, str | None] | None = None,
    ) -> list[dict[str, Any]]:
        ranked_cells = hex_cells[:MAX_HEX_STREET_LOOKUPS]
        if not ranked_cells:
            return []

        semaphore = asyncio.Semaphore(8)

        async def resolve(cell: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
            cell_id = str(cell.get("hex") or "")
            if street_names_by_cell is not None:
                resolved = _normalize_street_name(street_names_by_cell.get(cell_id))
                if resolved:
                    return resolved, cell

            async with semaphore:
                street = await cls._street_name_for_cell(
                    cell_id,
                    resolution=resolution,
                )
                return _normalize_street_name(street), cell

        grouped: dict[str, dict[str, Any]] = {}
        for street, cell in await asyncio.gather(*(resolve(cell) for cell in ranked_cells)):
            normalized = _normalize_street_name(street)
            if not normalized:
                continue
            key = normalized.casefold()
            bucket = grouped.get(key)
            if bucket is None:
                bucket = {
                    "street_name": normalized,
                    "traversals": 0,
                    "distance_miles": 0.0,
                    "cells": 0,
                    "trip_count": None,
                }
                grouped[key] = bucket
            bucket["traversals"] += int(cell.get("traversals") or 0)
            bucket["distance_miles"] += float(cell.get("distance_miles") or 0.0)
            bucket["cells"] += 1

        top_streets = sorted(
            grouped.values(),
            key=lambda row: (-int(row["traversals"]), -float(row["distance_miles"])),
        )[:street_limit]
        for row in top_streets:
            row["street_key"] = _normalize_street_key(row.get("street_name"))
            row["times_driven"] = int(row.get("traversals") or 0)
            row["distance_miles"] = round(float(row["distance_miles"]), 2)
        return top_streets

    @classmethod
    async def _resolve_street_names_for_cells(
        cls,
        cells: list[str],
        *,
        resolution: int,
    ) -> dict[str, str | None]:
        ordered_unique: list[str] = []
        seen: set[str] = set()
        for raw in cells:
            cell_id = str(raw or "").strip()
            if not cell_id or cell_id in seen:
                continue
            seen.add(cell_id)
            ordered_unique.append(cell_id)

        if not ordered_unique:
            return {}

        semaphore = asyncio.Semaphore(8)

        async def resolve(cell_id: str) -> tuple[str, str | None]:
            async with semaphore:
                street = await cls._street_name_for_cell(
                    cell_id,
                    resolution=resolution,
                )
                return cell_id, _normalize_street_name(street)

        resolved_pairs = await asyncio.gather(*(resolve(cell_id) for cell_id in ordered_unique))
        return dict(resolved_pairs)

    @classmethod
    async def _build_entity_paths(
        cls,
        query: dict[str, Any],
        *,
        street_cell_ids_by_key: dict[str, set[str]],
        segment_keys: set[str],
        resolution: int,
        spacing_m: float,
    ) -> tuple[
        dict[str, list[list[list[float]]]],
        dict[str, list[list[list[float]]]],
        list[str],
    ]:
        warnings: list[str] = []
        target_street_keys = {
            key for key, cells in street_cell_ids_by_key.items() if key and cells
        }
        target_segment_keys = {key for key in segment_keys if key}
        if not target_street_keys and not target_segment_keys:
            return {}, {}, warnings

        trip_query = _combine_query(
            query,
            {"invalid": {"$ne": True}},
            {"matchedGps": {"$ne": None}},
        )
        candidate_count = await Trip.find(trip_query).count()
        if candidate_count > MAX_PATH_TRIPS_FOR_RENDER:
            warnings.append(
                (
                    "Movement geometry used the most recent "
                    f"{MAX_PATH_TRIPS_FOR_RENDER:,} matched trips out of "
                    f"{candidate_count:,} in range."
                ),
            )

        trips = (
            await Trip.find(trip_query)
            .sort([("startTime", -1)])
            .limit(MAX_PATH_TRIPS_FOR_RENDER)
            .to_list()
        )
        if not trips:
            return {}, {}, warnings

        street_key_by_cell: dict[str, str] = {}
        for street_key, cells in street_cell_ids_by_key.items():
            for cell_id in cells:
                if cell_id and cell_id not in street_key_by_cell:
                    street_key_by_cell[cell_id] = street_key

        street_paths: dict[str, list[list[list[float]]]] = {}
        segment_paths: dict[str, list[list[list[float]]]] = {}

        for trip in trips:
            trip_data = trip.model_dump()
            matched = GeometryService.parse_geojson(trip_data.get("matchedGps"))
            if not isinstance(matched, dict):
                continue
            line_sequences = _line_sequences_from_geometry(matched)
            for line_coords in line_sequences:
                sampled_points_raw = _sample_line_points(line_coords, spacing_m)
                if len(sampled_points_raw) < 2:
                    continue

                sampled_points: list[list[float]] = []
                sampled_cells: list[str] = []
                for point in sampled_points_raw:
                    is_valid, pair = GeometryService.validate_coordinate_pair(point)
                    if not is_valid or pair is None:
                        continue
                    lon, lat = pair
                    try:
                        cell = h3.latlng_to_cell(lat, lon, resolution)
                    except Exception:
                        continue
                    sampled_points.append(pair)
                    sampled_cells.append(str(cell))

                if len(sampled_points) < 2 or len(sampled_cells) < 2:
                    continue

                for idx in range(1, len(sampled_cells)):
                    prev_cell = sampled_cells[idx - 1]
                    curr_cell = sampled_cells[idx]
                    prev_point = sampled_points[idx - 1]
                    curr_point = sampled_points[idx]

                    prev_street_key = street_key_by_cell.get(prev_cell, "")
                    curr_street_key = street_key_by_cell.get(curr_cell, "")
                    if prev_street_key in target_street_keys:
                        _append_path_segment(
                            street_paths,
                            prev_street_key,
                            [prev_point, curr_point],
                        )
                    if (
                        curr_street_key in target_street_keys
                        and curr_street_key != prev_street_key
                    ):
                        _append_path_segment(
                            street_paths,
                            curr_street_key,
                            [prev_point, curr_point],
                        )

                    if prev_cell == curr_cell:
                        continue
                    segment_key, _, _ = _segment_key(prev_cell, curr_cell)
                    if segment_key in target_segment_keys:
                        _append_path_segment(
                            segment_paths,
                            segment_key,
                            [prev_point, curr_point],
                        )

        return street_paths, segment_paths, warnings

    @classmethod
    def _build_map_center_from_paths(
        cls,
        top_streets: list[dict[str, Any]],
        top_segments: list[dict[str, Any]],
        fallback_hex_cells: list[dict[str, Any]],
    ) -> dict[str, float] | None:
        weighted_lon = 0.0
        weighted_lat = 0.0
        total_weight = 0.0

        for item in [*top_streets, *top_segments]:
            weight = max(1.0, float(item.get("times_driven") or item.get("traversals") or 0))
            paths = item.get("paths")
            if not isinstance(paths, list):
                continue
            for path in paths:
                if not isinstance(path, list):
                    continue
                for point in path:
                    is_valid, pair = GeometryService.validate_coordinate_pair(point)
                    if not is_valid or pair is None:
                        continue
                    weighted_lon += pair[0] * weight
                    weighted_lat += pair[1] * weight
                    total_weight += weight

        if total_weight > 0:
            return {
                "lon": round(weighted_lon / total_weight, 6),
                "lat": round(weighted_lat / total_weight, 6),
                "zoom": 11.5,
            }
        return cls._build_map_center(fallback_hex_cells)

    @classmethod
    def _collect_duplicate_values(cls, values: list[str]) -> list[str]:
        duplicates: set[str] = set()
        seen: set[str] = set()
        for raw in values:
            value = str(raw or "").strip()
            if not value:
                continue
            if value in seen:
                duplicates.add(value)
            seen.add(value)
        return sorted(duplicates)

    @classmethod
    def _segment_label(
        cls,
        street_a: str | None,
        street_b: str | None,
    ) -> str:
        left = _normalize_street_name(street_a)
        right = _normalize_street_name(street_b)
        if left and right:
            if left.casefold() == right.casefold():
                return left
            return f"{left} ↔ {right}"
        if left:
            return left
        if right:
            return right
        return "Most driven segment"

    @classmethod
    def _build_map_center(cls, hex_cells: list[dict[str, Any]]) -> dict[str, float] | None:
        if not hex_cells:
            return None
        weighted_lon = 0.0
        weighted_lat = 0.0
        total_weight = 0.0
        for cell in hex_cells:
            try:
                lat, lon = h3.cell_to_latlng(str(cell.get("hex")))
            except Exception:
                continue
            weight = max(1.0, float(cell.get("traversals") or 0.0))
            weighted_lon += lon * weight
            weighted_lat += lat * weight
            total_weight += weight
        if total_weight <= 0:
            return None
        return {
            "lon": round(weighted_lon / total_weight, 6),
            "lat": round(weighted_lat / total_weight, 6),
            "zoom": 11.0,
        }

    @classmethod
    async def get_mobility_insights(
        cls,
        query: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Aggregate H3 mobility insights for the current query window.

        This syncs a bounded number of unsynced trips automatically so
        Insights reflects recent imports without manual backfill.
        """
        sync_query = _combine_query(query, {"matchedGps": {"$ne": None}})
        synced_count, pending_unsynced = await cls.sync_unsynced_trips_for_query(sync_query)
        trip_query = _combine_query(
            query,
            {"invalid": {"$ne": True}},
            {"matchedGps": {"$ne": None}},
        )

        count_pipeline = [
            {"$match": trip_query},
            {
                "$lookup": {
                    "from": "trip_mobility_profiles",
                    "localField": "_id",
                    "foreignField": "trip_id",
                    "as": "mobility",
                },
            },
            {
                "$addFields": {
                    "matched_mobility": {
                        "$filter": {
                            "input": "$mobility",
                            "as": "profile",
                            "cond": {
                                "$eq": [
                                    "$$profile.source_geometry",
                                    "matchedGps",
                                ],
                            },
                        },
                    },
                },
            },
            {
                "$group": {
                    "_id": None,
                    "trip_count": {"$sum": 1},
                    "profiled_trip_count": {
                        "$sum": {
                            "$cond": [
                                {"$gt": [{"$size": "$matched_mobility"}, 0]},
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
        ]
        count_result = await aggregate_to_list(Trip, count_pipeline)
        summary = count_result[0] if count_result else {}

        hex_pipeline = [
            {"$match": trip_query},
            {
                "$lookup": {
                    "from": "trip_mobility_profiles",
                    "localField": "_id",
                    "foreignField": "trip_id",
                    "as": "mobility",
                },
            },
            {"$unwind": "$mobility"},
            {"$match": {"mobility.source_geometry": "matchedGps"}},
            {"$unwind": "$mobility.cell_counts"},
            {
                "$group": {
                    "_id": "$mobility.cell_counts.h3",
                    "trip_count": {"$sum": 1},
                    "traversals": {"$sum": "$mobility.cell_counts.traversals"},
                    "distance_miles": {"$sum": "$mobility.cell_counts.distance_miles"},
                },
            },
            {"$sort": {"traversals": -1, "distance_miles": -1}},
            {"$limit": MAX_HEX_CELLS},
        ]
        hex_results = await aggregate_to_list(Trip, hex_pipeline)

        segment_pipeline = [
            {"$match": trip_query},
            {
                "$lookup": {
                    "from": "trip_mobility_profiles",
                    "localField": "_id",
                    "foreignField": "trip_id",
                    "as": "mobility",
                },
            },
            {"$unwind": "$mobility"},
            {"$match": {"mobility.source_geometry": "matchedGps"}},
            {"$unwind": "$mobility.segment_counts"},
            {
                "$group": {
                    "_id": "$mobility.segment_counts.segment_key",
                    "h3_a": {"$first": "$mobility.segment_counts.h3_a"},
                    "h3_b": {"$first": "$mobility.segment_counts.h3_b"},
                    "trip_count": {"$sum": 1},
                    "traversals": {"$sum": "$mobility.segment_counts.traversals"},
                    "distance_miles": {"$sum": "$mobility.segment_counts.distance_miles"},
                },
            },
            {"$sort": {"traversals": -1, "distance_miles": -1}},
            {"$limit": MAX_SEGMENTS},
        ]
        segment_results = await aggregate_to_list(Trip, segment_pipeline)

        hex_cells = [
            {
                "hex": str(item.get("_id")),
                "trip_count": int(item.get("trip_count") or 0),
                "traversals": int(item.get("traversals") or 0),
                "times_driven": int(item.get("traversals") or 0),
                "distance_miles": round(float(item.get("distance_miles") or 0.0), 2),
            }
            for item in hex_results
            if item.get("_id")
        ]

        street_names_by_cell = await cls._resolve_street_names_for_cells(
            [str(cell.get("hex") or "") for cell in hex_cells[:MAX_HEX_STREET_LOOKUPS]],
            resolution=H3_RESOLUTION,
        )
        segment_label_lookup_cells: list[str] = []
        for item in segment_results[:MAX_SEGMENT_LABEL_LOOKUPS]:
            h3_a = str(item.get("h3_a") or "")
            h3_b = str(item.get("h3_b") or "")
            if h3_a and h3_a not in street_names_by_cell:
                segment_label_lookup_cells.append(h3_a)
            if h3_b and h3_b not in street_names_by_cell:
                segment_label_lookup_cells.append(h3_b)
        if segment_label_lookup_cells:
            street_names_by_cell.update(
                await cls._resolve_street_names_for_cells(
                    segment_label_lookup_cells,
                    resolution=H3_RESOLUTION,
                ),
            )

        for cell in hex_cells:
            street_name = _normalize_street_name(
                street_names_by_cell.get(str(cell.get("hex") or "")),
            )
            if street_name:
                cell["street_name"] = street_name
                cell["street_key"] = _normalize_street_key(street_name)

        top_segments: list[dict[str, Any]] = []
        for item in segment_results:
            h3_a = str(item.get("h3_a") or "")
            h3_b = str(item.get("h3_b") or "")
            if not h3_a or not h3_b:
                continue
            street_a = _normalize_street_name(street_names_by_cell.get(h3_a))
            street_b = _normalize_street_name(street_names_by_cell.get(h3_b))
            top_segments.append(
                {
                    "segment_key": str(item.get("_id") or ""),
                    "h3_a": h3_a,
                    "h3_b": h3_b,
                    "label": cls._segment_label(street_a, street_b),
                    "street_a": street_a,
                    "street_b": street_b,
                    "trip_count": int(item.get("trip_count") or 0),
                    "traversals": int(item.get("traversals") or 0),
                    "times_driven": int(item.get("traversals") or 0),
                    "distance_miles": round(float(item.get("distance_miles") or 0.0), 2),
                    "paths": [],
                },
            )

        try:
            top_streets = await cls._build_top_streets(
                query,
                hex_cells,
                resolution=H3_RESOLUTION,
                street_limit=MAX_STREETS,
                street_names_by_cell=street_names_by_cell,
                source_geometry="matchedGps",
            )
        except Exception:
            logger.exception("Mobility street trip-dedupe aggregation failed")
            top_streets = await cls._build_top_streets_fallback(
                hex_cells,
                resolution=H3_RESOLUTION,
                street_limit=MAX_STREETS,
                street_names_by_cell=street_names_by_cell,
            )

        street_cells_by_key: dict[str, set[str]] = defaultdict(set)
        for cell in hex_cells:
            street_key = str(cell.get("street_key") or "")
            cell_id = str(cell.get("hex") or "")
            if street_key and cell_id:
                street_cells_by_key[street_key].add(cell_id)

        segment_keys = {
            str(item.get("segment_key") or "")
            for item in top_segments
            if item.get("segment_key")
        }
        street_paths_by_key, segment_paths_by_key, path_warnings = (
            await cls._build_entity_paths(
                query,
                street_cell_ids_by_key=street_cells_by_key,
                segment_keys=segment_keys,
                resolution=H3_RESOLUTION,
                spacing_m=H3_SAMPLE_SPACING_M,
            )
        )

        ranked_street_count = len(top_streets)
        ranked_segment_count = len(top_segments)
        validation_warnings = list(path_warnings)
        validation_errors: list[str] = []

        duplicate_street_keys = cls._collect_duplicate_values(
            [str(item.get("street_key") or "") for item in top_streets],
        )
        if duplicate_street_keys:
            validation_errors.append(
                "Duplicate street identifiers in ranking payload: "
                + ", ".join(duplicate_street_keys[:5]),
            )

        duplicate_segment_keys = cls._collect_duplicate_values(
            [str(item.get("segment_key") or "") for item in top_segments],
        )
        if duplicate_segment_keys:
            validation_errors.append(
                "Duplicate segment identifiers in ranking payload: "
                + ", ".join(duplicate_segment_keys[:5]),
            )

        renderable_top_streets: list[dict[str, Any]] = []
        for street in top_streets:
            street_key = str(street.get("street_key") or "")
            street["times_driven"] = int(street.get("traversals") or 0)
            street["paths"] = street_paths_by_key.get(street_key, [])
            if _entity_has_paths(street):
                renderable_top_streets.append(street)
            else:
                validation_warnings.append(
                    (
                        "Dropped ranked street from map because no matched "
                        f"polyline segments were available: {street.get('street_name')}"
                    ),
                )

        renderable_top_segments: list[dict[str, Any]] = []
        for segment in top_segments:
            segment_key = str(segment.get("segment_key") or "")
            segment["times_driven"] = int(segment.get("traversals") or 0)
            segment["paths"] = segment_paths_by_key.get(segment_key, [])
            if _entity_has_paths(segment):
                renderable_top_segments.append(segment)
            else:
                validation_warnings.append(
                    (
                        "Dropped ranked segment from map because no matched "
                        f"polyline segments were available: {segment_key}"
                    ),
                )

        analyzed_trip_count = int(summary.get("profiled_trip_count") or 0)

        return {
            "h3_resolution": H3_RESOLUTION,
            "sample_spacing_m": H3_SAMPLE_SPACING_M,
            "trip_count": int(summary.get("trip_count") or 0),
            "profiled_trip_count": int(summary.get("profiled_trip_count") or 0),
            "analyzed_trip_count": analyzed_trip_count,
            "analysis_scope": {
                "geometry_source": "matchedGps",
                "street_ranking": "times_driven",
                "segment_ranking": "times_driven",
            },
            "synced_trips_this_request": synced_count,
            "pending_trip_sync_count": pending_unsynced,
            "metric_basis": {
                "top_streets_primary": "times_driven",
                "top_segments_primary": "times_driven",
                "map_cells_intensity": "times_driven",
            },
            "hex_cells": hex_cells,
            "top_segments": renderable_top_segments,
            "top_streets": renderable_top_streets,
            "validation": {
                "warnings": validation_warnings,
                "errors": validation_errors,
                "consistency": {
                    "ranked_street_count": ranked_street_count,
                    "map_renderable_street_count": len(renderable_top_streets),
                    "dropped_street_count": max(
                        0,
                        ranked_street_count - len(renderable_top_streets),
                    ),
                    "ranked_segment_count": ranked_segment_count,
                    "map_renderable_segment_count": len(renderable_top_segments),
                    "dropped_segment_count": max(
                        0,
                        ranked_segment_count - len(renderable_top_segments),
                    ),
                },
            },
            "map_center": cls._build_map_center_from_paths(
                renderable_top_streets,
                renderable_top_segments,
                hex_cells,
            ),
        }
