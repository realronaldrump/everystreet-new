"""API routes for custom place management."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from db.schemas import DestinationBloomPlaceResponse, PlaceResponse
from visits.services.place_preview_service import PlacePreviewService
from visits.services.place_service import PlaceService

logger = logging.getLogger(__name__)
router = APIRouter()


class PlaceModel(BaseModel):
    """Model for custom place data."""

    name: str
    geometry: dict[str, Any]


class PlaceUpdateModel(BaseModel):
    """Model for updating a custom place."""

    name: str | None = None
    geometry: dict[str, Any] | None = None


class DestinationBloomPlaceCreateModel(BaseModel):
    """Model for creating a place from a destination bloom cluster."""

    name: str
    transactionIds: list[str]


@router.get("/api/places", response_model=list[PlaceResponse])
async def get_places():
    """Get all custom places."""
    try:
        return await PlaceService.get_places()
    except Exception as e:
        logger.exception("Error getting places")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/places", response_model=PlaceResponse)
async def create_place(place: PlaceModel):
    """Create a new custom place."""
    try:
        return await PlaceService.create_place(place.name, place.geometry)
    except Exception as e:
        logger.exception("Error creating place")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/places/{place_id}/preview.png")
async def get_place_preview_image(
    place_id: str,
    v: str | None = None,
    theme: str = "dark",
):
    """Return the cached static map preview image for a custom place."""
    preview_theme = PlacePreviewService.normalize_theme(theme)
    preview = await PlacePreviewService.get_preview(place_id)
    theme_image = PlacePreviewService.get_theme_image(preview, preview_theme)
    if (
        preview is None
        or theme_image is None
        or (v is not None and preview.geometry_hash != v)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place preview not found",
        )

    return Response(
        content=theme_image.image_bytes,
        media_type=theme_image.content_type or "image/png",
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/api/places/previews/backfill")
async def backfill_place_previews(force: bool = False):
    """Generate missing or stale cached map previews for existing places."""
    try:
        return await PlaceService.backfill_place_previews(force=force)
    except Exception as e:
        logger.exception("Error backfilling place previews")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/api/places/{place_id}")
async def delete_place(place_id: str):
    """Delete a custom place."""
    try:
        return await PlaceService.delete_place(place_id)
    except Exception as e:
        logger.exception("Error deleting place")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.patch("/api/places/{place_id}", response_model=PlaceResponse)
async def update_place(place_id: str, update_data: PlaceUpdateModel):
    """Update a custom place (name and/or geometry)."""
    try:
        return await PlaceService.update_place(
            place_id,
            name=update_data.name,
            geometry=update_data.geometry,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Error updating place")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post(
    "/api/places/from_destination_bloom",
    response_model=DestinationBloomPlaceResponse,
)
async def create_place_from_destination_bloom(
    payload: DestinationBloomPlaceCreateModel,
):
    """Create a real Visits place from a clicked destination bloom cluster."""
    try:
        return await PlaceService.create_place_from_destination_bloom(
            payload.name,
            payload.transactionIds,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except Exception as e:
        logger.exception("Error creating place from destination bloom")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        ) from e
