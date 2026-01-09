"""IngestionService for OSM data fetching and street segmentation.

Handles the asynchronous ingestion pipeline when an area is created or refreshed:
1. Fetch OSM data for the boundary
2. Build normalized segment set
3. Assign stable segment identifiers
4. Persist streets and coverage_state
"""

import asyncio
import logging
import math
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import osmnx as ox
from bson import ObjectId
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPoint,
    box,
    mapping,
    shape,
)
from shapely.ops import split

from coverage_models.coverage_state import (
    CoverageStatus,
    ProvenanceType,
    create_initial_coverage_state,
)
from coverage_models.job_status import JobState, JobType
from coverage_models.street import UNDRIVEABLE_HIGHWAY_TYPES, compute_bbox
from db import (
    areas_collection,
    coverage_state_collection,
    delete_many_with_retry,
    insert_many_with_retry,
    streets_v2_collection,
    update_one_with_retry,
)
from services.job_manager import job_manager

logger = logging.getLogger(__name__)

# Constants
FEET_TO_METERS = 0.3048
FEET_PER_METER = 3.28084
ROUTING_BUFFER_FT = 6500.0  # ~2000m buffer for routing graph
GRAPH_STORAGE_DIR = Path("data/graphs")
BATCH_SIZE = 1000
MIN_SEGMENT_LENGTH_M = 0.5


def _buffer_polygon_for_routing(polygon, buffer_ft: float):
    """Buffer a WGS84 polygon by feet (project to UTM, buffer, reproject)."""
    if buffer_ft <= 0:
        return polygon
    try:
        buffer_m = buffer_ft / FEET_PER_METER
        gdf = gpd.GeoDataFrame(geometry=[polygon], crs="EPSG:4326")
        projected = ox.projection.project_gdf(gdf)
        buffered = projected.geometry.iloc[0].buffer(buffer_m)
        buffered_gdf = gpd.GeoDataFrame(geometry=[buffered], crs=projected.crs)
        return buffered_gdf.to_crs("EPSG:4326").geometry.iloc[0]
    except Exception as e:
        logger.warning("Routing buffer failed, using original polygon: %s", e)
        return polygon


