"""API routes for gas fill-up management."""

import logging
from typing import Annotated

from fastapi import APIRouter, Query

from core.api import api_route
from db.models import GasFillup
from db.schemas import GasFillupCreateModel
from gas.services import FillupService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/gas-fillups")
@api_route(logger)
async def get_gas_fillups(
    imei: Annotated[str | None, Query(description="Filter by vehicle IMEI")] = None,
    vin: Annotated[str | None, Query(description="Filter by VIN")] = None,
    start_date: Annotated[str | None, Query(description="Start date filter")] = None,
    end_date: Annotated[str | None, Query(description="End date filter")] = None,
    limit: Annotated[
        int,
        Query(description="Maximum number of records to return"),
    ] = 100,
) -> list[GasFillup]:
    """Get gas fill-up records with optional filters."""
    return await FillupService.get_fillups(imei, vin, start_date, end_date, limit)


@router.get("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def get_gas_fillup(fillup_id: str) -> GasFillup:
    """Get a specific gas fill-up by ID."""
    fillup = await FillupService.get_fillup_by_id(fillup_id)
    if not fillup:
        from core.exceptions import ResourceNotFoundException

        msg = "Fill-up not found"
        raise ResourceNotFoundException(msg)
    return fillup


@router.post("/api/gas-fillups")
@api_route(logger)
async def create_gas_fillup(fillup_data: GasFillupCreateModel) -> GasFillup:
    """Create a new gas fill-up record."""
    fillup_dict = fillup_data.model_dump(exclude_none=True)
    return await FillupService.create_fillup(fillup_dict)


@router.put("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def update_gas_fillup(
    fillup_id: str,
    fillup_data: GasFillupCreateModel,
) -> GasFillup:
    """Update a gas fill-up record."""
    # Use exclude_unset=True to know what the user actually sent
    update_data = fillup_data.model_dump(exclude_unset=True)
    return await FillupService.update_fillup(fillup_id, update_data)


@router.delete("/api/gas-fillups/{fillup_id}")
@api_route(logger)
async def delete_gas_fillup(fillup_id: str) -> dict[str, str]:
    """Delete a gas fill-up record."""
    return await FillupService.delete_fillup(fillup_id)
