"""
Trip coverage extraction for local/offline geocoding.

Builds a buffered coverage polygon from trip GPS geometries and uses
osmium to extract a smaller OSM PBF for Nominatim/Valhalla imports. All
configuration uses imperial units (miles/feet).
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from pyproj import Transformer
from shapely.geometry import LineString, Point, mapping
from shapely.ops import transform, unary_union

from config import get_osm_extracts_path

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)


@dataclass
class CoverageStats:
    trips_seen: int = 0
    geometries_used: int = 0
    points_used: int = 0


_FEET_PER_MILE = 5280.0
_PROJECTED_UNITS_PER_FOOT = 0.3048


def _build_trip_geometry(
    gps: dict[str, Any],
    max_points: int,
) -> tuple[Any | None, int]:
    if not gps or "coordinates" not in gps:
        return None, 0
    geom_type = gps.get("type")
    coords = gps.get("coordinates") or []

    if geom_type == "Point" and len(coords) >= 2:
        return Point(coords[0], coords[1]), 1

    if geom_type == "LineString" and len(coords) >= 2:
        if len(coords) > max_points:
            step = max(1, len(coords) // max_points)
            coords = coords[::step]
            if coords[-1] != gps.get("coordinates", [])[-1]:
                coords.append(gps["coordinates"][-1])
        return LineString(coords), len(coords)

    return None, 0


def _merge_batch(
    combined: Any | None,
    batch: list[Any],
) -> Any | None:
    if not batch:
        return combined
    try:
        batch_union = unary_union(batch)
    except Exception:
        batch_union = batch[0]
        for geom in batch[1:]:
            batch_union = batch_union.union(geom)
    if combined is None:
        return batch_union
    try:
        return unary_union([combined, batch_union])
    except Exception:
        return combined.union(batch_union)


async def build_trip_coverage_polygon(
    *,
    buffer_miles: float,
    simplify_feet: float,
    max_points_per_trip: int,
    batch_size: int,
    progress_callback: Callable[[CoverageStats], Any] | None = None,
    progress_every: int = 500,
    progress_interval: float = 2.0,
) -> tuple[Any | None, CoverageStats]:
    from db.models import Trip

    stats = CoverageStats()
    buffer_miles = max(buffer_miles, 0.0)
    simplify_feet = max(simplify_feet, 0.0)
    max_points_per_trip = max(int(max_points_per_trip), 1)
    batch_size = max(int(batch_size), 1)
    progress_every = max(int(progress_every), 1)
    progress_interval = max(float(progress_interval), 0.1)
    buffer_units = buffer_miles * _FEET_PER_MILE * _PROJECTED_UNITS_PER_FOOT
    simplify_units = simplify_feet * _PROJECTED_UNITS_PER_FOOT

    to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    to_4326 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

    def project(x: float, y: float, _z: float | None = None) -> tuple[float, float]:
        return to_3857.transform(x, y)

    def unproject(x: float, y: float, _z: float | None = None) -> tuple[float, float]:
        return to_4326.transform(x, y)

    batch: list[Any] = []
    combined: Any | None = None
    last_progress = time.monotonic()

    if progress_callback:
        await progress_callback(stats)

    collection = Trip.get_pymongo_collection()
    cursor = collection.find(
        {"gps": {"$exists": True, "$ne": None}},
        {"gps": 1, "_id": 0},
    )

    async for doc in cursor:
        stats.trips_seen += 1
        geom, points = _build_trip_geometry(doc.get("gps"), max_points_per_trip)
        if geom is None:
            if progress_callback and stats.trips_seen % progress_every == 0:
                await progress_callback(stats)
            continue
        try:
            projected = transform(project, geom)
        except Exception:
            if progress_callback and stats.trips_seen % progress_every == 0:
                await progress_callback(stats)
            continue
        stats.geometries_used += 1
        stats.points_used += points
        batch.append(projected)
        if len(batch) >= batch_size:
            combined = _merge_batch(combined, batch)
            batch = []

        if progress_callback:
            now = time.monotonic()
            if stats.trips_seen % progress_every == 0 or (
                now - last_progress >= progress_interval
            ):
                last_progress = now
                await progress_callback(stats)

    combined = _merge_batch(combined, batch)
    if combined is None:
        logger.warning("No trip geometries available for coverage polygon.")
        return None, stats

    if progress_callback:
        await progress_callback(stats)

    buffered = combined.buffer(buffer_units)
    if simplify_units > 0:
        buffered = buffered.simplify(simplify_units)
    coverage = transform(unproject, buffered)
    return coverage, stats


def write_coverage_geojson(geometry: Any, output_path: str) -> None:
    feature = {"type": "Feature", "properties": {}, "geometry": mapping(geometry)}
    data = {"type": "FeatureCollection", "features": [feature]}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)


async def build_trip_coverage_extract_from_geometry(
    source_pbf: str,
    geometry: Any,
    *,
    coverage_dir: str | None = None,
    heartbeat_callback: Callable[[], Any] | None = None,
    heartbeat_interval: float = 15.0,
    timeout_seconds: int | None = None,
) -> str | None:
    extracts_path = get_osm_extracts_path()
    coverage_dir = coverage_dir or os.path.join(extracts_path, "coverage")
    os.makedirs(coverage_dir, exist_ok=True)
    polygon_path = os.path.join(coverage_dir, "coverage.geojson")
    output_pbf = os.path.join(coverage_dir, "coverage.osm.pbf")

    write_coverage_geojson(geometry, polygon_path)

    logger.info("Extracting coverage PBF from %s", source_pbf)

    cmd = [
        "osmium",
        "extract",
        "-p",
        polygon_path,
        "-o",
        output_pbf,
        "--overwrite",
        source_pbf,
    ]

    import asyncio

    if timeout_seconds is not None and timeout_seconds <= 0:
        timeout_seconds = None
    heartbeat_interval = max(float(heartbeat_interval), 1.0)

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    start_time = time.monotonic()
    communicate_task = asyncio.create_task(process.communicate())
    stdout = b""
    stderr = b""

    while True:
        done, _ = await asyncio.wait(
            {communicate_task},
            timeout=heartbeat_interval,
        )
        if done:
            stdout, stderr = await communicate_task
            break

        if heartbeat_callback:
            with contextlib.suppress(Exception):
                await heartbeat_callback()

        if timeout_seconds is not None:
            elapsed = time.monotonic() - start_time
            if elapsed >= timeout_seconds:
                logger.warning(
                    "Coverage extract timed out after %.0f seconds",
                    timeout_seconds,
                )
                with contextlib.suppress(Exception):
                    process.kill()
                with contextlib.suppress(Exception):
                    await process.wait()
                with contextlib.suppress(Exception):
                    communicate_task.cancel()
                    await communicate_task
                return None

    if process.returncode != 0:
        error_msg = stderr.decode().strip() if stderr else "osmium extract failed"
        logger.warning("Coverage extract failed: %s", error_msg)
        return None
    if stdout:
        logger.info("osmium extract: %s", stdout.decode().strip())
    if not os.path.exists(output_pbf) or os.path.getsize(output_pbf) == 0:
        logger.warning("Coverage extract output missing or empty.")
        return None
    return output_pbf


async def build_trip_coverage_extract(
    source_pbf: str,
    *,
    buffer_miles: float,
    simplify_feet: float,
    max_points_per_trip: int,
    batch_size: int,
    coverage_dir: str | None = None,
    progress_callback: Callable[[CoverageStats], Any] | None = None,
    polygon_timeout_seconds: int | None = None,
    extract_timeout_seconds: int | None = None,
    extract_heartbeat: Callable[[], Any] | None = None,
    extract_heartbeat_interval: float = 15.0,
) -> str | None:
    from db.models import Trip

    collection = Trip.get_pymongo_collection()
    has_trip = await collection.find_one(
        {"gps": {"$exists": True, "$ne": None}},
        {"_id": 1},
    )
    if not has_trip:
        logger.info("No trips found yet; skipping coverage extract.")
        return None

    import asyncio

    async def _build_polygon() -> tuple[Any | None, CoverageStats]:
        return await build_trip_coverage_polygon(
            buffer_miles=buffer_miles,
            simplify_feet=simplify_feet,
            max_points_per_trip=max_points_per_trip,
            batch_size=batch_size,
            progress_callback=progress_callback,
        )

    if polygon_timeout_seconds is not None and polygon_timeout_seconds > 0:
        try:
            coverage, stats = await asyncio.wait_for(
                _build_polygon(),
                timeout=polygon_timeout_seconds,
            )
        except TimeoutError:
            logger.warning(
                "Coverage polygon build timed out after %s seconds",
                polygon_timeout_seconds,
            )
            return None
    else:
        coverage, stats = await _build_polygon()
    if coverage is None:
        return None

    extracts_path = get_osm_extracts_path()
    coverage_dir = coverage_dir or os.path.join(extracts_path, "coverage")
    os.makedirs(coverage_dir, exist_ok=True)

    logger.info(
        "Coverage polygon built: trips=%d geometries=%d points=%d",
        stats.trips_seen,
        stats.geometries_used,
        stats.points_used,
    )
    return await build_trip_coverage_extract_from_geometry(
        source_pbf,
        coverage,
        coverage_dir=coverage_dir,
        heartbeat_callback=extract_heartbeat,
        heartbeat_interval=extract_heartbeat_interval,
        timeout_seconds=extract_timeout_seconds,
    )
