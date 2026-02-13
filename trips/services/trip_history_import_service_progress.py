"""Progress and cancellation helpers for trip history import."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from core.jobs import JobHandle
from db.models import Job

from trips.services.trip_history_import_service_config import OVERLAP_HOURS, STEP_HOURS, WINDOW_DAYS


def _record_failure_reason(
    failure_reasons: dict[str, int],
    reason: str | None,
) -> None:
    text = (reason or "").strip() or "Unknown error"
    # Keep keys stable + bounded so job metadata doesn't grow unbounded.
    text = text.replace("\n", " ").replace("\r", " ")
    if len(text) > 180:
        text = text[:177] + "..."

    if text in failure_reasons:
        failure_reasons[text] += 1
        return

    # Cap unique reasons to avoid runaway metadata growth.
    if len(failure_reasons) >= 25:
        other = "Other (see event log for details)"
        failure_reasons[other] = failure_reasons.get(other, 0) + 1
        return

    failure_reasons[text] = 1


def _add_progress_event(
    events: list[dict[str, Any]],
    level: str,
    message: str,
    data: dict[str, Any] | None = None,
) -> None:
    events.append(
        {
            "ts_iso": datetime.now(UTC).isoformat(),
            "level": level,
            "message": message,
            "data": data,
        },
    )
    if len(events) > 120:
        del events[:-120]


def _trim_events(
    events: list[dict[str, Any]],
    *,
    limit: int = 60,
) -> list[dict[str, Any]]:
    if len(events) <= limit:
        return events
    return events[-limit:]


async def _load_progress_job(progress_job_id: str) -> Job | None:
    try:
        oid = PydanticObjectId(progress_job_id)
    except Exception:
        return None
    return await Job.get(oid)


async def _write_cancelled_progress(
    *,
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    write_progress: Callable[..., Awaitable[None]],
    windows_completed: int,
) -> dict[str, str]:
    add_event("warning", "Cancelled by user", None)
    await write_progress(
        status="cancelled",
        stage="cancelled",
        message="Cancelled",
        progress=100.0,
        current_window=None,
        windows_completed=windows_completed,
        completed_at=datetime.now(UTC),
        important=True,
    )
    return {"status": "cancelled", "message": "Cancelled"}


@dataclass
class ImportProgressContext:
    start_dt: datetime
    end_dt: datetime
    progress_job_id: str | None
    handle: JobHandle | None
    devices: list[dict[str, Any]]
    windows_total: int
    counters: dict[str, int]
    per_device: dict[str, dict[str, int]]
    events: list[dict[str, Any]] = field(default_factory=list)
    failure_reasons: dict[str, int] = field(default_factory=dict)
    cancel_state: dict[str, Any] = field(
        default_factory=lambda: {"checked_at": 0.0, "cancelled": False},
    )

    def record_failure_reason(self, reason: str | None) -> None:
        _record_failure_reason(self.failure_reasons, reason)

    def add_event(
        self,
        level: str,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        _add_progress_event(self.events, level, message, data)

    async def write_progress(
        self,
        *,
        status: str | None = None,
        stage: str | None = None,
        message: str | None = None,
        progress: float | None = None,
        current_window: dict[str, Any] | None = None,
        windows_completed: int | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
        error: str | None = None,
        important: bool = False,
    ) -> None:
        if not self.handle:
            return
        del important
        if windows_completed is None:
            windows_completed = 0

        meta_patch = {
            "start_iso": self.start_dt.isoformat(),
            "end_iso": self.end_dt.isoformat(),
            "window_days": WINDOW_DAYS,
            "overlap_hours": OVERLAP_HOURS,
            "step_hours": STEP_HOURS,
            "devices": self.devices,
            "windows_total": self.windows_total,
            "windows_completed": windows_completed,
            "current_window": current_window,
            "counters": dict(self.counters),
            "per_device": self.per_device,
            "events": _trim_events(list(self.events)),
            "failure_reasons": dict(self.failure_reasons),
        }
        await self.handle.update(
            status=status,
            stage=stage,
            message=message,
            progress=progress,
            metadata_patch=meta_patch,
            started_at=started_at,
            completed_at=completed_at,
            error=error,
        )

    async def is_cancelled(self, *, force: bool = False) -> bool:
        if not self.progress_job_id:
            return False
        now = time.monotonic()
        if not force and now - float(self.cancel_state.get("checked_at") or 0.0) < 1.0:
            return bool(self.cancel_state.get("cancelled"))
        self.cancel_state["checked_at"] = now
        current = await _load_progress_job(self.progress_job_id)
        cancelled = bool(current and current.status == "cancelled")
        self.cancel_state["cancelled"] = cancelled
        return cancelled


__all__ = [
    "_record_failure_reason",
    "_add_progress_event",
    "_trim_events",
    "_load_progress_job",
    "_write_cancelled_progress",
    "ImportProgressContext",
]
