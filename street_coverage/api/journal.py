"""Coverage Field Journal read APIs."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Annotated

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request, status
from starlette.responses import Response

from core.cache import cached
from db.models import CoverageArea
from street_coverage.journal import (
    get_journal_contributions,
    get_journal_payload,
    get_journal_segments,
)

router = APIRouter(prefix="/api/coverage", tags=["coverage-journal"])


@cached("coverage_journal_metadata", ttl_seconds=300)
async def _cached_journal_payload(
    area_id: PydanticObjectId,
    revision: int,
    range_key: str,
    timezone: str,
    calendar_date: str,
):
    del revision, calendar_date
    return await get_journal_payload(
        area_id,
        range_key=range_key,
        timezone=timezone,
    )


async def _ready_area(area_id: PydanticObjectId) -> CoverageArea:
    area = await CoverageArea.get(area_id)
    if area is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )
    if area.status != "ready":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Coverage area is not ready (status: {area.status})",
        )
    return area


@router.get("/areas/{area_id}/journal")
async def get_area_journal(
    area_id: PydanticObjectId,
    range_key: Annotated[str, Query(alias="range")] = "all",
    timezone: Annotated[str, Query()] = "America/Denver",
):
    area = await _ready_area(area_id)
    return await _cached_journal_payload(
        area_id,
        int(area.journal_revision or 0),
        range_key,
        timezone,
        datetime.now(UTC).date().isoformat(),
    )


@router.get("/areas/{area_id}/journal/contributions")
async def get_area_journal_contributions(
    area_id: PydanticObjectId,
    range_key: Annotated[str, Query(alias="range")] = "all",
    source: Annotated[str, Query()] = "all",
    cursor: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
):
    await _ready_area(area_id)
    return await get_journal_contributions(
        area_id,
        range_key=range_key,
        source=source,
        cursor=cursor,
        limit=limit,
    )


@router.get("/areas/{area_id}/journal/segments")
async def get_area_journal_segments(
    request: Request,
    area_id: PydanticObjectId,
    range_key: Annotated[str, Query(alias="range")] = "all",
):
    await _ready_area(area_id)
    payload, revision, area_version = await get_journal_segments(
        area_id,
        range_key=range_key,
    )
    etag_seed = (
        f"{area_id}:{area_version}:{revision}:{range_key}:"
        f"{datetime.now(UTC).date().isoformat()}"
    )
    etag = f'"{hashlib.sha256(etag_seed.encode()).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={"ETag": etag, "Cache-Control": "private, max-age=60"},
        )
    body = json.dumps(payload, separators=(",", ":"), default=str)
    return Response(
        content=body,
        media_type="application/geo+json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=60"},
    )
