"""API routes for custom place management."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from visits.services import PlaceService

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


@router.get("/api/places")
async def get_places():
    """Get all custom places."""
    try:
        return await PlaceService.get_places()
    except Exception as e:
        logger.exception("Error getting places: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/places")
async def create_place(place: PlaceModel):
    """Create a new custom place."""
    try:
        return await PlaceService.create_place(place.name, place.geometry)
    except Exception as e:
        logger.exception("Error creating place: %s", e)
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
        logger.exception("Error deleting place: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.patch("/api/places/{place_id}")
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
        logger.exception("Error updating place: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
