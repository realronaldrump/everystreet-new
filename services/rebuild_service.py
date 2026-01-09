"""RebuildService for area rebuild and sanity check operations.

Handles:
1. Full area rebuild - re-fetch OSM, re-segment, migrate overrides
2. Sanity check - verify and repair cached stats
"""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from db import (
    aggregate_with_retry,
    areas_collection,
    coverage_state_collection,
    delete_many_with_retry,
    find_one_with_retry,
    streets_v2_collection,
    update_one_with_retry,
)
from coverage_models.area import AreaStatus
from coverage_models.coverage_state import CoverageStatus
from coverage_models.job_status import JobType
from services.coverage_service import coverage_service
from services.ingestion_service import ingestion_service
from services.job_manager import job_manager
from services.routing_service import routing_service

logger = logging.getLogger(__name__)


class RebuildService:
    """Handles area rebuild and sanity check operations."""

    async def rebuild_area(
        self,
        area_id: str,
        job_id: str,
        preserve_overrides: bool = True,
    ) -> dict[str, Any]:
        """Rebuild an area from scratch.

        This will:
        1. Increment area version
        2. Re-fetch OSM data
        3. Re-segment streets
        4. Initialize new coverage_state
        5. Optionally migrate manual overrides from previous version
        6. Delete old version data

        Args:
            area_id: Area ID to rebuild
            job_id: Job ID for progress tracking
            preserve_overrides: Whether to migrate manual overrides

        Returns:
            Dict with rebuild results
        """
        area_oid = ObjectId(area_id)
        job_oid = ObjectId(job_id)

        # Get current area state
        area_doc = await find_one_with_retry(
            areas_collection,
            {"_id": area_oid},
        )

        if not area_doc:
            await job_manager.fail_job(job_oid, "Area not found")
            return {"error": "Area not found"}

        old_version = area_doc.get("current_version", 1)
        new_version = old_version + 1
        display_name = area_doc.get("display_name", area_id)

        logger.info(
            "Starting rebuild for area %s: v%d -> v%d",
            display_name,
            old_version,
            new_version,
        )

        try:
            await job_manager.start_job(
                job_oid,
                stage="preparing",
                message=f"Preparing rebuild for {display_name}...",
            )

            # Collect manual overrides from old version if preserving
            overrides_to_migrate = []
            if preserve_overrides:
                overrides_to_migrate = await self._collect_manual_overrides(
                    area_id, old_version
                )
                logger.info(
                    "Collected %d manual overrides to migrate",
                    len(overrides_to_migrate),
                )

            await job_manager.update_job(
                job_oid,
                stage="version_bump",
                percent=10,
                message="Incrementing version...",
            )

            # Update area to new version and set status to ingesting
            await update_one_with_retry(
                areas_collection,
                {"_id": area_oid},
                {
                    "$set": {
                        "current_version": new_version,
                        "status": AreaStatus.INGESTING.value,
                        "updated_at": datetime.now(UTC),
                    }
                },
            )

            # Invalidate routing cache
            routing_service.invalidate_cache(area_id)

            await job_manager.update_job(
                job_oid,
                stage="ingesting",
                percent=20,
                message="Re-ingesting area data...",
            )

            # Run ingestion for new version
            ingest_result = await ingestion_service.ingest_area(
                area_id=area_id,
                job_id=job_id,
            )

            if "error" in ingest_result:
                # Rollback version on failure
                await update_one_with_retry(
                    areas_collection,
                    {"_id": area_oid},
                    {
                        "$set": {
                            "current_version": old_version,
                            "status": AreaStatus.ERROR.value,
                            "last_error": ingest_result["error"],
                            "updated_at": datetime.now(UTC),
                        }
                    },
                )
                await job_manager.fail_job(job_oid, ingest_result["error"])
                return ingest_result

            await job_manager.update_job(
                job_oid,
                stage="migrating_overrides",
                percent=80,
                message=f"Migrating {len(overrides_to_migrate)} manual overrides...",
            )

            # Migrate manual overrides to new version
            migrated_count = 0
            if overrides_to_migrate:
                migrated_count = await self._migrate_overrides(
                    area_id=area_id,
                    new_version=new_version,
                    overrides=overrides_to_migrate,
                )

            await job_manager.update_job(
                job_oid,
                stage="cleanup",
                percent=90,
                message="Cleaning up old version data...",
            )

            # Delete old version data
            await self._delete_version_data(area_id, old_version)

            # Recalculate stats
            await coverage_service._update_area_stats(area_id, new_version)

            await job_manager.complete_job(
                job_oid,
                message=f"Rebuild complete: v{old_version} -> v{new_version}",
                metrics={
                    "old_version": old_version,
                    "new_version": new_version,
                    "segments_created": ingest_result.get("segment_count", 0),
                    "overrides_migrated": migrated_count,
                },
            )

            logger.info(
                "Rebuild complete for area %s: v%d -> v%d, %d segments, %d overrides migrated",
                display_name,
                old_version,
                new_version,
                ingest_result.get("segment_count", 0),
                migrated_count,
            )

            return {
                "success": True,
                "old_version": old_version,
                "new_version": new_version,
                "segments_created": ingest_result.get("segment_count", 0),
                "overrides_migrated": migrated_count,
            }

        except Exception as e:
            error_msg = str(e)[:500]
            logger.exception(
                "Rebuild failed for area %s: %s",
                display_name,
                e,
            )
            await job_manager.fail_job(job_oid, error_msg)
            return {"error": error_msg}

    async def _collect_manual_overrides(
        self,
        area_id: str,
        version: int,
    ) -> list[dict[str, Any]]:
        """Collect manual overrides from a version for migration.

        Args:
            area_id: Area ID
            version: Version to collect from

        Returns:
            List of override documents with segment_id and status
        """
        area_oid = ObjectId(area_id)

        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": version,
                    "manual_override": True,
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
                                        {"$eq": ["$area_version", version]},
                                        {"$eq": ["$segment_id", "$$seg_id"]},
                                    ]
                                }
                            }
                        },
                        {"$project": {"geometry": 1, "street_name": 1}},
                    ],
                    "as": "street",
                }
            },
            {"$unwind": {"path": "$street", "preserveNullAndEmptyArrays": True}},
            {
                "$project": {
                    "segment_id": 1,
                    "status": 1,
                    "provenance": 1,
                    "geometry": "$street.geometry",
                    "street_name": "$street.street_name",
                }
            },
        ]

        return await aggregate_with_retry(coverage_state_collection, pipeline)

    async def _migrate_overrides(
        self,
        area_id: str,
        new_version: int,
        overrides: list[dict[str, Any]],
    ) -> int:
        """Migrate manual overrides to new version by geometry matching.

        Args:
            area_id: Area ID
            new_version: New version to migrate to
            overrides: List of override documents to migrate

        Returns:
            Number of successfully migrated overrides
        """
        area_oid = ObjectId(area_id)
        migrated_count = 0
        now = datetime.now(UTC)

        for override in overrides:
            geometry = override.get("geometry")
            if not geometry:
                continue

            # Find matching segment in new version by geometry intersection
            # Use a tight buffer to find the closest match
            pipeline = [
                {
                    "$match": {
                        "area_id": area_oid,
                        "area_version": new_version,
                        "geometry": {
                            "$geoIntersects": {
                                "$geometry": geometry,
                            }
                        },
                    }
                },
                {"$limit": 1},
                {"$project": {"segment_id": 1}},
            ]

            matches = await aggregate_with_retry(streets_v2_collection, pipeline)

            if matches:
                new_segment_id = matches[0]["segment_id"]

                # Update the coverage_state for the matched segment
                await update_one_with_retry(
                    coverage_state_collection,
                    {
                        "area_id": area_oid,
                        "area_version": new_version,
                        "segment_id": new_segment_id,
                    },
                    {
                        "$set": {
                            "status": override.get("status", CoverageStatus.DRIVEN.value),
                            "manual_override": True,
                            "manual_override_at": now,
                            "provenance": override.get("provenance", {}),
                            "updated_at": now,
                        }
                    },
                )
                migrated_count += 1

        return migrated_count

    async def _delete_version_data(
        self,
        area_id: str,
        version: int,
    ) -> None:
        """Delete all data for an old version.

        Args:
            area_id: Area ID
            version: Version to delete
        """
        area_oid = ObjectId(area_id)

        # Delete streets
        await delete_many_with_retry(
            streets_v2_collection,
            {"area_id": area_oid, "area_version": version},
        )

        # Delete coverage_state
        await delete_many_with_retry(
            coverage_state_collection,
            {"area_id": area_oid, "area_version": version},
        )

        logger.info("Deleted version %d data for area %s", version, area_id)

    async def sanity_check_area(
        self,
        area_id: str,
        job_id: str,
        repair: bool = True,
    ) -> dict[str, Any]:
        """Run sanity check on an area's coverage data.

        Checks for and optionally repairs:
        1. Orphaned coverage_state records (no matching street)
        2. Missing coverage_state records (street without coverage)
        3. Stats drift (cached_stats don't match actual data)

        Args:
            area_id: Area ID to check
            job_id: Job ID for progress tracking
            repair: Whether to repair issues found

        Returns:
            Dict with check results
        """
        area_oid = ObjectId(area_id)
        job_oid = ObjectId(job_id)

        # Get area
        area_doc = await find_one_with_retry(
            areas_collection,
            {"_id": area_oid},
        )

        if not area_doc:
            await job_manager.fail_job(job_oid, "Area not found")
            return {"error": "Area not found"}

        area_version = area_doc.get("current_version", 1)
        display_name = area_doc.get("display_name", area_id)

        logger.info("Starting sanity check for area %s (v%d)", display_name, area_version)

        try:
            await job_manager.start_job(
                job_oid,
                stage="checking_orphans",
                message="Checking for orphaned coverage records...",
            )

            issues = {
                "orphaned_coverage": 0,
                "missing_coverage": 0,
                "stats_drift": False,
            }
            repairs = {
                "orphans_deleted": 0,
                "coverage_created": 0,
                "stats_updated": False,
            }

            # Check for orphaned coverage_state (coverage without street)
            orphan_pipeline = [
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
                            {"$project": {"_id": 1}},
                        ],
                        "as": "street",
                    }
                },
                {"$match": {"street": {"$size": 0}}},
                {"$project": {"segment_id": 1}},
            ]

            orphaned = await aggregate_with_retry(coverage_state_collection, orphan_pipeline)
            issues["orphaned_coverage"] = len(orphaned)

            if repair and orphaned:
                orphan_ids = [doc["segment_id"] for doc in orphaned]
                result = await delete_many_with_retry(
                    coverage_state_collection,
                    {
                        "area_id": area_oid,
                        "area_version": area_version,
                        "segment_id": {"$in": orphan_ids},
                    },
                )
                repairs["orphans_deleted"] = result.deleted_count

            await job_manager.update_job(
                job_oid,
                stage="checking_missing",
                percent=40,
                message="Checking for missing coverage records...",
            )

            # Check for missing coverage_state (street without coverage)
            missing_pipeline = [
                {
                    "$match": {
                        "area_id": area_oid,
                        "area_version": area_version,
                    }
                },
                {
                    "$lookup": {
                        "from": "coverage_state",
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
                            {"$project": {"_id": 1}},
                        ],
                        "as": "coverage",
                    }
                },
                {"$match": {"coverage": {"$size": 0}}},
                {"$project": {"segment_id": 1, "undriveable": 1}},
            ]

            missing = await aggregate_with_retry(streets_v2_collection, missing_pipeline)
            issues["missing_coverage"] = len(missing)

            if repair and missing:
                from db import insert_many_with_retry

                now = datetime.now(UTC)
                new_coverage_docs = []
                for doc in missing:
                    status = (
                        CoverageStatus.UNDRIVEABLE.value
                        if doc.get("undriveable")
                        else CoverageStatus.UNDRIVEN.value
                    )
                    new_coverage_docs.append(
                        {
                            "area_id": area_oid,
                            "area_version": area_version,
                            "segment_id": doc["segment_id"],
                            "status": status,
                            "last_driven_at": None,
                            "provenance": {
                                "type": "sanity_check",
                                "trip_id": None,
                                "user_note": "Created by sanity check repair",
                                "updated_at": now,
                            },
                            "manual_override": False,
                            "updated_at": now,
                            "created_at": now,
                        }
                    )

                if new_coverage_docs:
                    await insert_many_with_retry(coverage_state_collection, new_coverage_docs)
                    repairs["coverage_created"] = len(new_coverage_docs)

            await job_manager.update_job(
                job_oid,
                stage="checking_stats",
                percent=70,
                message="Checking cached statistics...",
            )

            # Check stats drift
            current_stats = await coverage_service._update_area_stats(area_id, area_version)
            cached_stats = area_doc.get("cached_stats", {})

            # Compare key metrics
            if (
                cached_stats.get("total_segments") != current_stats.total_segments
                or cached_stats.get("covered_segments") != current_stats.covered_segments
                or abs(cached_stats.get("coverage_percentage", 0) - current_stats.coverage_percentage) > 0.1
            ):
                issues["stats_drift"] = True
                repairs["stats_updated"] = True  # _update_area_stats already fixed it

            await job_manager.complete_job(
                job_oid,
                message=f"Sanity check complete. Issues: {sum(1 for v in issues.values() if v)}",
                metrics={
                    "issues": issues,
                    "repairs": repairs if repair else None,
                },
            )

            logger.info(
                "Sanity check complete for area %s: issues=%s, repairs=%s",
                display_name,
                issues,
                repairs,
            )

            return {
                "success": True,
                "area_id": area_id,
                "version": area_version,
                "issues": issues,
                "repairs": repairs if repair else None,
            }

        except Exception as e:
            error_msg = str(e)[:500]
            logger.exception("Sanity check failed for area %s: %s", display_name, e)
            await job_manager.fail_job(job_oid, error_msg)
            return {"error": error_msg}

    async def sanity_check_all_areas(self, repair: bool = True) -> dict[str, Any]:
        """Run sanity check on all areas.

        Args:
            repair: Whether to repair issues found

        Returns:
            Summary of checks across all areas
        """
        # Get all ready areas
        pipeline = [
            {"$match": {"status": AreaStatus.READY.value}},
            {"$project": {"_id": 1, "display_name": 1}},
        ]

        areas = await aggregate_with_retry(areas_collection, pipeline)

        results = []
        for area_doc in areas:
            area_id = str(area_doc["_id"])

            # Create job for each check
            job = await job_manager.create_job(
                job_type=JobType.SANITY_CHECK,
                area_id=area_id,
            )

            result = await self.sanity_check_area(
                area_id=area_id,
                job_id=str(job.id),
                repair=repair,
            )

            results.append(
                {
                    "area_id": area_id,
                    "display_name": area_doc.get("display_name"),
                    "result": result,
                }
            )

        # Summarize
        total_issues = sum(
            sum(1 for v in r["result"].get("issues", {}).values() if v)
            for r in results
            if "error" not in r["result"]
        )

        return {
            "success": True,
            "areas_checked": len(results),
            "total_issues_found": total_issues,
            "results": results,
        }


# Singleton instance
rebuild_service = RebuildService()
