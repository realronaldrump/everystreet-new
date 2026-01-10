"""Business logic services for coverage operations.

Contains services for statistics calculation, segment marking,
and geometry operations.
"""

import logging
from collections import defaultdict
from datetime import UTC, datetime

from bson import ObjectId
from fastapi import HTTPException, status
from shapely.geometry import shape

from coverage.gridfs_service import gridfs_service
from coverage.serializers import serialize_coverage_details
from db import (aggregate_with_retry, db_manager, find_one_with_retry,
                update_one_with_retry)

logger = logging.getLogger(__name__)


class CoverageStatsService:
    """Service for calculating and managing coverage statistics."""

    def __init__(self):
        """Initialize coverage stats service."""
        self.coverage_metadata_collection = db_manager.db["coverage_metadata"]
        self.streets_collection = db_manager.db["streets"]

    async def recalculate_stats(self, location_id: ObjectId) -> dict | None:
        """Recalculate statistics for a coverage area.

        Args:
            location_id: Coverage area ID

        Returns:
            Updated coverage area data or None on error
        """
        try:
            coverage_area = await find_one_with_retry(
                self.coverage_metadata_collection,
                {"_id": location_id},
                {"location.display_name": 1},
            )

            if not coverage_area or not coverage_area.get("location", {}).get(
                "display_name",
            ):
                logger.error(
                    "Cannot recalculate stats: Coverage area %s or its "
                    "display_name not found.",
                    location_id,
                )
                return None

            location_name = coverage_area["location"]["display_name"]

            # Aggregate stats from streets collection
            stats = await self._aggregate_street_stats(location_name)

            # Update metadata
            update_result = await update_one_with_retry(
                self.coverage_metadata_collection,
                {"_id": location_id},
                {
                    "$set": {
                        **stats,
                        "needs_stats_update": False,
                        "last_stats_update": datetime.now(UTC),
                        "last_modified": datetime.now(UTC),
                    },
                },
            )

            if update_result.modified_count == 0:
                logger.warning(
                    "Stats recalculated for %s, but metadata document was not "
                    "modified (maybe no change or error?).",
                    location_id,
                )
            else:
                logger.info(
                    "Successfully recalculated and updated stats for %s.",
                    location_id,
                )

            # Fetch and return updated document
            updated_coverage_area = await find_one_with_retry(
                self.coverage_metadata_collection,
                {"_id": location_id},
            )

            if updated_coverage_area:
                return serialize_coverage_details(updated_coverage_area)

            # Fallback response
            base_response = {
                **stats,
                "_id": str(location_id),
                "location": coverage_area.get("location", {}),
                "last_updated": datetime.now(UTC).isoformat(),
                "last_stats_update": datetime.now(UTC).isoformat(),
            }
            return base_response

        except Exception as e:
            logger.error(
                "Error recalculating stats for %s: %s",
                location_id,
                e,
                exc_info=True,
            )
            await update_one_with_retry(
                self.coverage_metadata_collection,
                {"_id": location_id},
                {
                    "$set": {
                        "status": "error",
                        "last_error": f"Stats recalc failed: {e}",
                    },
                },
            )
            return None

    async def _aggregate_street_stats(self, location_name: str) -> dict:
        """Aggregate statistics from streets collection.

        Args:
            location_name: Location display name

        Returns:
            Dictionary of calculated statistics
        """
        pipeline = [
            {"$match": {"properties.location": location_name}},
            {
                "$group": {
                    "_id": None,
                    "total_segments": {"$sum": 1},
                    "driveable_segments": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.undriveable", True]},
                                0,
                                1,
                            ]
                        }
                    },
                    "total_length": {"$sum": "$properties.segment_length"},
                    "driveable_length": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.undriveable", True]},
                                0,
                                "$properties.segment_length",
                            ]
                        }
                    },
                    "driven_length": {
                        "$sum": {
                            "$cond": [
                                {"$eq": ["$properties.driven", True]},
                                "$properties.segment_length",
                                0,
                            ]
                        }
                    },
                    "street_types_data": {
                        "$push": {
                            "type": "$properties.highway",
                            "length": "$properties.segment_length",
                            "driven": "$properties.driven",
                            "undriveable": "$properties.undriveable",
                        },
                    },
                },
            },
        ]

        results = await aggregate_with_retry(self.streets_collection, pipeline)

        if not results:
            return {
                "total_length": 0.0,
                "driven_length": 0.0,
                "driveable_length": 0.0,
                "coverage_percentage": 0.0,
                "total_segments": 0,
                "street_types": [],
            }

        agg_result = results[0]
        total_length = agg_result.get("total_length", 0.0) or 0.0
        driven_length = agg_result.get("driven_length", 0.0) or 0.0
        driveable_length = agg_result.get("driveable_length", 0.0) or 0.0
        total_segments = agg_result.get("total_segments", 0) or 0
        driveable_segments = agg_result.get("driveable_segments", 0) or 0

        coverage_percentage = (
            (driven_length / driveable_length * 100) if driveable_length > 0 else 0.0
        )

        # Calculate per-street-type statistics
        street_types = self._calculate_street_type_stats(
            agg_result.get("street_types_data", [])
        )

        return {
            "total_length": total_length,
            "driven_length": driven_length,
            "driveable_length": driveable_length,
            "total_segments": total_segments,
            "driveable_segments": driveable_segments,
            "coverage_percentage": coverage_percentage,
            "street_types": street_types,
        }

    @staticmethod
    def _calculate_street_type_stats(street_types_data: list) -> list:
        """Calculate per-street-type statistics.

        Args:
            street_types_data: List of street type data from aggregation

        Returns:
            List of street type statistics
        """
        street_types_summary = defaultdict(
            lambda: {
                "length": 0.0,
                "covered_length": 0.0,
                "undriveable_length": 0.0,
                "total": 0,
                "covered": 0,
            },
        )

        for item in street_types_data:
            stype = item.get("type", "unknown")
            length = item.get("length", 0.0) or 0.0
            is_driven = item.get("driven", False)
            is_undriveable = item.get("undriveable", False)

            street_types_summary[stype]["length"] += length
            street_types_summary[stype]["total"] += 1

            if is_undriveable:
                street_types_summary[stype]["undriveable_length"] += length
            elif is_driven:
                street_types_summary[stype]["covered_length"] += length
                street_types_summary[stype]["covered"] += 1

        # Build final street types list
        final_street_types = []
        for stype, data in street_types_summary.items():
            type_driveable_length = data["length"] - data["undriveable_length"]
            type_coverage_pct = (
                (data["covered_length"] / type_driveable_length * 100)
                if type_driveable_length > 0
                else 0.0
            )
            final_street_types.append(
                {
                    "type": stype,
                    "length": data["length"],
                    "covered_length": data["covered_length"],
                    "coverage_percentage": type_coverage_pct,
                    "total": data["total"],
                    "covered": data["covered"],
                    "undriveable_length": data["undriveable_length"],
                }
            )

        final_street_types.sort(key=lambda x: x["length"], reverse=True)
        return final_street_types