def _clean_tag_value(value: Any) -> str | None:
    """Clean OSM tag values, handling NaN and lists."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (list, tuple, set)):
        for item in value:
            if item is None:
                continue
            if isinstance(item, float) and math.isnan(item):
                continue
            return str(item)
        return None
    return str(value)


def _normalize_osmid(value: Any) -> int | None:
    """Normalize OSM ID to integer."""
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (list, tuple, set)):
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
        return None


def _split_line_by_length(line: LineString, max_length: float) -> list[LineString]:
    """Split a LineString into segments of max_length."""
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
    """Iterate over LineStrings in a geometry."""
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, MultiLineString):
        return [line for line in geometry.geoms if isinstance(line, LineString)]
    return []


def _is_undriveable(highway: str | None) -> bool:
    """Determine if a highway type is undriveable."""
    if not highway:
        return False
    return highway.lower() in UNDRIVEABLE_HIGHWAY_TYPES


class IngestionService:
    """Handles OSM data ingestion and street segmentation for areas."""

    async def ingest_area(
        self,
        area_id: str,
        job_id: str,
    ) -> dict[str, Any]:
        """Run full ingestion pipeline for an area.

        Args:
            area_id: Area ID to ingest
            job_id: Job ID for progress tracking

        Returns:
            Dict with ingestion results
        """
        area_oid = ObjectId(area_id)
        job_oid = ObjectId(job_id)

        # Get area document
        area_doc = await areas_collection.find_one({"_id": area_oid})
        if not area_doc:
            await job_manager.fail_job(job_oid, "Area not found")
            raise ValueError(f"Area {area_id} not found")

        display_name = area_doc["display_name"]
        version = area_doc.get("current_version", 1)

        logger.info(
            "Starting ingestion for area %s (version %d), job %s",
            display_name,
            version,
            job_id,
        )

        try:
            # Update area status
            await update_one_with_retry(
                areas_collection,
                {"_id": area_oid},
                {
                    "$set": {
                        "status": "ingesting",
                        "last_error": None,
                        "updated_at": datetime.now(UTC),
                    }
                },
            )

            # Start job
            await job_manager.start_job(
                job_oid, stage="fetching_osm", message="Fetching OSM data..."
            )

            # 1. Fetch OSM data
            boundary = area_doc.get("boundary")
            if not boundary:
                raise ValueError("Area has no boundary defined")

            polygon = shape(boundary)
            graph = await self._fetch_osm_graph(polygon, area_id, job_oid)

            await job_manager.update_job(
                job_oid,
                stage="segmenting",
                percent=30,
                message="Segmenting streets...",
            )

            # 2. Segment streets
            segment_length_m = area_doc.get("segment_length_m", 46.0)
            result = await self._segment_streets(
                graph=graph,
                area_id=area_id,
                area_version=version,
                display_name=display_name,
                segment_length_m=segment_length_m,
                job_id=job_id,
            )

            await job_manager.update_job(
                job_oid,
                stage="initializing_coverage",
                percent=80,
                message="Initializing coverage state...",
            )

            # 3. Initialize coverage_state for all segments
            await self._initialize_coverage_state(
                area_id=area_id,
                area_version=version,
                job_id=job_id,
            )

            # 4. Update area with stats and mark as ready
            now = datetime.now(UTC)
            await update_one_with_retry(
                areas_collection,
                {"_id": area_oid},
                {
                    "$set": {
                        "status": "ready",
                        "last_error": None,
                        "last_ingestion_at": now,
                        "updated_at": now,
                        "cached_stats": {
                            "total_segments": result["segment_count"],
                            "covered_segments": 0,
                            "total_length_m": result["total_length_m"],
                            "driven_length_m": 0.0,
                            "driveable_length_m": result["driveable_length_m"],
                            "coverage_percentage": 0.0,
                            "last_computed_at": now,
                        },
                    }
                },
            )

            # Complete job
            await job_manager.complete_job(
                job_oid,
                message=f"Ingestion complete: {result['segment_count']} segments created",
                metrics=result,
            )

            logger.info(
                "Ingestion complete for area %s: %d segments, %.2f km total",
                display_name,
                result["segment_count"],
                result["total_length_m"] / 1000,
            )

            return result

        except Exception as e:
            error_msg = str(e)[:500]
            logger.exception("Ingestion failed for area %s: %s", area_id, e)

            # Update area status to error
            await update_one_with_retry(
                areas_collection,
                {"_id": area_oid},
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "updated_at": datetime.now(UTC),
                    }
                },
            )

            # Fail job
            await job_manager.fail_job(job_oid, error_msg)
            raise

    async def _fetch_osm_graph(
        self,
        polygon,
        area_id: str,
        job_id: ObjectId,
    ):
        """Fetch OSM street network for a polygon.

        Args:
            polygon: Shapely polygon for the area boundary
            area_id: Area ID for caching
            job_id: Job ID for progress updates

        Returns:
            NetworkX graph from osmnx
        """
        # Buffer polygon for routing
        routing_polygon = _buffer_polygon_for_routing(polygon, ROUTING_BUFFER_FT)

        await job_manager.update_job(
            job_id,
            percent=10,
            message="Downloading street network from OpenStreetMap...",
        )

        # Run synchronous osmnx operations in thread pool
        loop = asyncio.get_running_loop()

        def _download():
            GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
            G = ox.graph_from_polygon(
                routing_polygon,
                network_type="drive",
                simplify=True,
                truncate_by_edge=True,
                retain_all=True,
            )
            # Save for caching
            file_path = GRAPH_STORAGE_DIR / f"{area_id}.graphml"
            ox.save_graphml(G, filepath=file_path)
            return G

        graph = await loop.run_in_executor(None, _download)

        await job_manager.update_job(
            job_id,
            percent=25,
            message="OSM data downloaded successfully",
        )

        return graph

    async def _segment_streets(
        self,
        graph,
        area_id: str,
        area_version: int,
        display_name: str,
        segment_length_m: float,
        job_id: str,
    ) -> dict[str, Any]:
        """Segment streets from OSM graph and persist to database.

        Args:
            graph: NetworkX graph from osmnx
            area_id: Area ID
            area_version: Area version number
            display_name: Area display name
            segment_length_m: Target segment length in meters
            job_id: Job ID for progress updates

        Returns:
            Dict with segment statistics
        """
        job_oid = ObjectId(job_id)

        # Convert graph to GeoDataFrame
        edges = ox.graph_to_gdfs(graph, nodes=False, fill_edge_geometry=True)
        if edges.empty:
            raise ValueError("No street edges found in OSM data")

        edges = edges[edges.geometry.notnull()].copy()
        if edges.empty:
            raise ValueError("No usable street geometries found")

        # Project to UTM for accurate distance calculations
        edges_projected = ox.projection.project_gdf(edges)
        total_edges = len(edges_projected)

        # Delete any existing streets for this area/version
        await delete_many_with_retry(
            streets_v2_collection,
            {"area_id": ObjectId(area_id), "area_version": area_version},
        )

        segment_count = 0
        total_length_m = 0.0
        driveable_length_m = 0.0
        batch: list[dict[str, Any]] = []

        progress_interval = max(25, total_edges // 40)
        last_progress = time.monotonic()

        for idx, row in enumerate(edges_projected.itertuples(index=False), start=1):
            geom = getattr(row, "geometry", None)
            if geom is None or geom.is_empty:
                continue

            street_name = _clean_tag_value(getattr(row, "name", None))
            if not street_name:
                street_name = _clean_tag_value(getattr(row, "ref", None))
            highway = _clean_tag_value(getattr(row, "highway", None)) or "unclassified"
            osmid = _normalize_osmid(getattr(row, "osmid", None))
            undriveable = _is_undriveable(highway)

            for line in _iter_lines(geom):
                segments = _split_line_by_length(line, segment_length_m)
                if not segments:
                    continue

                segment_lengths = [seg.length for seg in segments]
                geo_series = gpd.GeoSeries(segments, crs=edges_projected.crs).to_crs(
                    "EPSG:4326"
                )

                for seg_geom, seg_length in zip(
                    geo_series, segment_lengths, strict=False
                ):
                    if seg_geom is None or seg_geom.is_empty or seg_length <= 0:
                        continue
                    if seg_length < MIN_SEGMENT_LENGTH_M:
                        continue

                    segment_count += 1
                    total_length_m += seg_length
                    if not undriveable:
                        driveable_length_m += seg_length

                    # Create segment ID: "{area_id}-{version}-{seq}"
                    segment_id = f"{area_id}-{area_version}-{segment_count}"

                    geometry_dict = mapping(seg_geom)
                    bbox = compute_bbox(geometry_dict)

                    batch.append(
                        {
                            "area_id": ObjectId(area_id),
                            "area_version": area_version,
                            "segment_id": segment_id,
                            "geometry": geometry_dict,
                            "bbox": bbox,
                            "street_name": street_name,
                            "highway": highway,
                            "osm_id": osmid,
                            "segment_length_m": seg_length,
                            "undriveable": undriveable,
                            "created_at": datetime.now(UTC),
                        }
                    )

                    if len(batch) >= BATCH_SIZE:
                        await insert_many_with_retry(streets_v2_collection, batch)
                        batch.clear()

            # Update progress periodically
            if idx % progress_interval == 0 or time.monotonic() - last_progress >= 1.0:
                progress_pct = 30 + int(40 * idx / total_edges)
                await job_manager.update_job(
                    job_oid,
                    percent=progress_pct,
                    message=f"Segmented {idx:,}/{total_edges:,} edges, {segment_count:,} segments created...",
                    metrics={
                        "total_edges": total_edges,
                        "processed_edges": idx,
                        "segments_created": segment_count,
                    },
                )
                last_progress = time.monotonic()

        # Insert remaining batch
        if batch:
            await insert_many_with_retry(streets_v2_collection, batch)

        return {
            "segment_count": segment_count,
            "total_length_m": total_length_m,
            "driveable_length_m": driveable_length_m,
            "total_edges": total_edges,
        }

    async def _initialize_coverage_state(
        self,
        area_id: str,
        area_version: int,
        job_id: str,
    ) -> int:
        """Initialize coverage_state documents for all segments.

        Args:
            area_id: Area ID
            area_version: Area version number
            job_id: Job ID for progress updates

        Returns:
            Number of coverage_state documents created
        """
        job_oid = ObjectId(job_id)
        area_oid = ObjectId(area_id)

        # Delete existing coverage_state for this area/version
        await delete_many_with_retry(
            coverage_state_collection,
            {"area_id": area_oid, "area_version": area_version},
        )

        # Fetch all segments for this area/version
        cursor = streets_v2_collection.find(
            {"area_id": area_oid, "area_version": area_version},
            {"segment_id": 1, "undriveable": 1},
        )

        batch: list[dict[str, Any]] = []
        count = 0

        async for street_doc in cursor:
            segment_id = street_doc["segment_id"]
            undriveable = street_doc.get("undriveable", False)

            state_doc = create_initial_coverage_state(
                area_id=area_id,
                area_version=area_version,
                segment_id=segment_id,
                undriveable=undriveable,
            )
            batch.append(state_doc)
            count += 1

            if len(batch) >= BATCH_SIZE:
                await insert_many_with_retry(coverage_state_collection, batch)
                batch.clear()

                # Update progress
                await job_manager.update_job(
                    job_oid,
                    percent=80 + min(15, int(15 * count / 10000)),
                    message=f"Initialized coverage state for {count:,} segments...",
                )

        if batch:
            await insert_many_with_retry(coverage_state_collection, batch)

        logger.info(
            "Initialized coverage_state for %d segments (area=%s, version=%d)",
            count,
            area_id,
            area_version,
        )

        return count


# Singleton instance
ingestion_service = IngestionService()
