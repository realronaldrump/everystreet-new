"""Manual override endpoints for coverage status.

Allows users to manually mark segments as driven/undriven/undriveable
with the changes persisting across automated updates.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from db import (
    areas_collection,
    coverage_state_collection,
    find_one_with_retry,
    update_one_with_retry,
)
from coverage_models.coverage_state import CoverageStatus, ProvenanceType
from services.coverage_service import coverage_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/areas", tags=["overrides"])


class OverrideRequest(BaseModel):
    """Request body for setting a manual override."""

    status: str  # "driven", "undriven", or "undriveable"
    note: str | None = None  # Optional user note


class BulkOverrideRequest(BaseModel):
    """Request body for bulk override operations."""

    segment_ids: list[str]
    status: str  # "driven", "undriven", or "undriveable"
    note: str | None = None


def _validate_status(status_str: str) -> CoverageStatus:
    """Validate and convert status string to CoverageStatus."""
    try:
        return CoverageStatus(status_str.lower())
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid status: {status_str}. Must be 'driven', 'undriven', or 'undriveable'",
        )


@router.post("/{area_id}/segments/{segment_id}/override")
async def set_segment_override(
    area_id: str,
    segment_id: str,
    request: OverrideRequest,
):
    """Set a manual override for a segment's coverage status.

    The override will persist across automated trip updates until
    explicitly cleared.

    Args:
        area_id: Area ID
        segment_id: Segment ID to override
        request: Override request with status and optional note

    Returns:
        Updated coverage state
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Validate status
    new_status = _validate_status(request.status)

    # Get area to verify it exists and get current version
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "display_name": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    area_version = area_doc.get("current_version", 1)

    # Check segment exists
    coverage_doc = await find_one_with_retry(
        coverage_state_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": segment_id,
        },
    )

    if not coverage_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Segment {segment_id} not found in area {area_id}",
        )

    now = datetime.now(UTC)

    # Update coverage state with manual override
    result = await update_one_with_retry(
        coverage_state_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": segment_id,
        },
        {
            "$set": {
                "status": new_status.value,
                "manual_override": True,
                "manual_override_at": now,
                "last_driven_at": now if new_status == CoverageStatus.DRIVEN else coverage_doc.get("last_driven_at"),
                "provenance": {
                    "type": ProvenanceType.MANUAL.value,
                    "trip_id": None,
                    "user_note": request.note,
                    "updated_at": now,
                },
                "updated_at": now,
            }
        },
    )

    if result.modified_count == 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update segment",
        )

    logger.info(
        "Manual override set: area=%s, segment=%s, status=%s",
        area_doc.get("display_name"),
        segment_id,
        new_status.value,
    )

    # Trigger stats recalculation in background
    try:
        await coverage_service._update_area_stats(area_id, area_version)
    except Exception as stats_err:
        logger.warning("Failed to update area stats after override: %s", stats_err)

    return {
        "success": True,
        "segment_id": segment_id,
        "status": new_status.value,
        "manual_override": True,
        "note": request.note,
    }


