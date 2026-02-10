"""Vector tile endpoints for trip rendering."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from trips.services.trip_tile_service import get_trip_tile, get_trip_tiles_version

logger = logging.getLogger(__name__)
router = APIRouter()


def _validate_tile_coords(z: int, x: int, y: int) -> None:
    # Keep in sync with frontend max zoom (CONFIG.MAP.maxZoom).
    if z < 0 or z > 19:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid z",
        )
    max_index = (1 << z) - 1
    if x < 0 or x > max_index or y < 0 or y > max_index:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid x/y",
        )


def _get_required_qp(request: Request, name: str) -> str:
    value = request.query_params.get(name)
    if not value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Missing query parameter: {name}",
        )
    return value


@router.get("/api/tiles/version", include_in_schema=False)
async def get_tiles_version() -> dict[str, str]:
    """Expose the current tile cache version for cache-busting client URLs."""
    return {"version": await get_trip_tiles_version()}


@router.get("/api/tiles/trips/{z}/{x}/{y}.pbf", include_in_schema=False)
async def get_trips_tile(z: int, x: int, y: int, request: Request):
    _validate_tile_coords(z, x, y)
    start_date = _get_required_qp(request, "start_date")
    end_date = _get_required_qp(request, "end_date")
    imei = request.query_params.get("imei") or None

    tile = await get_trip_tile(
        z,
        x,
        y,
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        use_matched=False,
    )

    headers = {
        "Content-Encoding": "gzip",
        "Cache-Control": f"public, max-age={tile.ttl_sec}",
        "Vary": "Accept-Encoding",
    }
    if tile.truncated:
        headers["X-ES-Tile-Truncated"] = "1"
    return Response(
        content=tile.gzipped_mvt,
        media_type="application/x-protobuf",
        headers=headers,
    )


@router.get("/api/tiles/matched_trips/{z}/{x}/{y}.pbf", include_in_schema=False)
async def get_matched_trips_tile(z: int, x: int, y: int, request: Request):
    _validate_tile_coords(z, x, y)
    start_date = _get_required_qp(request, "start_date")
    end_date = _get_required_qp(request, "end_date")
    imei = request.query_params.get("imei") or None

    tile = await get_trip_tile(
        z,
        x,
        y,
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        use_matched=True,
    )

    headers = {
        "Content-Encoding": "gzip",
        "Cache-Control": f"public, max-age={tile.ttl_sec}",
        "Vary": "Accept-Encoding",
    }
    if tile.truncated:
        headers["X-ES-Tile-Truncated"] = "1"
    return Response(
        content=tile.gzipped_mvt,
        media_type="application/x-protobuf",
        headers=headers,
    )
