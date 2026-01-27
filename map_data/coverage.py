"""
Trip coverage extraction for local/offline geocoding.

Builds a buffered coverage polygon from trip GPS geometries and uses osmium
to extract a smaller OSM PBF for Nominatim/Valhalla imports.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from pyproj import Transformer
from shapely.geometry import LineString, Point, mapping
from shapely.ops import transform, unary_union

from config import get_osm_extracts_path

logger = logging.getLogger(__name__)


@dataclass
class CoverageStats:
    trips_seen: int = 0
    geometries_used: int = 0
    points_used: int = 0


def _get_env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _get_env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _coverage_buffer_meters() -> float:
    miles = os.getenv("MAP_COVERAGE_BUFFER_MILES", "").strip()
    if miles:
        try:
            return float(miles) * 1609.344
        except ValueError:
            pass
    meters = os.getenv("MAP_COVERAGE_BUFFER_METERS", "").strip()
    if meters:
        try:
            return float(meters)
        except ValueError:
            pass
    return 16093.44  # 10 miles default


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


async def build_trip_coverage_polygon() -> tuple[Any | None, CoverageStats]:
    from db.models import Trip

    stats = CoverageStats()
    buffer_meters = _coverage_buffer_meters()
    max_points = _get_env_int("MAP_COVERAGE_MAX_POINTS_PER_TRIP", 2000)
    batch_size = _get_env_int("MAP_COVERAGE_BATCH_SIZE", 200)
    simplify_meters = _get_env_float("MAP_COVERAGE_SIMPLIFY_METERS", 50.0)

    to_3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    to_4326 = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)

    def project(x: float, y: float, z: float | None = None) -> tuple[float, float]:
        return to_3857.transform(x, y)

    def unproject(x: float, y: float, z: float | None = None) -> tuple[float, float]:
        return to_4326.transform(x, y)

    batch: list[Any] = []
    combined: Any | None = None

    collection = Trip.get_pymongo_collection()
    cursor = collection.find(
        {"gps": {"$exists": True, "$ne": None}},
        {"gps": 1, "_id": 0},
    )

    async for doc in cursor:
        stats.trips_seen += 1
        geom, points = _build_trip_geometry(doc.get("gps"), max_points)
        if geom is None:
            continue
        try:
            projected = transform(project, geom)
        except Exception:
            continue
        stats.geometries_used += 1
        stats.points_used += points
        batch.append(projected)
        if len(batch) >= batch_size:
            combined = _merge_batch(combined, batch)
            batch = []

    combined = _merge_batch(combined, batch)
    if combined is None:
        logger.warning("No trip geometries available for coverage polygon.")
        return None, stats

    buffered = combined.buffer(buffer_meters)
    if simplify_meters > 0:
        buffered = buffered.simplify(simplify_meters)
    coverage = transform(unproject, buffered)
    return coverage, stats


def write_coverage_geojson(geometry: Any, output_path: str) -> None:
    feature = {"type": "Feature", "properties": {}, "geometry": mapping(geometry)}
    data = {"type": "FeatureCollection", "features": [feature]}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle)


async def build_trip_coverage_extract(
    source_pbf: str,
    *,
    coverage_dir: str | None = None,
) -> str | None:
    coverage, stats = await build_trip_coverage_polygon()
    if coverage is None:
        return None

    extracts_path = get_osm_extracts_path()
    coverage_dir = coverage_dir or os.path.join(extracts_path, "coverage")
    os.makedirs(coverage_dir, exist_ok=True)
    polygon_path = os.path.join(coverage_dir, "coverage.geojson")
    output_pbf = os.path.join(coverage_dir, "coverage.osm.pbf")

    write_coverage_geojson(coverage, polygon_path)

    logger.info(
        "Coverage polygon built: trips=%d geometries=%d points=%d",
        stats.trips_seen,
        stats.geometries_used,
        stats.points_used,
    )
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

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        error_msg = stderr.decode().strip() if stderr else "osmium extract failed"
        logger.warning("Coverage extract failed: %s", error_msg)
        return None
    if stdout:
        logger.info("osmium extract: %s", stdout.decode().strip())
    return output_pbf