@router.delete("/{area_id}/segments/{segment_id}/override")
async def clear_segment_override(
    area_id: str,
    segment_id: str,
):
    """Clear a manual override, allowing automated updates again.

    The segment status is preserved, but future trip updates can
    modify it.

    Args:
        area_id: Area ID
        segment_id: Segment ID to clear override for

    Returns:
        Updated coverage state
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Get area to verify it exists and get current version
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "display_name": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    area_version = area_doc.get("current_version", 1)

    now = datetime.now(UTC)

    # Clear the manual override flag
    result = await update_one_with_retry(
        coverage_state_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": segment_id,
        },
        {
            "$set": {
                "manual_override": False,
                "updated_at": now,
            }
        },
    )

    if result.matched_count == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Segment {segment_id} not found in area {area_id}",
        )

    logger.info(
        "Manual override cleared: area=%s, segment=%s",
        area_doc.get("display_name"),
        segment_id,
    )

    return {
        "success": True,
        "segment_id": segment_id,
        "manual_override": False,
        "message": "Override cleared. Segment can now be updated by automated processes.",
    }


@router.post("/{area_id}/segments/bulk-override")
async def bulk_set_overrides(
    area_id: str,
    request: BulkOverrideRequest,
):
    """Set manual overrides for multiple segments at once.

    Args:
        area_id: Area ID
        request: Bulk override request with segment_ids, status, and optional note

    Returns:
        Summary of updated segments
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    if not request.segment_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="segment_ids cannot be empty",
        )

    if len(request.segment_ids) > 1000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot update more than 1000 segments at once",
        )

    # Validate status
    new_status = _validate_status(request.status)

    # Get area to verify it exists and get current version
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "display_name": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    area_version = area_doc.get("current_version", 1)
    now = datetime.now(UTC)

    # Bulk update
    from db import update_many_with_retry

    result = await update_many_with_retry(
        coverage_state_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": {"$in": request.segment_ids},
        },
        {
            "$set": {
                "status": new_status.value,
                "manual_override": True,
                "manual_override_at": now,
                "provenance": {
                    "type": ProvenanceType.MANUAL.value,
                    "trip_id": None,
                    "user_note": request.note,
                    "updated_at": now,
                },
                "updated_at": now,
            }
        },
    )

    # Also update last_driven_at for driven segments
    if new_status == CoverageStatus.DRIVEN:
        await update_many_with_retry(
            coverage_state_collection,
            {
                "area_id": area_oid,
                "area_version": area_version,
                "segment_id": {"$in": request.segment_ids},
            },
            {"$set": {"last_driven_at": now}},
        )

    logger.info(
        "Bulk override: area=%s, %d segments -> %s",
        area_doc.get("display_name"),
        result.modified_count,
        new_status.value,
    )

    # Trigger stats recalculation
    try:
        await coverage_service._update_area_stats(area_id, area_version)
    except Exception as stats_err:
        logger.warning("Failed to update area stats after bulk override: %s", stats_err)

    return {
        "success": True,
        "requested_count": len(request.segment_ids),
        "updated_count": result.modified_count,
        "status": new_status.value,
        "manual_override": True,
    }


@router.get("/{area_id}/segments/{segment_id}")
async def get_segment_details(
    area_id: str,
    segment_id: str,
):
    """Get detailed information about a specific segment.

    Args:
        area_id: Area ID
        segment_id: Segment ID

    Returns:
        Segment details including geometry and coverage status
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Get area
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "display_name": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    area_version = area_doc.get("current_version", 1)

    # Get street geometry
    from db import streets_v2_collection

    street_doc = await find_one_with_retry(
        streets_v2_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": segment_id,
        },
    )

    if not street_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Segment {segment_id} not found in area {area_id}",
        )

    # Get coverage state
    coverage_doc = await find_one_with_retry(
        coverage_state_collection,
        {
            "area_id": area_oid,
            "area_version": area_version,
            "segment_id": segment_id,
        },
    )

    provenance = coverage_doc.get("provenance", {}) if coverage_doc else {}

    return {
        "success": True,
        "segment": {
            "segment_id": segment_id,
            "geometry": street_doc.get("geometry"),
            "street_name": street_doc.get("street_name"),
            "highway": street_doc.get("highway"),
            "segment_length_m": street_doc.get("segment_length_m"),
            "undriveable": street_doc.get("undriveable", False),
            "osm_id": street_doc.get("osm_id"),
        },
        "coverage": {
            "status": coverage_doc.get("status", "undriven") if coverage_doc else "undriven",
            "manual_override": coverage_doc.get("manual_override", False) if coverage_doc else False,
            "last_driven_at": coverage_doc.get("last_driven_at") if coverage_doc else None,
            "provenance": {
                "type": provenance.get("type"),
                "trip_id": provenance.get("trip_id"),
                "user_note": provenance.get("user_note"),
                "updated_at": provenance.get("updated_at"),
            },
        },
    }