class SegmentMarkingService:
    """Service for marking street segments with manual overrides."""

    def __init__(self):
        """Initialize segment marking service."""
        self.streets_collection = db_manager.db["streets"]
        self.coverage_metadata_collection = db_manager.db["coverage_metadata"]
        self.stats_service = CoverageStatsService()

    async def mark_segment(
        self,
        location_id_str: str,
        segment_id: str,
        updates: dict,
        action_name: str,
    ) -> dict:
        """Mark a street segment with updates.

        Args:
            location_id_str: Coverage area location ID
            segment_id: Street segment ID
            updates: Dictionary of property updates
            action_name: Name of the marking action for logging

        Returns:
            Success response dictionary

        Raises:
            HTTPException: On validation or processing errors
        """
        if not location_id_str or not segment_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing location_id or segment_id",
            )

        try:
            obj_location_id = ObjectId(location_id_str)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location_id format",
            )

        # Find segment
        segment_doc = await find_one_with_retry(
            self.streets_collection,
            {"properties.segment_id": segment_id},
        )

        if not segment_doc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Street segment not found",
            )

        # Validate location match
        coverage_meta = await find_one_with_retry(
            self.coverage_metadata_collection,
            {"_id": obj_location_id},
            {"location.display_name": 1},
        )

        if not coverage_meta or not coverage_meta.get("location", {}).get(
            "display_name"
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage location metadata not found for the given ID.",
            )

        expected_location_name = coverage_meta["location"]["display_name"]
        segment_location_name = segment_doc.get("properties", {}).get("location")

        if segment_location_name != expected_location_name:
            logger.warning(
                "Segment %s (in location '%s') does not appear to belong to the "
                "target location '%s' (ID: %s). Proceeding with update.",
                segment_id,
                segment_location_name,
                expected_location_name,
                location_id_str,
            )

        # Build update payload
        update_payload = {f"properties.{key}": value for key, value in updates.items()}
        update_payload["properties.manual_override"] = True
        update_payload["properties.last_manual_update"] = datetime.now(UTC)

        # Update segment
        result = await update_one_with_retry(
            self.streets_collection,
            {"_id": segment_doc["_id"]},
            {"$set": update_payload},
        )

        if result.modified_count == 0 and result.matched_count > 0:
            logger.info(
                "Segment %s already had the desired state for action '%s'.",
                segment_id,
                action_name,
            )
        elif result.matched_count == 0:
            logger.warning(
                "Segment %s with _id %s not found during update for action '%s'.",
                segment_id,
                segment_doc["_id"],
                action_name,
            )

        # Mark metadata for stats update
        await update_one_with_retry(
            self.coverage_metadata_collection,
            {"_id": obj_location_id},
            {
                "$set": {
                    "needs_stats_update": True,
                    "last_modified": datetime.now(UTC),
                },
            },
        )

        # Recalculate stats & regenerate GeoJSON (don't block response)
        try:
            await self.stats_service.recalculate_stats(obj_location_id)
            await gridfs_service.regenerate_streets_geojson(obj_location_id)
        except Exception as bg_err:
            logger.warning(
                "Post-mark background update failed for %s: %s",
                expected_location_name,
                bg_err,
            )

        return {
            "success": True,
            "message": f"Segment marked as {action_name}",
        }


class GeometryService:
    """Service for geometry operations."""

    @staticmethod
    def bbox_from_geometry(geom: dict) -> list[float]:
        """Return bounding box from GeoJSON geometry.

        Args:
            geom: GeoJSON geometry dictionary

        Returns:
            Bounding box as [min_lat, max_lat, min_lon, max_lon]

        Raises:
            HTTPException: If geometry is invalid
        """
        try:
            geom_shape = shape(geom)
            minx, miny, maxx, maxy = geom_shape.bounds
            return [miny, maxy, minx, maxx]
        except Exception as e:
            logger.error("Failed to compute bbox from geometry: %s", e)
            raise HTTPException(
                status_code=400,
                detail="Invalid geometry for bounding box computation",
            )


# Global service instances
coverage_stats_service = CoverageStatsService()
segment_marking_service = SegmentMarkingService()
geometry_service = GeometryService()
