"""Coverage Field Journal read APIs."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Annotated
from zoneinfo import ZoneInfo

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request, status
from starlette.responses import Response

from core.cache import cached
from db.models import CoverageArea
from street_coverage.journal import (
    JournalPending,
    get_journal_contributions,
    get_journal_payload,
    get_journal_segments,
    ensure_journal_rollup,
    normalize_timezone,
)

router = APIRouter(prefix="/api/coverage", tags=["coverage-journal"])


@cached("coverage_journal_metadata", ttl_seconds=300)
async def _cached_journal_payload(
    area_id: PydanticObjectId,
    revision: str,
    range_key: str,
    timezone: str,
    calendar_date: str,
):
    del revision, calendar_date
    try:
        return await get_journal_payload(
            area_id, range_key=range_key, timezone=timezone
        )
    except JournalPending as exc:
        raise HTTPException(409, str(exc), headers={"Retry-After": "2"}) from exc


async def _ready_area(area_id: PydanticObjectId) -> CoverageArea:
    area = await CoverageArea.get(area_id)
    if area is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )
    if area.status != "ready" and area.total_segments == 0:
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
    try:
        rollup = await ensure_journal_rollup(area_id)
    except JournalPending as exc:
        raise HTTPException(409, str(exc), headers={"Retry-After": "2"}) from exc
    return await _cached_journal_payload(
        area_id,
        f"{area.journal_revision}:{rollup.revision}",
        range_key,
        timezone,
        datetime.now(ZoneInfo(normalize_timezone(timezone))).date().isoformat(),
    )


@router.get("/areas/{area_id}/journal/contributions")
async def get_area_journal_contributions(
    area_id: PydanticObjectId,
    range_key: Annotated[str, Query(alias="range")] = "all",
    source: Annotated[str, Query()] = "all",
    cursor: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    timezone: str = "America/Denver",
):
    await _ready_area(area_id)
    try:
        return await get_journal_contributions(
            area_id,
            range_key=range_key,
            source=source,
            cursor=cursor,
            limit=limit,
            timezone=timezone,
        )
    except JournalPending as exc:
        raise HTTPException(409, str(exc), headers={"Retry-After": "2"}) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/areas/{area_id}/journal/segments")
async def get_area_journal_segments(
    request: Request,
    area_id: PydanticObjectId,
    range_key: Annotated[str, Query(alias="range")] = "all",
    min_lon: float | None = None,
    min_lat: float | None = None,
    max_lon: float | None = None,
    max_lat: float | None = None,
    ids: Annotated[list[str] | None, Query(max_length=300)] = None,
    street_name: Annotated[str | None, Query(max_length=200)] = None,
    timezone: str = "America/Denver",
):
    await _ready_area(area_id)
    bounds = None
    if any(value is not None for value in (min_lon, min_lat, max_lon, max_lat)):
        from street_coverage.api.streets import viewport_polygon

        if any(value is None for value in (min_lon, min_lat, max_lon, max_lat)):
            raise HTTPException(422, "Provide all four viewport bounds")
        viewport_polygon(min_lon, min_lat, max_lon, max_lat)
        bounds = (min_lon, min_lat, max_lon, max_lat)
    try:
        rollup = await ensure_journal_rollup(area_id)
    except JournalPending as exc:
        raise HTTPException(409, str(exc), headers={"Retry-After": "2"}) from exc
    day = datetime.now(ZoneInfo(normalize_timezone(timezone))).date()
    seed = f"{area_id}:{rollup.area_version}:{rollup.revision}:{range_key}:{bounds}:{ids}:{street_name}:{timezone}:{day}"
    etag = f'"{hashlib.sha256(seed.encode()).hexdigest()[:24]}"'
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Cache-Control": "private, max-age=0, must-revalidate",
            },
        )
    try:
        payload, revision, area_version = await get_journal_segments(
            area_id,
            range_key=range_key,
            bounds=bounds,
            segment_ids=ids,
            street_name=street_name,
            timezone=timezone,
        )
    except JournalPending as exc:
        raise HTTPException(409, str(exc), headers={"Retry-After": "2"}) from exc
    if revision != rollup.revision or area_version != rollup.area_version:
        raise HTTPException(
            409, "Journal updated during this request. Refresh the view."
        )
    return Response(
        json.dumps(payload, separators=(",", ":"), default=str),
        media_type="application/geo+json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=0, must-revalidate"},
    )
