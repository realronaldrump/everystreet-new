from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from core.api import api_route
from setup.services.setup_service import (
    SetupService,
    SetupSessionAdvanceRequest,
    SetupSessionClaimRequest,
    SetupSessionRequest,
    SetupSessionStepRunRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["setup"])


@router.get("/setup/status", response_model=dict[str, Any])
@api_route(logger)
async def get_setup_status_endpoint() -> dict[str, Any]:
    """Return overall setup completion status and step details."""
    return await SetupService.get_setup_status()


@router.post("/setup/session", response_model=dict[str, Any])
@api_route(logger)
async def create_or_resume_setup_session(
    payload: SetupSessionRequest,
) -> dict[str, Any]:
    """Create or resume the setup session."""
    return await SetupService.create_or_resume_setup_session(payload)


@router.get("/setup/session", response_model=dict[str, Any])
@api_route(logger)
async def get_setup_session(client_id: str | None = None) -> dict[str, Any]:
    """Return the current setup session payload."""
    return await SetupService.get_setup_session(client_id)


@router.get("/setup/session/{session_id}", response_model=dict[str, Any])
@api_route(logger)
async def get_setup_session_by_id(
    session_id: str,
    client_id: str | None = None,
) -> dict[str, Any]:
    """Return a specific setup session by ID."""
    return await SetupService.get_setup_session_by_id(session_id, client_id)


@router.post("/setup/session/{session_id}/claim", response_model=dict[str, Any])
@api_route(logger)
async def claim_setup_session(
    session_id: str,
    payload: SetupSessionClaimRequest,
) -> dict[str, Any]:
    """Claim the setup session for the current client."""
    return await SetupService.claim_setup_session(session_id, payload)


@router.post("/setup/session/{session_id}/advance", response_model=dict[str, Any])
@api_route(logger)
async def advance_setup_session(
    session_id: str,
    payload: SetupSessionAdvanceRequest,
) -> dict[str, Any]:
    """Advance the setup flow to the next step."""
    return await SetupService.advance_setup_session(session_id, payload)


@router.post(
    "/setup/session/{session_id}/step/{step_id}/run",
    response_model=dict[str, Any],
)
@api_route(logger)
async def run_setup_step(
    session_id: str,
    step_id: str,
    payload: SetupSessionStepRunRequest,
) -> dict[str, Any]:
    """Run an individual setup step and return status."""
    return await SetupService.run_setup_step(session_id, step_id, payload)


@router.post("/setup/session/{session_id}/cancel", response_model=dict[str, Any])
@api_route(logger)
async def cancel_setup_session(
    session_id: str,
    client_id: str | None = None,
) -> dict[str, Any]:
    """Cancel the setup session."""
    return await SetupService.cancel_setup_session(session_id, client_id)


@router.post("/setup/complete", response_model=dict[str, Any])
@api_route(logger)
async def complete_setup() -> dict[str, Any]:
    """Finalize setup and enable background tasks."""
    return await SetupService.complete_setup()


@router.post("/setup/auto-configure-region", response_model=dict[str, Any])
@api_route(logger)
async def auto_configure_region() -> dict[str, Any]:
    """Auto-configure the map region based on trip history."""
    return await SetupService.auto_configure_region()
