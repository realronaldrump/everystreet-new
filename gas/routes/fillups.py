"""API routes for gas fill-up management."""

import logging
from typing import Any

from fastapi import APIRouter, Query

from core.api import api_route
from db.schemas import GasFillupCreateModel
from gas.services import FillupService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/gas-fillups")
@api_route(logger)
async def get_gas_fillups(
    imei: str | None = Query(None, description="Filter by vehicle IMEI"),
    vin: str | None = Query(None, description="Filter by VIN"),
    start_date: str | None = Query(None, description="Start date filter"),
    end_date: str | None = Query(None, description="End date filter"),
    limit: int = Query(100, description="Maximum number of records to return"),
) -> list[dict[str, Any]]:
    """Get gas fill-up records with optional filters."""
    fillups = await FillupService.get_fillups(imei, vin, start_date, end_date, limit)
    return [f.model_dump(by_alias=True) for f in fillups]


@router.get("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def get_gas_fillup(fillup_id: str) -> dict[str, Any]:
    """Get a specific gas fill-up by ID."""
    fillup = await FillupService.get_fillup_by_id(fillup_id)
    if not fillup:
        from core.exceptions import ResourceNotFoundException

        raise ResourceNotFoundException("Fill-up not found")
    return fillup.model_dump(by_alias=True)


@router.post("/api/gas-fillups")
@api_route(logger)
async def create_gas_fillup(
    fillup_data: GasFillupCreateModel,
) -> dict[str, Any]:
    """Create a new gas fill-up record."""
    fillup_dict = fillup_data.model_dump(exclude_none=True)
    fillup = await FillupService.create_fillup(fillup_dict)
    return fillup.model_dump(by_alias=True)


@router.put("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def update_gas_fillup(
    fillup_id: str, fillup_data: GasFillupCreateModel
) -> dict[str, Any]:
    """Update a gas fill-up record."""
    # Use exclude_unset=True to know what the user actually sent
    update_data = fillup_data.model_dump(exclude_unset=True)
    fillup = await FillupService.update_fillup(fillup_id, update_data)
    return fillup.model_dump(by_alias=True)


@router.delete("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def delete_gas_fillup(fillup_id: str) -> dict[str, str]:
    """Delete a gas fill-up record."""
    result = await FillupService.delete_fillup(fillup_id)
    return result
