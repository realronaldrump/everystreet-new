"""CoverageService for trip-to-street matching and coverage updates.

Handles the core coverage calculation logic:
1. Match trip geometry to street segments
2. Update coverage_state for matched segments
3. Recalculate area cached_stats
"""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform
import pyproj

from db import (
    aggregate_with_retry,
    areas_collection,
    coverage_state_collection,
    find_one_with_retry,
    streets_v2_collection,
    update_many_with_retry,
    update_one_with_retry,
)
from coverage_models.area import AreaStats
from coverage_models.coverage_state import CoverageStatus, ProvenanceType
from services.area_manager import area_manager
from services.job_manager import job_manager

logger = logging.getLogger(__name__)

# Default buffer for matching (in meters)
DEFAULT_MATCH_BUFFER_M = 15.0


class CoverageService:
    """Handles trip-to-street matching and coverage updates."""

    async def process_trip_for_area(
        self,
        area_id: str,
        trip_id: str,
        job_id: str,
        gps_geometry: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Process a trip for coverage update in a specific area.

        Args:
            area_id: Area ID to update
            trip_id: Trip ID being processed
            job_id: Job ID for progress tracking
            gps_geometry: Trip geometry (GeoJSON Point or LineString)

        Returns:
            Dict with processing results
        """
        area_oid = ObjectId(area_id)
        job_oid = ObjectId(job_id)

        # Get area
        area_doc = await find_one_with_retry(areas_collection, {"_id": area_oid})
        if not area_doc:
            await job_manager.fail_job(job_oid, "Area not found")
            return {"error": "Area not found"}

        area_version = area_doc.get("current_version", 1)
        match_buffer_m = area_doc.get("match_buffer_m", DEFAULT_MATCH_BUFFER_M)
        display_name = area_doc.get("display_name", area_id)

        logger.info(
            "Processing trip %s for area %s (version %d)",
            trip_id,
            display_name,
            area_version,
        )

        try:
            await job_manager.start_job(
                job_oid,
                stage="matching",
                message=f"Matching trip to streets in {display_name}...",
            )

            # If no geometry provided, try to fetch from trips collection
            if not gps_geometry:
                gps_geometry = await self._fetch_trip_geometry(trip_id)
                if not gps_geometry:
                    await job_manager.fail_job(job_oid, "No trip geometry available")
                    return {"error": "No trip geometry"}

            # Match trip to street segments
            matched_segment_ids = await self._match_trip_to_streets(
                area_id=area_id,
                area_version=area_version,
                gps_geometry=gps_geometry,
                buffer_m=match_buffer_m,
            )

            if not matched_segment_ids:
                await job_manager.complete_job(
                    job_oid,
                    message="No streets matched",
                    metrics={"matched_segments": 0},
                )
                return {"matched_segments": 0}

            await job_manager.update_job(
                job_oid,
                stage="updating",
                percent=50,
                message=f"Updating {len(matched_segment_ids)} segments...",
            )

            # Update coverage_state for matched segments
            updated_count = await self._update_coverage_state(
                area_id=area_id,
                area_version=area_version,
                segment_ids=matched_segment_ids,
                trip_id=trip_id,
            )

            await job_manager.update_job(
                job_oid,
                stage="stats",
                percent=80,
                message="Updating area statistics...",
            )

            # Recalculate area stats
            await self._update_area_stats(area_id, area_version)

            # Update last_coverage_sync_at
            await update_one_with_retry(
                areas_collection,
                {"_id": area_oid},
                {"$set": {"last_coverage_sync_at": datetime.now(UTC)}},
            )

            await job_manager.complete_job(
                job_oid,
                message=f"Updated {updated_count} segments",
                metrics={
                    "matched_segments": len(matched_segment_ids),
                    "updated_segments": updated_count,
                },
            )

            logger.info(
                "Coverage update complete for trip %s in area %s: %d segments matched, %d updated",
                trip_id,
                display_name,
                len(matched_segment_ids),
                updated_count,
            )

            return {
                "matched_segments": len(matched_segment_ids),
                "updated_segments": updated_count,
            }

        except Exception as e:
            error_msg = str(e)[:500]
            logger.exception(
                "Coverage update failed for trip %s in area %s: %s",
                trip_id,
                display_name,
                e,
            )
            await job_manager.fail_job(job_oid, error_msg)
            return {"error": error_msg}

    async def _fetch_trip_geometry(self, trip_id: str) -> dict[str, Any] | None:
        """Fetch trip geometry from database.

        Prefers matchedGps over gps.

        Args:
            trip_id: Trip transaction ID

        Returns:
            GeoJSON geometry dict or None
        """
        from db import trips_collection

        trip = await find_one_with_retry(
            trips_collection,
            {"transactionId": trip_id},
            {"matchedGps": 1, "gps": 1},
        )

        if not trip:
            return None

        # Prefer matched GPS
        return trip.get("matchedGps") or trip.get("gps")

    async def _match_trip_to_streets(
        self,
        area_id: str,
        area_version: int,
        gps_geometry: dict[str, Any],
        buffer_m: float,
    ) -> list[str]:
        """Match trip geometry to street segments using buffered intersection.

        Args:
            area_id: Area ID
            area_version: Area version
            gps_geometry: Trip GeoJSON geometry
            buffer_m: Buffer distance in meters

        Returns:
            List of matched segment_ids
        """
        area_oid = ObjectId(area_id)

        # Parse and buffer trip geometry
        try:
            trip_geom = shape(gps_geometry)
        except Exception as e:
            logger.warning("Failed to parse trip geometry: %s", e)
            return []

        # Buffer the trip geometry
        buffered_geom = self._buffer_geometry(trip_geom, buffer_m)
        if buffered_geom is None:
            return []

        # Convert to GeoJSON for MongoDB query
        buffered_geojson = buffered_geom.__geo_interface__

        # Query streets that intersect the buffered trip
        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                    "geometry": {
                        "$geoIntersects": {
                            "$geometry": buffered_geojson,
                        }
                    },
                }
            },
            {"$project": {"segment_id": 1}},
        ]

        results = await aggregate_with_retry(streets_v2_collection, pipeline)
        return [doc["segment_id"] for doc in results]

    def _buffer_geometry(self, geom, buffer_m: float):
        """Buffer a geometry by meters.

        Projects to UTM, buffers, then back to WGS84.

        Args:
            geom: Shapely geometry in WGS84
            buffer_m: Buffer distance in meters

        Returns:
            Buffered geometry in WGS84, or None on error
        """
        try:
            # Get centroid for UTM zone calculation
            centroid = geom.centroid
            utm_zone = int((centroid.x + 180) / 6) + 1
            hemisphere = "north" if centroid.y >= 0 else "south"

            # Create projections
            wgs84 = pyproj.CRS("EPSG:4326")
            utm = pyproj.CRS(f"+proj=utm +zone={utm_zone} +{hemisphere} +datum=WGS84")

            project_to_utm = pyproj.Transformer.from_crs(wgs84, utm, always_xy=True).transform
            project_to_wgs = pyproj.Transformer.from_crs(utm, wgs84, always_xy=True).transform

            # Project, buffer, project back
            geom_utm = transform(project_to_utm, geom)
            buffered_utm = geom_utm.buffer(buffer_m)
            buffered_wgs = transform(project_to_wgs, buffered_utm)

            return buffered_wgs

        except Exception as e:
            logger.warning("Failed to buffer geometry: %s", e)
            # Fall back to degree-based approximation
            # 1 degree ≈ 111km at equator
            buffer_deg = buffer_m / 111000
            return geom.buffer(buffer_deg)

    async def _update_coverage_state(
        self,
        area_id: str,
        area_version: int,
        segment_ids: list[str],
        trip_id: str,
    ) -> int:
        """Update coverage_state for matched segments.

        Respects manual_override flag - segments with manual_override=True
        are not updated.

        Args:
            area_id: Area ID
            area_version: Area version
            segment_ids: List of segment_ids to mark as driven
            trip_id: Trip ID for provenance

        Returns:
            Number of segments actually updated
        """
        area_oid = ObjectId(area_id)
        now = datetime.now(UTC)

        # Update segments that:
        # 1. Match the segment_ids
        # 2. Are not manually overridden
        # 3. Are not already marked as driven by this trip
        result = await update_many_with_retry(
            coverage_state_collection,
            {
                "area_id": area_oid,
                "area_version": area_version,
                "segment_id": {"$in": segment_ids},
                "manual_override": {"$ne": True},
                # Only update if status is not already driven, or if it is driven but by a different source
                "$or": [
                    {"status": {"$ne": CoverageStatus.DRIVEN.value}},
                    {"provenance.trip_id": {"$ne": trip_id}},
                ],
            },
            {
                "$set": {
                    "status": CoverageStatus.DRIVEN.value,
                    "last_driven_at": now,
                    "provenance": {
                        "type": ProvenanceType.TRIP.value,
                        "trip_id": trip_id,
                        "user_note": None,
                        "updated_at": now,
                    },
                    "updated_at": now,
                }
            },
        )

        return result.modified_count

    async def _update_area_stats(
        self,
        area_id: str,
        area_version: int,
    ) -> AreaStats:
        """Recalculate and update cached stats for an area.

        Args:
            area_id: Area ID
            area_version: Area version

        Returns:
            Updated AreaStats
        """
        area_oid = ObjectId(area_id)

        # Aggregate coverage stats
        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                }
            },
            {
                "$lookup": {
                    "from": "streets_v2",
                    "let": {"seg_id": "$segment_id"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$and": [
                                        {"$eq": ["$area_id", area_oid]},
                                        {"$eq": ["$area_version", area_version]},
                                        {"$eq": ["$segment_id", "$$seg_id"]},
                                    ]
                                }
                            }
                        },
                        {"$project": {"segment_length_m": 1, "undriveable": 1}},
                    ],
                    "as": "street",
                }
            },
            {"$unwind": {"path": "$street", "preserveNullAndEmptyArrays": True}},
            {
                "$group": {
                    "_id": None,
                    "total_segments": {"$sum": 1},
                    "covered_segments": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$status", CoverageStatus.DRIVEN.value]},
                                1,
                                0,
                            ]
                        }
                    },
                    "total_length_m": {
                        "$sum": {"$ifNull": ["$street.segment_length_m", 0]}
                    },
                    "driven_length_m": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$status", CoverageStatus.DRIVEN.value]},
                                {"$ifNull": ["$street.segment_length_m", 0]},
                                0,
                            ]
                        }
                    },
                    "driveable_length_m": {
                        "$sum": {
                            "$cond": [
                                {"$ne": ["$status", CoverageStatus.UNDRIVEABLE.value]},
                                {"$ifNull": ["$street.segment_length_m", 0]},
                                0,
                            ]
                        }
                    },
                }
            },
        ]

        results = await aggregate_with_retry(coverage_state_collection, pipeline)

        if results:
            result = results[0]
            total_segments = result.get("total_segments", 0)
            covered_segments = result.get("covered_segments", 0)
            total_length_m = result.get("total_length_m", 0)
            driven_length_m = result.get("driven_length_m", 0)
            driveable_length_m = result.get("driveable_length_m", 0)
        else:
            total_segments = 0
            covered_segments = 0
            total_length_m = 0
            driven_length_m = 0
            driveable_length_m = 0

        # Calculate percentage
        coverage_percentage = 0.0
        if driveable_length_m > 0:
            coverage_percentage = (driven_length_m / driveable_length_m) * 100

        now = datetime.now(UTC)
        stats = AreaStats(
            total_segments=total_segments,
            covered_segments=covered_segments,
            total_length_m=total_length_m,
            driven_length_m=driven_length_m,
            driveable_length_m=driveable_length_m,
            coverage_percentage=round(coverage_percentage, 2),
            last_computed_at=now,
        )

        # Update area with new stats
        await update_one_with_retry(
            areas_collection,
            {"_id": area_oid},
            {
                "$set": {
                    "cached_stats": stats.model_dump(),
                    "updated_at": now,
                }
            },
        )

        return stats

    async def recalculate_area_stats(self, area_id: str) -> AreaStats:
        """Recalculate stats for an area (public method for admin use).

        Args:
            area_id: Area ID

        Returns:
            Updated AreaStats
        """
        area = await area_manager.get_area(area_id)
        if not area:
            raise ValueError(f"Area {area_id} not found")

        return await self._update_area_stats(area_id, area.current_version)


# Singleton instance
coverage_service = CoverageService()
