"""AreaManager service for area CRUD and lifecycle management.

Handles:
- Creating areas from OSM search or custom boundaries
- Area deletion with cleanup of all associated data
- Triggering rebuilds
- Finding areas that intersect with trip geometries
"""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from shapely.geometry import box, shape

from coverage_models.area import (
    Area,
    AreaCreate,
    AreaStats,
    AreaStatus,
    AreaType,
    doc_to_area,
)
from coverage_models.job_status import JobType
from db import (
    areas_collection,
    coverage_state_collection,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    streets_v2_collection,
    update_one_with_retry,
)
from services.job_manager import job_manager

logger = logging.getLogger(__name__)


def _compute_bbox_from_geometry(geometry: dict[str, Any]) -> list[float]:
    """Compute bounding box [minLon, minLat, maxLon, maxLat] from GeoJSON geometry."""
    try:
        geom = shape(geometry)
        bounds = geom.bounds  # (minx, miny, maxx, maxy)
        return [bounds[0], bounds[1], bounds[2], bounds[3]]
    except Exception as e:
        logger.warning("Failed to compute bbox: %s", e)
        return [-180.0, -90.0, 180.0, 90.0]


class AreaManager:
    """Manages area lifecycle including creation, deletion, and rebuilds."""

    async def create_area(self, request: AreaCreate) -> Area:
        """Create a new area and queue ingestion job.

        Args:
            request: AreaCreate request with display_name, area_type, and either
                     osm_id/osm_type (for OSM areas) or geometry (for custom areas)

        Returns:
            Created Area object with status="initializing"

        Raises:
            ValueError: If area already exists or required fields are missing
        """
        # Check for duplicate
        existing = await find_one_with_retry(
            areas_collection,
            {"display_name": request.display_name},
        )
        if existing:
            raise ValueError(f"Area '{request.display_name}' already exists")

        # Get boundary geometry
        if request.area_type == AreaType.CUSTOM:
            if not request.geometry:
                raise ValueError("Custom area requires geometry")
            boundary = request.geometry
        else:
            # OSM area - need to fetch boundary
            if not request.osm_id or not request.osm_type:
                raise ValueError("OSM area requires osm_id and osm_type")
            boundary = await self._fetch_osm_boundary(
                request.osm_id,
                request.osm_type,
            )

        # Compute bbox
        bbox = _compute_bbox_from_geometry(boundary)

        # Create area document
        now = datetime.now(UTC)
        area_doc = {
            "display_name": request.display_name,
            "area_type": (
                request.area_type.value
                if isinstance(request.area_type, AreaType)
                else request.area_type
            ),
            "boundary": boundary,
            "bbox": bbox,
            "osm_id": request.osm_id,
            "osm_type": request.osm_type,
            "segment_length_m": request.get_segment_length_m(),
            "match_buffer_m": request.get_match_buffer_m(),
            "min_match_length_m": request.get_min_match_length_m(),
            "current_version": 1,
            "status": AreaStatus.INITIALIZING.value,
            "last_error": None,
            "last_ingestion_at": None,
            "last_coverage_sync_at": None,
            "cached_stats": AreaStats().model_dump(),
            "created_at": now,
            "updated_at": now,
        }

        result = await insert_one_with_retry(areas_collection, area_doc)
        area_id = str(result.inserted_id)
        area_doc["_id"] = area_id

        logger.info(
            "Created area '%s' (id=%s, type=%s)",
            request.display_name,
            area_id,
            request.area_type,
        )

        # Queue ingestion job
        job = await job_manager.create_job(
            job_type=JobType.AREA_INGESTION,
            area_id=area_id,
        )

        # Start ingestion in background
        asyncio.create_task(self._run_ingestion(area_id, str(job.id)))

        return doc_to_area(area_doc)

    async def _run_ingestion(self, area_id: str, job_id: str) -> None:
        """Run ingestion in background task."""
        try:
            from services.ingestion_service import ingestion_service

            await ingestion_service.ingest_area(area_id, job_id)
        except Exception as e:
            logger.exception("Background ingestion failed for area %s: %s", area_id, e)

    async def _fetch_osm_boundary(
        self,
        osm_id: int,
        osm_type: str,
    ) -> dict[str, Any]:
        """Fetch boundary polygon from Nominatim for an OSM place.

        Args:
            osm_id: OSM ID
            osm_type: OSM type (N, W, R for node, way, relation)

        Returns:
            GeoJSON geometry dict
        """
        import httpx

        # Map osm_type to Nominatim format
        type_map = {
            "N": "N",
            "W": "W",
            "R": "R",
            "node": "N",
            "way": "W",
            "relation": "R",
        }
        osm_type_code = type_map.get(osm_type.upper(), osm_type[0].upper())

        url = f"https://nominatim.openstreetmap.org/lookup"
        params = {
            "osm_ids": f"{osm_type_code}{osm_id}",
            "format": "json",
            "polygon_geojson": 1,
        }
        headers = {"User-Agent": "EveryStreet/1.0"}

        async with httpx.AsyncClient() as client:
            response = await client.get(
                url, params=params, headers=headers, timeout=30.0
            )
            response.raise_for_status()
            data = response.json()

        if not data:
            raise ValueError(f"No results found for OSM {osm_type}{osm_id}")

        result = data[0]
        geojson = result.get("geojson")
        if not geojson:
            # Fall back to bounding box
            bbox = result.get("boundingbox")
            if bbox and len(bbox) >= 4:
                # [south, north, west, east] -> box(west, south, east, north)
                geojson = box(
                    float(bbox[2]),
                    float(bbox[0]),
                    float(bbox[3]),
                    float(bbox[1]),
                ).__geo_interface__
            else:
                raise ValueError(f"No boundary found for OSM {osm_type}{osm_id}")

        return geojson

    async def get_area(self, area_id: str) -> Area | None:
        """Get area by ID.

        Args:
            area_id: Area ID

        Returns:
            Area object or None
        """
        try:
            oid = ObjectId(area_id)
        except Exception:
            return None

        doc = await find_one_with_retry(areas_collection, {"_id": oid})
        if doc:
            return doc_to_area(doc)
        return None

    async def get_area_by_name(self, display_name: str) -> Area | None:
        """Get area by display name.

        Args:
            display_name: Area display name

        Returns:
            Area object or None
        """
        doc = await find_one_with_retry(
            areas_collection,
            {"display_name": display_name},
        )
        if doc:
            return doc_to_area(doc)
        return None

    async def list_areas(
        self,
        status: AreaStatus | str | None = None,
        limit: int = 100,
    ) -> list[Area]:
        """List all areas, optionally filtered by status.

        Args:
            status: Optional status filter
            limit: Maximum number of areas to return

        Returns:
            List of Area objects
        """
        query: dict[str, Any] = {}
        if status is not None:
            if isinstance(status, AreaStatus):
                status = status.value
            query["status"] = status

        docs = await find_with_retry(
            areas_collection,
            query,
            sort=[("updated_at", -1)],
            limit=limit,
        )

        return [doc_to_area(doc) for doc in docs]

    async def delete_area(self, area_id: str) -> bool:
        """Delete an area and all associated data.

        Args:
            area_id: Area ID to delete

        Returns:
            True if deleted, False if not found
        """
        try:
            oid = ObjectId(area_id)
        except Exception:
            return False

        # Check area exists
        area_doc = await find_one_with_retry(areas_collection, {"_id": oid})
        if not area_doc:
            return False

        display_name = area_doc.get("display_name", area_id)

        # Delete associated data
        # 1. Delete streets_v2 for this area
        result = await delete_many_with_retry(
            streets_v2_collection,
            {"area_id": oid},
        )
        logger.info(
            "Deleted %d streets for area %s", result.deleted_count, display_name
        )

        # 2. Delete coverage_state for this area
        result = await delete_many_with_retry(
            coverage_state_collection,
            {"area_id": oid},
        )
        logger.info(
            "Deleted %d coverage_state entries for area %s",
            result.deleted_count,
            display_name,
        )

        # 3. Delete area document
        await delete_one_with_retry(areas_collection, {"_id": oid})
        logger.info("Deleted area %s", display_name)

        return True

    async def trigger_rebuild(
        self, area_id: str, preserve_overrides: bool = True
    ) -> str:
        """Trigger a rebuild for an area.

        Uses the RebuildService to:
        1. Increment the area version
        2. Re-fetch OSM data
        3. Re-segment streets
        4. Optionally migrate manual overrides

        Args:
            area_id: Area ID to rebuild
            preserve_overrides: Whether to migrate manual overrides (default: True)

        Returns:
            Job ID for the rebuild

        Raises:
            ValueError: If area not found or already has an active job
        """
        try:
            oid = ObjectId(area_id)
        except Exception:
            raise ValueError(f"Invalid area ID: {area_id}")

        area_doc = await find_one_with_retry(areas_collection, {"_id": oid})
        if not area_doc:
            raise ValueError(f"Area {area_id} not found")

        # Check if there's already an active job
        active_job = await job_manager.get_active_job_for_area(area_id)
        if active_job:
            raise ValueError(f"Area {area_id} already has an active job")

        # Create rebuild job
        job = await job_manager.create_job(
            job_type=JobType.REBUILD,
            area_id=area_id,
        )

        # Start rebuild in background using rebuild_service
        asyncio.create_task(self._run_rebuild(area_id, str(job.id), preserve_overrides))

        logger.info(
            "Triggered rebuild for area %s, job %s",
            area_doc.get("display_name"),
            job.id,
        )

        return str(job.id)

    async def _run_rebuild(
        self,
        area_id: str,
        job_id: str,
        preserve_overrides: bool,
    ) -> None:
        """Run rebuild in background task."""
        try:
            from services.rebuild_service import rebuild_service

            await rebuild_service.rebuild_area(
                area_id=area_id,
                job_id=job_id,
                preserve_overrides=preserve_overrides,
            )
        except Exception as e:
            logger.exception("Background rebuild failed for area %s: %s", area_id, e)

    async def get_areas_intersecting_bbox(
        self,
        bbox: tuple[float, float, float, float],
    ) -> list[Area]:
        """Find areas whose boundaries intersect a bounding box.

        Uses fast bbox overlap check first.

        Args:
            bbox: (minLon, minLat, maxLon, maxLat)

        Returns:
            List of intersecting Area objects
        """
        min_lon, min_lat, max_lon, max_lat = bbox

        # Query for bbox overlap
        # An area's bbox overlaps if:
        # area.bbox[0] <= max_lon AND area.bbox[2] >= min_lon AND
        # area.bbox[1] <= max_lat AND area.bbox[3] >= min_lat
        query = {
            "status": AreaStatus.READY.value,
            "$and": [
                {"bbox.0": {"$lte": max_lon}},
                {"bbox.2": {"$gte": min_lon}},
                {"bbox.1": {"$lte": max_lat}},
                {"bbox.3": {"$gte": min_lat}},
            ],
        }

        docs = await find_with_retry(areas_collection, query)
        return [doc_to_area(doc) for doc in docs]

    async def get_areas_intersecting_geometry(
        self,
        geometry: dict[str, Any],
    ) -> list[Area]:
        """Find areas whose boundaries intersect a geometry.

        First uses bbox check, then refines with actual geometry intersection.

        Args:
            geometry: GeoJSON geometry dict

        Returns:
            List of intersecting Area objects
        """
        try:
            geom = shape(geometry)
            bbox = geom.bounds  # (minx, miny, maxx, maxy)
        except Exception as e:
            logger.warning("Failed to parse geometry: %s", e)
            return []

        # Get bbox candidates
        candidates = await self.get_areas_intersecting_bbox(bbox)

        # Refine with actual intersection
        result = []
        for area in candidates:
            try:
                area_geom = shape(area.boundary)
                if area_geom.intersects(geom):
                    result.append(area)
            except Exception:
                # If geometry parsing fails, include as candidate
                result.append(area)

        return result

    async def update_area_stats(
        self,
        area_id: str,
        stats: AreaStats,
    ) -> bool:
        """Update cached stats for an area.

        Args:
            area_id: Area ID
            stats: New stats

        Returns:
            True if update succeeded
        """
        try:
            oid = ObjectId(area_id)
        except Exception:
            return False

        stats_dict = stats.model_dump()
        stats_dict["last_computed_at"] = datetime.now(UTC)

        result = await update_one_with_retry(
            areas_collection,
            {"_id": oid},
            {
                "$set": {
                    "cached_stats": stats_dict,
                    "updated_at": datetime.now(UTC),
                }
            },
        )

        return result.modified_count > 0


# Singleton instance
area_manager = AreaManager()
