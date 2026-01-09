"""API routes for gas fill-up management."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from db import serialize_document
from gas.services import FillupService
from models import GasFillupCreateModel

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/gas-fillups")
async def get_gas_fillups(
    imei: str | None = Query(None, description="Filter by vehicle IMEI"),
    vin: str | None = Query(None, description="Filter by VIN"),
    start_date: str | None = Query(None, description="Start date filter"),
    end_date: str | None = Query(None, description="End date filter"),
    limit: int = Query(100, description="Maximum number of records to return"),
) -> list[dict[str, Any]]:
    """Get gas fill-up records with optional filters."""
    try:
        fillups = await FillupService.get_fillups(
            imei, vin, start_date, end_date, limit
        )
        return [serialize_document(f) for f in fillups]

    except Exception as e:
        logger.error("Error fetching gas fillups: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/gas-fillups/{fillup_id}")
async def get_gas_fillup(fillup_id: str) -> dict[str, Any]:
    """Get a specific gas fill-up by ID."""
    try:
        fillup = await FillupService.get_fillup_by_id(fillup_id)
        if not fillup:
            raise HTTPException(status_code=404, detail="Fill-up not found")
        return serialize_document(fillup)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error fetching gas fillup: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/gas-fillups")
async def create_gas_fillup(
    fillup_data: GasFillupCreateModel,
) -> dict[str, Any]:
    """Create a new gas fill-up record."""
    try:
        fillup_dict = fillup_data.model_dump(exclude_none=True)
        fillup = await FillupService.create_fillup(fillup_dict)
        return serialize_document(fillup)

    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error creating gas fillup: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/api/gas-fillups/{fillup_id}")
async def update_gas_fillup(
    fillup_id: str, fillup_data: GasFillupCreateModel
) -> dict[str, Any]:
    """Update a gas fill-up record."""
    try:
        # Use exclude_unset=True to know what the user actually sent
        update_data = fillup_data.model_dump(exclude_unset=True)
        fillup = await FillupService.update_fillup(fillup_id, update_data)
        return serialize_document(fillup)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Error updating gas fillup: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/api/gas-fillups/{fillup_id}")
async def delete_gas_fillup(fillup_id: str) -> dict[str, str]:
    """Delete a gas fill-up record."""
    try:
        result = await FillupService.delete_fillup(fillup_id)
        return result

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error("Error deleting gas fillup: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))
