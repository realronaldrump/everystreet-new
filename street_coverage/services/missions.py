"""Mission lifecycle and persistence helpers for coverage navigation."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from pymongo.errors import DuplicateKeyError

from core.serialization import serialize_datetime
from db.models import CoverageArea, CoverageMission, CoverageMissionCheckpoint, Street

MISSION_ACTIVE = "active"
MISSION_PAUSED = "paused"
MISSION_COMPLETED = "completed"
MISSION_CANCELLED = "cancelled"

MISSION_NON_TERMINAL = {MISSION_ACTIVE, MISSION_PAUSED}
MISSION_TERMINAL = {MISSION_COMPLETED, MISSION_CANCELLED}
MISSION_STATUSES = MISSION_NON_TERMINAL | MISSION_TERMINAL

CHECKPOINT_LIMIT = 60


def _now() -> datetime:
    return datetime.now(UTC)


def _coerce_oid(value: str | PydanticObjectId) -> PydanticObjectId:
    if isinstance(value, PydanticObjectId):
        return value
    try:
        return PydanticObjectId(str(value))
    except Exception as exc:
        msg = "Invalid object id."
        raise ValueError(msg) from exc


def _trim_checkpoints(
    checkpoints: list[CoverageMissionCheckpoint],
    *,
    limit: int = CHECKPOINT_LIMIT,
) -> list[CoverageMissionCheckpoint]:
    if len(checkpoints) <= limit:
        return checkpoints
    return checkpoints[-limit:]


def _append_checkpoint(
    mission: CoverageMission,
    *,
    event: str,
    note: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    checkpoints = list(mission.checkpoints or [])
    checkpoints.append(
        CoverageMissionCheckpoint(
            created_at=_now(),
            event=event,
            note=note,
            metadata=metadata or {},
        ),
    )
    mission.checkpoints = _trim_checkpoints(checkpoints)


def _checkpoint_to_payload(checkpoint: CoverageMissionCheckpoint) -> dict[str, Any]:
    return {
        "created_at": serialize_datetime(checkpoint.created_at),
        "event": checkpoint.event,
        "note": checkpoint.note,
        "metadata": checkpoint.metadata or {},
    }


def serialize_mission(
    mission: CoverageMission,
    *,
    include_completed_segment_ids: bool = True,
    include_checkpoints: bool = True,
) -> dict[str, Any]:
    completed_segment_ids = (
        list(mission.completed_segment_ids or []) if include_completed_segment_ids else []
    )
    checkpoints = (
        [
            _checkpoint_to_payload(checkpoint)
            for checkpoint in list(mission.checkpoints or [])
        ]
        if include_checkpoints
        else []
    )
    return {
        "id": str(mission.id) if mission.id else None,
        "area_id": str(mission.area_id),
        "area_version": mission.area_version,
        "area_display_name": mission.area_display_name,
        "status": mission.status,
        "started_at": serialize_datetime(mission.started_at),
        "ended_at": serialize_datetime(mission.ended_at),
        "updated_at": serialize_datetime(mission.updated_at),
        "last_heartbeat_at": serialize_datetime(mission.last_heartbeat_at),
        "route_snapshot": mission.route_snapshot or {},
        "baseline": mission.baseline or {},
        "session_segments_completed": int(mission.session_segments_completed or 0),
        "session_gain_miles": float(mission.session_gain_miles or 0.0),
        "completed_segment_count": len(mission.completed_segment_ids or []),
        "completed_segment_ids": completed_segment_ids,
        "checkpoints": checkpoints,
    }


class CoverageMissionService:
    """Business logic for mission create/read/update flows."""

    @staticmethod
    async def get_mission(
        mission_id: str | PydanticObjectId,
    ) -> CoverageMission | None:
        oid = _coerce_oid(mission_id)
        return await CoverageMission.get(oid)

    @staticmethod
    async def get_active_mission(area_id: str | PydanticObjectId) -> CoverageMission | None:
        area_oid = _coerce_oid(area_id)
        return await CoverageMission.find_one(
            {
                "area_id": area_oid,
                "status": MISSION_ACTIVE,
            },
            sort=[("updated_at", -1), ("_id", -1)],
        )

    @staticmethod
    async def create_mission(
        *,
        area_id: str | PydanticObjectId,
        resume_if_active: bool = True,
        route_snapshot: dict[str, Any] | None = None,
        baseline: dict[str, Any] | None = None,
        note: str | None = None,
    ) -> tuple[CoverageMission, bool]:
        area_oid = _coerce_oid(area_id)
        area = await CoverageArea.get(area_oid)
        if not area:
            msg = "Coverage area not found."
            raise LookupError(msg)
        if area.status != "ready":
            msg = f"Coverage area is not ready (status: {area.status})."
            raise ValueError(msg)

        active = await CoverageMissionService.get_active_mission(area_oid)
        if active:
            if resume_if_active:
                return active, False
            msg = "An active mission already exists for this area."
            raise RuntimeError(msg)

        now = _now()
        mission = CoverageMission(
            area_id=area_oid,
            area_version=area.area_version,
            area_display_name=area.display_name or "",
            status=MISSION_ACTIVE,
            started_at=now,
            updated_at=now,
            last_heartbeat_at=now,
            route_snapshot=route_snapshot or {},
            baseline=baseline
            or {
                "coverage_percentage": float(area.coverage_percentage or 0.0),
                "driveable_length_miles": float(area.driveable_length_miles or 0.0),
                "driven_length_miles": float(area.driven_length_miles or 0.0),
            },
            session_segments_completed=0,
            session_gain_miles=0.0,
            completed_segment_ids=[],
            checkpoints=[],
        )
        _append_checkpoint(
            mission,
            event="created",
            note=note,
            metadata={"area_version": area.area_version},
        )
        try:
            await mission.insert()
        except DuplicateKeyError as exc:
            # Enforce deterministic behavior under concurrent create attempts.
            active_after_conflict = await CoverageMissionService.get_active_mission(area_oid)
            if active_after_conflict and resume_if_active:
                return active_after_conflict, False
            msg = "An active mission already exists for this area."
            raise RuntimeError(msg) from exc
        return mission, True

    @staticmethod
    async def list_missions(
        *,
        area_id: str | None = None,
        status: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[CoverageMission], int]:
        query: dict[str, Any] = {}
        if area_id:
            query["area_id"] = _coerce_oid(area_id)
        if status:
            normalized = status.strip().lower()
            if normalized not in MISSION_STATUSES:
                msg = f"Unsupported mission status: {status}"
                raise ValueError(msg)
            query["status"] = normalized

        safe_limit = max(1, min(int(limit or 20), 200))
        safe_offset = max(0, int(offset or 0))

        cursor = CoverageMission.find(query).sort([("started_at", -1), ("_id", -1)])
        total = await cursor.count()
        missions = await cursor.skip(safe_offset).limit(safe_limit).to_list()
        return missions, total

    @staticmethod
    async def heartbeat(
        mission_id: str | PydanticObjectId,
        *,
        note: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CoverageMission:
        mission = await CoverageMissionService.get_mission(mission_id)
        if not mission:
            msg = "Mission not found."
            raise LookupError(msg)
        if mission.status != MISSION_ACTIVE:
            msg = f"Cannot heartbeat mission in status '{mission.status}'."
            raise ValueError(msg)

        now = _now()
        mission.last_heartbeat_at = now
        mission.updated_at = now
        _append_checkpoint(
            mission,
            event="heartbeat",
            note=note,
            metadata=metadata,
        )
        await mission.save()
        return mission

    @staticmethod
    async def transition_status(
        mission_id: str | PydanticObjectId,
        *,
        new_status: str,
        note: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CoverageMission:
        mission = await CoverageMissionService.get_mission(mission_id)
        if not mission:
            msg = "Mission not found."
            raise LookupError(msg)

        target = (new_status or "").strip().lower()
        if target not in MISSION_STATUSES:
            msg = f"Invalid mission status: {new_status}"
            raise ValueError(msg)

        current = (mission.status or "").strip().lower()
        if current == target:
            # Idempotent transition.
            return mission
        if current in MISSION_TERMINAL:
            msg = f"Cannot transition terminal mission '{current}'."
            raise ValueError(msg)
        if current == MISSION_ACTIVE and target not in {
            MISSION_PAUSED,
            MISSION_COMPLETED,
            MISSION_CANCELLED,
        }:
            msg = f"Invalid transition from '{current}' to '{target}'."
            raise ValueError(msg)
        if current == MISSION_PAUSED and target not in {
            MISSION_ACTIVE,
            MISSION_COMPLETED,
            MISSION_CANCELLED,
        }:
            msg = f"Invalid transition from '{current}' to '{target}'."
            raise ValueError(msg)

        now = _now()
        if target == MISSION_ACTIVE:
            existing_active = await CoverageMissionService.get_active_mission(mission.area_id)
            if existing_active and existing_active.id != mission.id:
                msg = "Another active mission already exists for this area."
                raise ValueError(msg)
        mission.status = target
        mission.updated_at = now
        if target in MISSION_TERMINAL:
            mission.ended_at = now
        elif target == MISSION_ACTIVE:
            mission.last_heartbeat_at = now
            mission.ended_at = None

        _append_checkpoint(
            mission,
            event=target,
            note=note,
            metadata=metadata,
        )
        try:
            await mission.save()
        except DuplicateKeyError as exc:
            if target == MISSION_ACTIVE:
                msg = "Another active mission already exists for this area."
                raise ValueError(msg) from exc
            raise
        return mission

    @staticmethod
    async def validate_progress_context(
        *,
        mission_id: str | PydanticObjectId,
        area_id: PydanticObjectId,
    ) -> CoverageMission:
        mission = await CoverageMissionService.get_mission(mission_id)
        if not mission:
            msg = "Mission not found."
            raise LookupError(msg)
        if mission.area_id != area_id:
            msg = "Mission does not belong to this area."
            raise ValueError(msg)
        if mission.status != MISSION_ACTIVE:
            msg = f"Mission is not active (status: {mission.status})."
            raise ValueError(msg)
        return mission

    @staticmethod
    async def apply_segment_progress(
        *,
        mission_id: str | PydanticObjectId,
        area_id: PydanticObjectId,
        segment_ids: list[str],
        note: str | None = None,
    ) -> dict[str, Any]:
        mission = await CoverageMissionService.validate_progress_context(
            mission_id=mission_id,
            area_id=area_id,
        )

        if not segment_ids:
            return {
                "mission_id": str(mission.id) if mission.id else None,
                "added_segments": 0,
                "added_miles": 0.0,
                "total_segments": int(mission.session_segments_completed or 0),
                "total_miles": float(mission.session_gain_miles or 0.0),
            }

        ordered_unique_ids = list(dict.fromkeys([str(s).strip() for s in segment_ids if s]))
        existing_ids = set(mission.completed_segment_ids or [])
        new_ids = [segment_id for segment_id in ordered_unique_ids if segment_id not in existing_ids]

        if not new_ids:
            return {
                "mission_id": str(mission.id) if mission.id else None,
                "added_segments": 0,
                "added_miles": 0.0,
                "total_segments": int(mission.session_segments_completed or 0),
                "total_miles": float(mission.session_gain_miles or 0.0),
            }

        streets = await Street.find(
            {
                "area_id": area_id,
                "area_version": mission.area_version,
                "segment_id": {"$in": new_ids},
            },
        ).to_list()
        length_by_segment = {
            str(street.segment_id): float(street.length_miles or 0.0) for street in streets
        }
        valid_new_ids = [segment_id for segment_id in new_ids if segment_id in length_by_segment]

        if not valid_new_ids:
            return {
                "mission_id": str(mission.id) if mission.id else None,
                "added_segments": 0,
                "added_miles": 0.0,
                "total_segments": int(mission.session_segments_completed or 0),
                "total_miles": float(mission.session_gain_miles or 0.0),
            }

        added_miles = float(sum(length_by_segment[segment_id] for segment_id in valid_new_ids))

        existing_completed_ids = list(mission.completed_segment_ids or [])
        mission.completed_segment_ids = [*existing_completed_ids, *valid_new_ids]
        mission.session_segments_completed = int(mission.session_segments_completed or 0) + len(
            valid_new_ids,
        )
        mission.session_gain_miles = float(mission.session_gain_miles or 0.0) + added_miles
        mission.updated_at = _now()
        mission.last_heartbeat_at = mission.updated_at
        _append_checkpoint(
            mission,
            event="segments_marked",
            note=note,
            metadata={
                "added_segments": len(valid_new_ids),
                "added_miles": round(added_miles, 6),
            },
        )
        await mission.save()

        return {
            "mission_id": str(mission.id) if mission.id else None,
            "added_segments": len(valid_new_ids),
            "added_miles": round(added_miles, 6),
            "total_segments": int(mission.session_segments_completed or 0),
            "total_miles": round(float(mission.session_gain_miles or 0.0), 6),
        }
