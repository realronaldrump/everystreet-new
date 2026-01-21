"""Setup and status endpoints for first-run configuration."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from beanie import PydanticObjectId
from fastapi import HTTPException, status
from pydantic import BaseModel, Field

from config import validate_mapbox_token
from core.service_config import clear_config_cache, get_service_config
from db.models import (
    AppSettings,
    MapDataJob,
    MapRegion,
    SetupSession,
    SetupStepState,
    TaskConfig,
    TaskHistory,
)
from map_data.services import (
    check_service_health,
    download_and_build_all,
    suggest_region_from_first_trip,
)
from setup.services.bouncie_credentials import get_bouncie_credentials
from tasks.arq import get_arq_pool
from tasks.config import set_global_disable
from tasks.ops import enqueue_task

logger = logging.getLogger(__name__)

SETUP_SCOPE_KEY = "default"
SETUP_STEP_KEYS = ["welcome", "bouncie", "mapbox", "region", "complete"]
REQUIRED_STEPS = ["bouncie", "mapbox"]
ACTIVE_CLIENT_STALE_SECONDS = 45
# Start at bouncie step by default (skip welcome)
DEFAULT_START_STEP = "bouncie"


class SetupSessionRequest(BaseModel):
    client_id: str | None = None


class SetupSessionAdvanceRequest(BaseModel):
    client_id: str | None = None
    current_step: str
    next_step: str
    version: int
    idempotency_key: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SetupSessionStepRunRequest(BaseModel):
    client_id: str | None = None
    version: int
    idempotency_key: str | None = None
    mode: str = "download"
    region: dict[str, Any] | None = None


class SetupSessionClaimRequest(BaseModel):
    client_id: str | None = None
    force: bool = False


async def _get_or_create_settings() -> AppSettings:
    settings = await AppSettings.find_one()
    if not settings:
        settings = AppSettings()
        await settings.insert()
    return settings


def _normalize_devices(devices: Any) -> list[str]:
    if isinstance(devices, list):
        return [str(device).strip() for device in devices if str(device).strip()]
    if isinstance(devices, str):
        return [device.strip() for device in devices.split(",") if device.strip()]
    return []


async def get_setup_status() -> dict[str, Any]:
    settings = await _get_or_create_settings()
    credentials = await get_bouncie_credentials()

    bouncie_missing = []
    for field in ["client_id", "client_secret", "redirect_uri"]:
        if not credentials.get(field):
            bouncie_missing.append(field)

    devices = _normalize_devices(credentials.get("authorized_devices"))
    if not devices:
        bouncie_missing.append("authorized_devices")

    bouncie_complete = len(bouncie_missing) == 0

    mapbox_token = (await get_service_config()).mapbox_token or ""
    mapbox_complete = False
    mapbox_error = None
    if mapbox_token:
        try:
            validate_mapbox_token(mapbox_token)
        except RuntimeError as exc:
            mapbox_error = str(exc)
        else:
            mapbox_complete = True

    region_count = await MapRegion.find_all().count()
    region_complete = region_count > 0

    geo_health = await check_service_health()
    geo_services = {
        "nominatim": {
            "container_running": geo_health.nominatim_container_running,
            "has_data": geo_health.nominatim_has_data,
            "ready": geo_health.nominatim_healthy,
        },
        "valhalla": {
            "container_running": geo_health.valhalla_container_running,
            "has_data": geo_health.valhalla_has_data,
            "ready": geo_health.valhalla_healthy,
        },
    }

    return {
        "setup_completed": bool(settings.setup_completed),
        "setup_completed_at": (
            settings.setup_completed_at.isoformat()
            if settings.setup_completed_at
            else None
        ),
        "required_complete": bouncie_complete and mapbox_complete,
        "steps": {
            "bouncie": {
                "complete": bouncie_complete,
                "missing": bouncie_missing,
                "required": True,
            },
            "mapbox": {
                "complete": mapbox_complete,
                "missing": ["mapbox_token"] if not mapbox_complete else [],
                "error": mapbox_error,
                "required": True,
            },
            "region": {
                "complete": region_complete,
                "required": False,
            },
        },
        "geo_services": geo_services,
    }


async def get_setup_status_endpoint() -> dict[str, Any]:
    return await get_setup_status()


def _step_index(step: str) -> int:
    try:
        return SETUP_STEP_KEYS.index(step)
    except ValueError:
        return -1


def _default_step_states() -> dict[str, SetupStepState]:
    return {key: SetupStepState() for key in SETUP_STEP_KEYS}


def _clone_step_states(session: SetupSession) -> dict[str, SetupStepState]:
    step_states = {}
    existing = session.step_states or {}
    for key in SETUP_STEP_KEYS:
        current = existing.get(key)
        if current is None:
            step_states[key] = SetupStepState()
        else:
            step_states[key] = current.model_copy(deep=True)
    return step_states


def _is_client_stale(last_seen: datetime | None, now: datetime) -> bool:
    if not last_seen:
        return True
    # Ensure last_seen is timezone-aware (MongoDB may store naive datetimes)
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=UTC)
    return (now - last_seen) > timedelta(seconds=ACTIVE_CLIENT_STALE_SECONDS)


def _first_incomplete_required(status_payload: dict[str, Any]) -> str | None:
    for step_key in REQUIRED_STEPS:
        if not status_payload.get("steps", {}).get(step_key, {}).get("complete"):
            return step_key
    return None


def _mark_step_complete(step_state: SetupStepState, now: datetime) -> None:
    step_state.status = "completed"
    step_state.progress = 100.0
    step_state.in_flight = False
    step_state.interruptible = True
    step_state.last_error = None
    if step_state.completed_at is None:
        step_state.completed_at = now


def _mark_step_in_progress(step_state: SetupStepState) -> None:
    if step_state.status not in {"completed", "error"}:
        step_state.status = "in_progress"


def _mark_step_idle(step_state: SetupStepState) -> None:
    if step_state.status not in {"completed", "error"}:
        step_state.status = "not_started"
        step_state.in_flight = False
        step_state.interruptible = True


async def _touch_session(
    session: SetupSession,
    client_id: str | None,
    now: datetime,
) -> None:
    session.last_seen_at = now
    session.updated_at = now
    if client_id:
        if session.active_client_id is None:
            session.active_client_id = client_id
            session.active_client_last_seen_at = now
        elif session.active_client_id == client_id:
            session.active_client_last_seen_at = now
    await session.save()


async def _get_or_create_setup_session(client_id: str | None) -> SetupSession:
    session = await SetupSession.find_one(SetupSession.scope_key == SETUP_SCOPE_KEY)
    now = datetime.now(UTC)
    if not session:
        session = SetupSession(
            scope_key=SETUP_SCOPE_KEY,
            status="not_started",
            current_step=DEFAULT_START_STEP,
            step_states=_default_step_states(),
            created_at=now,
            updated_at=now,
            active_client_id=client_id,
            active_client_last_seen_at=now if client_id else None,
        )
        await session.insert()
    await _touch_session(session, client_id, now)
    return session


async def _fetch_session(session_id: str) -> SetupSession | None:
    try:
        return await SetupSession.get(PydanticObjectId(session_id))
    except Exception:
        return None


def _require_client_id(client_id: str | None) -> str:
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "client_id is required", "code": "missing_client"},
        )
    return client_id


def _assert_session_owner(session: SetupSession, client_id: str) -> None:
    if session.active_client_id and session.active_client_id != client_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup session is active in another tab.",
                "code": "session_locked",
                "active_client_id": session.active_client_id,
            },
        )


def _assert_version(session: SetupSession, version: int) -> None:
    if session.version != version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup session is out of date. Refresh to continue.",
                "code": "stale_version",
                "expected_version": session.version,
            },
        )


def _assert_session_active(session: SetupSession) -> None:
    if session.status == "completed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup is already completed.",
                "code": "setup_completed",
            },
        )
    if session.status == "cancelled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup session is cancelled.",
                "code": "setup_cancelled",
            },
        )


def _assert_no_in_flight(session: SetupSession) -> None:
    step_states = session.step_states or {}
    for state in step_states.values():
        if state.in_flight or state.interruptible is False:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": "A setup step is currently running.",
                    "code": "step_in_flight",
                },
            )


async def _build_session_payload(
    session: SetupSession,
    client_id: str | None,
) -> dict[str, Any]:
    now = datetime.now(UTC)
    status_payload = await get_setup_status()
    step_states = _clone_step_states(session)

    if session.current_step not in SETUP_STEP_KEYS:
        session.current_step = DEFAULT_START_STEP
        session.updated_at = now
        await session.save()

    first_required = _first_incomplete_required(status_payload)
    if first_required and _step_index(session.current_step) > _step_index(
        first_required,
    ):
        session.current_step = first_required
        session.updated_at = now
        await session.save()

    if status_payload.get("setup_completed") and session.status != "completed":
        session.status = "completed"
        session.current_step = "complete"
        session.completed_at = now
        session.updated_at = now
        session.step_states = session.step_states or _default_step_states()
        _mark_step_complete(session.step_states["complete"], now)
        session.version += 1
        await session.save()

    current_step = session.current_step

    welcome_state = step_states["welcome"]
    if current_step != "welcome":
        _mark_step_complete(welcome_state, now)
    else:
        _mark_step_in_progress(welcome_state)

    bouncie_state = step_states["bouncie"]
    bouncie_status = status_payload.get("steps", {}).get("bouncie", {})
    bouncie_state.metadata["missing"] = bouncie_status.get("missing", [])
    if bouncie_status.get("complete"):
        _mark_step_complete(bouncie_state, now)
    else:
        if bouncie_status.get("missing"):
            bouncie_state.last_error = "Missing: " + ", ".join(
                bouncie_state.metadata["missing"],
            )
        if current_step == "bouncie":
            _mark_step_in_progress(bouncie_state)
        else:
            _mark_step_idle(bouncie_state)

    mapbox_state = step_states["mapbox"]
    mapbox_status = status_payload.get("steps", {}).get("mapbox", {})
    mapbox_state.metadata["missing"] = mapbox_status.get("missing", [])
    mapbox_state.metadata["error"] = mapbox_status.get("error")
    if mapbox_status.get("complete"):
        _mark_step_complete(mapbox_state, now)
    elif mapbox_status.get("error"):
        mapbox_state.last_error = mapbox_status.get("error")
        mapbox_state.status = "blocked"
    elif current_step == "mapbox":
        _mark_step_in_progress(mapbox_state)
    else:
        _mark_step_idle(mapbox_state)

    region_state = step_states["region"]
    region_status = status_payload.get("steps", {}).get("region", {})
    region_state.metadata.setdefault("required", False)
    region_state.metadata.setdefault("skipped", False)
    job_id = region_state.metadata.get("job_id")
    if job_id:
        job = None
        try:
            job = await MapDataJob.get(PydanticObjectId(job_id))
        except Exception:
            job = None
        if job:
            job_payload = {
                "id": str(job.id),
                "status": job.status,
                "stage": job.stage,
                "progress": float(job.progress or 0),
                "message": job.message,
                "error": job.error,
            }
            region_state.metadata["job_status"] = job_payload
            region_state.progress = job_payload["progress"]
            region_state.in_flight = job.is_active
            region_state.interruptible = not job.is_active
            stored_region = (
                session.step_states.get("region") if session.step_states else None
            )
            if stored_region and stored_region.in_flight and not job.is_active:
                stored_region.in_flight = False
                stored_region.interruptible = True
                stored_region.updated_at = now
                if job.status == "completed" and region_status.get("complete"):
                    _mark_step_complete(stored_region, now)
                elif job.status == "failed":
                    stored_region.status = "error"
                    stored_region.last_error = job.error or "Region setup failed."
                    stored_region.last_error_at = now
                elif job.status == "cancelled":
                    stored_region.status = "blocked"
                    stored_region.last_error = job.error or "Region setup cancelled."
                    stored_region.last_error_at = now
                session.updated_at = now
                session.version += 1
                await session.save()
            if job.status in {"failed", "cancelled"}:
                region_state.status = "error" if job.status == "failed" else "blocked"
                region_state.last_error = job.error or "Region setup halted."
            elif job.status == "completed":
                if region_status.get("complete"):
                    _mark_step_complete(region_state, now)
                else:
                    _mark_step_in_progress(region_state)
            else:
                _mark_step_in_progress(region_state)
        else:
            region_state.metadata.pop("job_status", None)
            region_state.in_flight = False
            region_state.interruptible = True

    if region_status.get("complete"):
        _mark_step_complete(region_state, now)
    elif region_state.metadata.get("skipped") and not region_state.in_flight:
        region_state.status = "skipped"
        region_state.progress = 0.0
    elif current_step == "region" and not region_state.in_flight:
        _mark_step_in_progress(region_state)
    elif not region_state.in_flight:
        _mark_step_idle(region_state)

    complete_state = step_states["complete"]
    if status_payload.get("setup_completed"):
        _mark_step_complete(complete_state, now)
    elif current_step == "complete":
        _mark_step_in_progress(complete_state)
    else:
        _mark_step_idle(complete_state)

    owner_is_stale = _is_client_stale(session.active_client_last_seen_at, now)
    is_owner = client_id is not None and session.active_client_id == client_id
    client_payload = {
        "id": client_id,
        "is_owner": is_owner,
        "owner_id": session.active_client_id,
        "owner_last_seen_at": (
            session.active_client_last_seen_at.isoformat()
            if session.active_client_last_seen_at
            else None
        ),
        "owner_is_stale": owner_is_stale,
    }

    session_payload = session.model_dump()
    session_payload["id"] = str(session.id)
    session_payload["step_states"] = {
        key: state.model_dump() for key, state in step_states.items()
    }

    return {
        "session": session_payload,
        "setup_status": status_payload,
        "client": client_payload,
        "server_time": now.isoformat(),
    }


async def create_or_resume_setup_session(
    payload: SetupSessionRequest,
) -> dict[str, Any]:
    session = await _get_or_create_setup_session(payload.client_id)
    return await _build_session_payload(session, payload.client_id)


async def get_setup_session(client_id: str | None = None) -> dict[str, Any]:
    session = await _get_or_create_setup_session(client_id)
    return await _build_session_payload(session, client_id)


async def get_setup_session_by_id(
    session_id: str,
    client_id: str | None = None,
) -> dict[str, Any]:
    session = await _fetch_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Setup session not found")
    await _touch_session(session, client_id, datetime.now(UTC))
    return await _build_session_payload(session, client_id)


async def claim_setup_session(
    session_id: str,
    payload: SetupSessionClaimRequest,
) -> dict[str, Any]:
    client_id = _require_client_id(payload.client_id)
    session = await _fetch_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Setup session not found")

    now = datetime.now(UTC)
    owner_stale = _is_client_stale(session.active_client_last_seen_at, now)
    if session.active_client_id and session.active_client_id != client_id:
        if not owner_stale and not payload.force:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "message": "Another tab is actively running setup.",
                    "code": "session_locked",
                    "active_client_id": session.active_client_id,
                },
            )

    session.active_client_id = client_id
    session.active_client_last_seen_at = now
    session.updated_at = now
    session.version += 1
    await session.save()
    return await _build_session_payload(session, client_id)


async def advance_setup_session(
    session_id: str,
    payload: SetupSessionAdvanceRequest,
) -> dict[str, Any]:
    client_id = _require_client_id(payload.client_id)
    session = await _fetch_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Setup session not found")

    _assert_session_owner(session, client_id)
    _assert_session_active(session)

    if payload.idempotency_key:
        last_key = session.idempotency_keys.get("advance")
        if last_key == payload.idempotency_key:
            return await _build_session_payload(session, client_id)

    _assert_version(session, payload.version)
    _assert_no_in_flight(session)

    if payload.current_step != session.current_step:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup session step is out of date.",
                "code": "step_mismatch",
                "expected_step": session.current_step,
            },
        )

    if payload.next_step not in SETUP_STEP_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Invalid step", "code": "invalid_step"},
        )

    current_index = _step_index(session.current_step)
    next_index = _step_index(payload.next_step)
    if next_index < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Invalid step", "code": "invalid_step"},
        )
    if next_index > current_index + 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "Setup steps must be completed in order.",
                "code": "invalid_transition",
            },
        )

    status_payload = await get_setup_status()
    if payload.next_step == "complete" and not status_payload.get("required_complete"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": "Complete required steps before finishing setup.",
                "code": "required_steps_missing",
            },
        )

    session.step_states = session.step_states or _default_step_states()
    now = datetime.now(UTC)
    if session.active_client_id is None:
        session.active_client_id = client_id
        session.active_client_last_seen_at = now
    moving_forward = next_index > current_index
    if moving_forward and session.current_step in session.step_states:
        _mark_step_complete(session.step_states[session.current_step], now)

    if payload.metadata.get("region_skipped"):
        session.step_states["region"].metadata["skipped"] = True
        session.step_states["region"].status = "skipped"

    session.current_step = payload.next_step
    if session.status == "not_started" and session.current_step != "welcome":
        session.status = "in_progress"
        session.started_at = now
    session.active_client_last_seen_at = now
    session.idempotency_keys["advance"] = payload.idempotency_key or ""
    session.updated_at = now
    session.version += 1
    await session.save()
    return await _build_session_payload(session, client_id)


async def run_setup_step(
    session_id: str,
    step_id: str,
    payload: SetupSessionStepRunRequest,
) -> dict[str, Any]:
    client_id = _require_client_id(payload.client_id)
    if step_id != "region":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Step does not support run", "code": "invalid_step"},
        )

    session = await _fetch_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Setup session not found")

    _assert_session_owner(session, client_id)
    _assert_session_active(session)

    run_key = f"run:{step_id}"
    if (
        payload.idempotency_key
        and session.idempotency_keys.get(run_key) == payload.idempotency_key
    ):
        return await _build_session_payload(session, client_id)

    _assert_version(session, payload.version)

    session.step_states = session.step_states or _default_step_states()
    region_state = session.step_states["region"]

    if region_state.in_flight and region_state.metadata.get("job_id"):
        return await _build_session_payload(session, client_id)

    if payload.mode not in {"download", "auto"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Invalid run mode", "code": "invalid_mode"},
        )

    region = payload.region
    if payload.mode == "auto":
        suggestion = await suggest_region_from_first_trip()
        if not suggestion:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "message": "No trips found to suggest a region.",
                    "code": "no_region_suggestion",
                },
            )
        region = suggestion

    if not region or not region.get("id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": "Region selection is required",
                "code": "missing_region",
            },
        )

    try:
        job = await download_and_build_all(
            geofabrik_id=region["id"],
            display_name=region.get("name"),
        )
    except Exception as exc:
        logger.exception("Failed to start region build")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"message": str(exc), "code": "region_run_failed"},
        )

    now = datetime.now(UTC)
    if session.active_client_id is None:
        session.active_client_id = client_id
        session.active_client_last_seen_at = now
    region_state.in_flight = True
    region_state.interruptible = False
    region_state.status = "in_progress"
    region_state.started_at = region_state.started_at or now
    region_state.updated_at = now
    region_state.idempotency_key = payload.idempotency_key
    region_state.lock_owner = client_id
    region_state.metadata.update(
        {
            "job_id": str(job.id),
            "selected_region": {
                "id": region.get("id"),
                "name": region.get("name"),
                "size": region.get("pbf_size_mb"),
            },
            "run_mode": payload.mode,
        },
    )

    session.idempotency_keys[run_key] = payload.idempotency_key or ""
    if session.status == "not_started":
        session.status = "in_progress"
        session.started_at = now
    session.active_client_last_seen_at = now
    session.updated_at = now
    session.version += 1
    await session.save()
    return await _build_session_payload(session, client_id)


async def cancel_setup_session(
    session_id: str,
    payload: SetupSessionClaimRequest,
) -> dict[str, Any]:
    client_id = _require_client_id(payload.client_id)
    session = await _fetch_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Setup session not found")

    _assert_session_owner(session, client_id)

    now = datetime.now(UTC)
    if session.active_client_id is None:
        session.active_client_id = client_id
        session.active_client_last_seen_at = now
    session.status = "cancelled"
    session.active_client_last_seen_at = now
    session.updated_at = now
    session.version += 1
    await session.save()
    return await _build_session_payload(session, client_id)


async def _enable_task(task_id: str, interval_minutes: int) -> None:
    task_config = await TaskConfig.find_one(TaskConfig.task_id == task_id)
    if not task_config:
        task_config = TaskConfig(task_id=task_id)
    task_config.enabled = True
    task_config.interval_minutes = interval_minutes
    task_config.last_updated = datetime.now(UTC)
    task_config.config = task_config.config or {}
    await task_config.save()


async def _mark_setup_session_complete(now: datetime) -> None:
    session = await SetupSession.find_one(SetupSession.scope_key == SETUP_SCOPE_KEY)
    if not session:
        return
    session.step_states = session.step_states or _default_step_states()
    _mark_step_complete(session.step_states["complete"], now)
    session.status = "completed"
    session.current_step = "complete"
    session.completed_at = now
    session.updated_at = now
    session.version += 1
    await session.save()


async def complete_setup() -> dict[str, Any]:
    settings = await _get_or_create_settings()
    now = datetime.now(UTC)
    if settings.setup_completed:
        await _mark_setup_session_complete(now)
        return {
            "success": True,
            "message": "Setup already completed",
            "already_completed": True,
            "initial_fetch_job_id": None,
        }

    status_payload = await get_setup_status()
    if not status_payload.get("required_complete"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Complete Bouncie credentials and Mapbox token before finishing setup.",
        )

    settings.setup_completed = True
    settings.setup_completed_at = now
    settings.updated_at = now
    await settings.save()
    clear_config_cache()

    await set_global_disable(False)
    await _enable_task("periodic_fetch_trips", 5)
    await _enable_task("cleanup_stale_trips", 60)

    initial_fetch = None
    try:
        initial_fetch = await enqueue_task(
            "periodic_fetch_trips",
            manual_run=True,
            trigger_source="setup",
        )
    except Exception as exc:
        logger.warning("Failed to enqueue initial trip fetch: %s", exc)

    await _mark_setup_session_complete(now)

    return {
        "success": True,
        "message": "Setup completed",
        "initial_fetch_job_id": initial_fetch.get("job_id") if initial_fetch else None,
    }


async def auto_configure_region() -> dict[str, Any]:
    suggestion = await suggest_region_from_first_trip()
    if not suggestion:
        return {
            "success": False,
            "message": "No trips found to suggest a region.",
        }

    try:
        job = await download_and_build_all(
            geofabrik_id=suggestion["id"],
            display_name=suggestion.get("name"),
        )
    except Exception as exc:
        logger.exception("Failed to auto-configure region")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )

    return {
        "success": True,
        "job_id": str(job.id),
        "region": suggestion,
    }


def _status_label(status_value: str) -> str:
    return {
        "healthy": "Healthy",
        "warning": "Warning",
        "error": "Error",
    }.get(status_value, "Unknown")


def _derive_geo_status(
    container_running: bool,
    has_data: bool,
    error: str | None,
) -> str:
    if not container_running:
        return "error"
    if has_data:
        return "healthy"
    if error:
        return "warning"
    return "warning"


def _format_geo_detail(container_running: bool, has_data: bool) -> str:
    container_label = "Running" if container_running else "Stopped"
    if not container_running:
        service_label = "Unavailable"
    else:
        service_label = "Ready" if has_data else "Waiting for data"
    return f"Container: {container_label} | Service: {service_label}"


async def get_status_health() -> dict[str, Any]:
    now = datetime.now(UTC)

    mongo_status = "healthy"
    mongo_message = "Connected"
    mongo_detail = None
    try:
        await AppSettings.find_one()
    except Exception as exc:
        mongo_status = "error"
        mongo_message = "MongoDB unavailable"
        mongo_detail = str(exc)

    redis_status = "healthy"
    redis_message = "Connected"
    redis_detail = None
    redis = None
    try:
        redis = await get_arq_pool()
        await redis.ping()
    except Exception as exc:
        redis_status = "error"
        redis_message = "Redis unavailable"
        redis_detail = str(exc)

    worker_status = "warning"
    worker_message = "Waiting for worker heartbeat"
    worker_detail = None
    active_tasks = 0
    if redis_status == "healthy" and redis:
        heartbeat = await redis.get("arq:worker:heartbeat")
        if heartbeat:
            heartbeat_value = (
                heartbeat.decode()
                if isinstance(heartbeat, bytes | bytearray)
                else str(heartbeat)
            )
            heartbeat_dt = None
            try:
                heartbeat_dt = datetime.fromisoformat(heartbeat_value)
            except ValueError:
                worker_detail = "Heartbeat timestamp unreadable"

            if heartbeat_dt is not None:
                age_seconds = (now - cast("datetime", heartbeat_dt)).total_seconds()
                if age_seconds <= 120:
                    worker_status = "healthy"
                    worker_message = "Worker online"
                    worker_detail = f"Last heartbeat {int(age_seconds)}s ago"
                else:
                    worker_status = "warning"
                    worker_message = "Worker heartbeat stale"
                    worker_detail = f"Last heartbeat {int(age_seconds)}s ago"

    active_tasks = await TaskHistory.find(
        {"status": {"$in": ["RUNNING", "PENDING"]}},
    ).count()
    active_label = f"Active tasks: {active_tasks}"
    worker_detail = (
        f"{worker_detail} | {active_label}" if worker_detail else active_label
    )

    credentials = await get_bouncie_credentials()
    bouncie_devices = _normalize_devices(credentials.get("authorized_devices"))
    bouncie_ready = all(
        credentials.get(field)
        for field in [
            "client_id",
            "client_secret",
            "redirect_uri",
        ]
    ) and bool(bouncie_devices)
    bouncie_status = "healthy" if bouncie_ready else "warning"
    bouncie_message = (
        f"Configured for {len(bouncie_devices)} device(s)"
        if bouncie_ready
        else "Credentials not configured"
    )
    bouncie_detail = None

    geo_health = await check_service_health(force_refresh=True)
    nominatim_status = _derive_geo_status(
        geo_health.nominatim_container_running,
        geo_health.nominatim_has_data,
        geo_health.nominatim_error,
    )
    nominatim_message = (
        "Service ready"
        if geo_health.nominatim_has_data
        else geo_health.nominatim_error or "Waiting for data"
    )
    nominatim_detail = _format_geo_detail(
        geo_health.nominatim_container_running,
        geo_health.nominatim_has_data,
    )

    valhalla_status = _derive_geo_status(
        geo_health.valhalla_container_running,
        geo_health.valhalla_has_data,
        geo_health.valhalla_error,
    )
    valhalla_message = (
        "Service ready"
        if geo_health.valhalla_has_data
        else geo_health.valhalla_error or "Waiting for data"
    )
    valhalla_detail = _format_geo_detail(
        geo_health.valhalla_container_running,
        geo_health.valhalla_has_data,
    )

    sort_key = "-timestamp"
    recent_errors = (
        await TaskHistory.find({"status": "FAILED"}).sort(sort_key).limit(5).to_list()
    )
    recent_error_payload = [
        {
            "task_id": entry.task_id,
            "timestamp": entry.timestamp.isoformat() if entry.timestamp else None,
            "error": entry.error,
        }
        for entry in recent_errors
    ]

    service_statuses = {
        "mongodb": {
            "status": mongo_status,
            "label": _status_label(mongo_status),
            "message": mongo_message,
            "detail": mongo_detail,
        },
        "redis": {
            "status": redis_status,
            "label": _status_label(redis_status),
            "message": redis_message,
            "detail": redis_detail,
        },
        "worker": {
            "status": worker_status,
            "label": _status_label(worker_status),
            "message": worker_message,
            "detail": worker_detail,
        },
        "nominatim": {
            "status": nominatim_status,
            "label": _status_label(nominatim_status),
            "message": nominatim_message,
            "detail": nominatim_detail,
            "container_running": geo_health.nominatim_container_running,
            "has_data": geo_health.nominatim_has_data,
        },
        "valhalla": {
            "status": valhalla_status,
            "label": _status_label(valhalla_status),
            "message": valhalla_message,
            "detail": valhalla_detail,
            "container_running": geo_health.valhalla_container_running,
            "has_data": geo_health.valhalla_has_data,
        },
        "bouncie": {
            "status": bouncie_status,
            "label": _status_label(bouncie_status),
            "message": bouncie_message,
            "detail": bouncie_detail,
        },
    }

    statuses = [entry["status"] for entry in service_statuses.values()]
    overall_status = "healthy"
    if "error" in statuses:
        overall_status = "error"
    elif "warning" in statuses:
        overall_status = "warning"

    overall_message = {
        "healthy": "All services are healthy.",
        "warning": "Some services need attention.",
        "error": "Critical services are unavailable.",
    }[overall_status]

    return {
        "success": True,
        "overall": {
            "status": overall_status,
            "message": overall_message,
            "last_updated": now.isoformat(),
        },
        "services": service_statuses,
        "recent_errors": recent_error_payload,
    }


async def restart_service(service_name: str) -> dict[str, Any]:
    service_name = service_name.strip().lower()
    if service_name not in {"nominatim", "valhalla"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "Unsupported service", "code": "invalid_service"},
        )

    from map_data.builders import _restart_container

    await _restart_container(service_name)

    return {
        "success": True,
        "message": f"{service_name.title()} restart triggered",
        "service": service_name,
    }


class SetupService:
    """Setup wizard service helpers."""

    @staticmethod
    async def get_setup_status() -> dict[str, Any]:
        return await get_setup_status_endpoint()

    @staticmethod
    async def create_or_resume_setup_session(
        payload: SetupSessionRequest,
    ) -> dict[str, Any]:
        return await create_or_resume_setup_session(payload)

    @staticmethod
    async def get_setup_session(client_id: str | None = None) -> dict[str, Any]:
        return await get_setup_session(client_id)

    @staticmethod
    async def get_setup_session_by_id(
        session_id: str,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        return await get_setup_session_by_id(session_id, client_id)

    @staticmethod
    async def claim_setup_session(
        session_id: str,
        payload: SetupSessionClaimRequest,
    ) -> dict[str, Any]:
        return await claim_setup_session(session_id, payload)

    @staticmethod
    async def advance_setup_session(
        session_id: str,
        payload: SetupSessionAdvanceRequest,
    ) -> dict[str, Any]:
        return await advance_setup_session(session_id, payload)

    @staticmethod
    async def run_setup_step(
        session_id: str,
        step_id: str,
        payload: SetupSessionStepRunRequest,
    ) -> dict[str, Any]:
        return await run_setup_step(session_id, step_id, payload)

    @staticmethod
    async def cancel_setup_session(
        session_id: str,
        client_id: str | None = None,
    ) -> dict[str, Any]:
        return await cancel_setup_session(session_id, client_id)

    @staticmethod
    async def complete_setup() -> dict[str, Any]:
        return await complete_setup()

    @staticmethod
    async def auto_configure_region() -> dict[str, Any]:
        return await auto_configure_region()

    @staticmethod
    async def get_service_health() -> dict[str, Any]:
        return await get_service_health()

    @staticmethod
    async def restart_service(service_name: str) -> dict[str, Any]:
        return await restart_service(service_name)


__all__ = [
    "SetupService",
    "SetupSessionAdvanceRequest",
    "SetupSessionClaimRequest",
    "SetupSessionRequest",
    "SetupSessionStepRunRequest",
]
