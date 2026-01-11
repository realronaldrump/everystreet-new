"""Street segment preprocessing for coverage calculations."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import UTC, datetime
from typing import Any

import geopandas as gpd
import osmnx as ox
from bson import ObjectId
from shapely.geometry import LineString, MultiLineString, MultiPoint, mapping
from shapely.ops import split

from coverage.location_settings import (
    DEFAULT_SEGMENT_LENGTH_FEET,
    FEET_TO_METERS,
    normalize_location_settings,
)
from db.models import CoverageMetadata, ProgressStatus, Street
from preprocess_streets import GRAPH_STORAGE_DIR, preprocess_streets

logger = logging.getLogger(__name__)

BATCH_SIZE = 1000
MIN_SEGMENT_LENGTH_M = 0.5


def _clean_tag_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, list | tuple | set):
        for item in value:
            if item is None:
                continue
            if isinstance(item, float) and math.isnan(item):
                continue
            return str(item)
        return None
    return str(value)


def _normalize_osmid(value: Any) -> int | str | None:
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, list | tuple | set):
        for item in value:
            if item is None:
                continue
            if isinstance(item, float) and math.isnan(item):
                continue
            value = item
            break
        else:
            return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def _split_line_by_length(line: LineString, max_length: float) -> list[LineString]:
    if max_length <= 0 or line.length <= max_length:
        return [line]

    split_points = []
    dist = max_length
    while dist < line.length:
        split_points.append(line.interpolate(dist))
        dist += max_length

    if not split_points:
        return [line]

    try:
        segments = split(line, MultiPoint(split_points))
    except Exception:
        return [line]

    return [seg for seg in segments.geoms if seg.length > 0]


def _iter_lines(geometry: LineString | MultiLineString) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return [line for line in geometry.geoms if isinstance(line, LineString)]
    return []


async def _update_progress(
    task_id: str | None,
    progress: float,
    message: str,
    metrics: dict[str, Any] | None = None,
) -> None:
    if not task_id:
        return

    update_data = {
        "stage": "indexing",
        "progress": round(progress, 2),
        "message": message,
        "updated_at": datetime.now(UTC),
    }
    if metrics is not None:
        update_data["metrics"] = metrics

    # Upsert ProgressStatus
    # Beanie doesn't have a direct "upsert dict" helper, but we can check existene or use update with upsert=True if finding by ID
    # Since we need to match by _id being task_id.

    # We can use find_one(id).upsert(Set(data), on_insert=Doc(id=id, **data))
    # Or just use the model.

    status_doc = await ProgressStatus.get(task_id)
    if status_doc:
        await status_doc.set(update_data)
    else:
        # Create new
        status_doc = ProgressStatus(id=task_id, **update_data)
        await status_doc.insert()


async def build_street_segments(
    location: dict[str, Any],
    task_id: str | None = None,
    graph: object | None = None,
) -> dict[str, Any]:
    """Generate street segments for a location and store them in MongoDB."""
    if not isinstance(location, dict):
        raise ValueError("Location must be a dictionary")

    location = normalize_location_settings(location)
    location_name = location.get("display_name")
    if not location_name:
        raise ValueError("Missing display_name for location")

    location_id = location.get("_id")
    if isinstance(location_id, ObjectId):
        location_id = str(location_id)

    if not location_id:
        raise ValueError("Missing location ID for street preprocessing")

    segment_length_m = location.get("segment_length_meters")
    if not segment_length_m:
        segment_length_m = DEFAULT_SEGMENT_LENGTH_FEET * FEET_TO_METERS

    if graph is None:
        graph_path = GRAPH_STORAGE_DIR / f"{location_id}.graphml"
        if graph_path.exists():
            graph = await asyncio.to_thread(ox.load_graphml, graph_path)
        else:
            graph, _ = await preprocess_streets(location, task_id)

    await _update_progress(
        task_id,
        12,
        f"Preparing street segments for {location_name}...",
        metrics={"segment_length_m": round(segment_length_m, 2)},
    )

    edges = ox.graph_to_gdfs(graph, nodes=False, fill_edge_geometry=True)
    if edges.empty:
        raise ValueError("No street edges found for this location")

    edges = edges[edges.geometry.notnull()].copy()
    if edges.empty:
        raise ValueError("No usable street geometries found for this location")

    edges_projected = ox.projection.project_gdf(edges)
    total_edges = len(edges_projected)

    # Delete existing street segments for this location
    await Street.find({"properties.location": location_name}).delete()

    segment_count = 0
    total_length_m = 0.0
    batch: list[Street] = []

    progress_start = 15
    progress_span = 20
    progress_interval = max(25, total_edges // 40)
    last_progress = time.monotonic()

    for idx, row in enumerate(edges_projected.itertuples(index=False), start=1):
        geom = getattr(row, "geometry", None)
        if geom is None or geom.is_empty:
            continue

        street_name = _clean_tag_value(getattr(row, "name", None))
        if not street_name:
            street_name = _clean_tag_value(getattr(row, "ref", None))
        highway = _clean_tag_value(getattr(row, "highway", None))
        osmid = _normalize_osmid(getattr(row, "osmid", None))

        for line in _iter_lines(geom):
            segments = _split_line_by_length(line, segment_length_m)
            if not segments:
                continue

            segment_lengths = [seg.length for seg in segments]
            geo_series = gpd.GeoSeries(segments, crs=edges_projected.crs).to_crs(
                "EPSG:4326"
            )

            for seg_geom, seg_length in zip(geo_series, segment_lengths, strict=False):
                if seg_geom is None or seg_geom.is_empty or seg_length <= 0:
                    continue
                if seg_length < MIN_SEGMENT_LENGTH_M:
                    continue

                segment_count += 1
                total_length_m += seg_length

                street_doc = Street(
                    geometry=mapping(seg_geom),
                    properties={
                        "segment_id": f"{location_id}-{segment_count}",
                        "location": location_name,
                        "street_name": street_name,
                        "highway": highway,
                        "segment_length": seg_length,
                        "driven": False,
                        "undriveable": False,
                        "osm_id": osmid,
                    },
                    # Extra fields that were outside of properties/geometry in original dict
                    # But checking Street model, it only has properties and geometry fields + type
                    # The original code added "area_id" and "area_version" and "segment_id" at top level
                    # But Street model says check Config: extra="allow"
                    area_id=location_id,
                    area_version=1,
                    segment_id=f"{location_id}-{segment_count}",
                )

                batch.append(street_doc)

                if len(batch) >= BATCH_SIZE:
                    await Street.insert_many(batch)
                    batch.clear()

        if idx % progress_interval == 0 or time.monotonic() - last_progress >= 1.0:
            progress_pct = progress_start + int(progress_span * idx / total_edges)
            await _update_progress(
                task_id,
                progress_pct,
                f"Segmented {idx:,}/{total_edges:,} street edges...",
                metrics={
                    "total_edges": total_edges,
                    "processed_edges": idx,
                    "segments_created": segment_count,
                },
            )
            last_progress = time.monotonic()

    if batch:
        await Street.insert_many(batch)

    # Update CoverageMetadata
    await CoverageMetadata.find_one({"location.display_name": location_name}).upsert(
        {
            "$set": {
                "total_segments": segment_count,
                "total_length_m": total_length_m,
                "driveable_length_m": total_length_m,
                "last_updated": datetime.now(UTC),
            }
        },
        on_insert=CoverageMetadata(
            location={"display_name": location_name},
            total_segments=segment_count,
            total_length_m=total_length_m,
            driveable_length_m=total_length_m,
            last_updated=datetime.now(UTC),
        ),
    )

    await _update_progress(
        task_id,
        35,
        f"Street segmentation complete ({segment_count:,} segments).",
        metrics={
            "total_segments": segment_count,
            "total_length_m": round(total_length_m, 2),
        },
    )

    return {
        "segment_count": segment_count,
        "total_length_m": total_length_m,
    }
