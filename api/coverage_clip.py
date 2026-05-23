from fastapi import HTTPException, Request, status

from core.coverage_clip import (
    CoverageClipContext,
    CoverageClipError,
    parse_clip_bool,
    resolve_coverage_clip_context,
)
from db.models import CoverageArea


async def resolve_request_coverage_clip_context(
    request: Request,
) -> CoverageClipContext:
    clip_requested = parse_clip_bool(request.query_params.get("clip_to_coverage"))
    area_id = str(request.query_params.get("coverage_area_id") or "").strip()
    area = None
    if clip_requested and not area_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="coverage_area_id is required when clip_to_coverage is true.",
        )

    if clip_requested:
        try:
            area = await CoverageArea.get(area_id)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid coverage_area_id: {area_id}",
            ) from exc

        if area is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Coverage area not found: {area_id}",
            )

    try:
        return resolve_coverage_clip_context(
            clip_requested=clip_requested,
            area=area,
            area_id=area_id or None,
        )
    except CoverageClipError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
