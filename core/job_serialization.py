"""Canonical job payload serialization helpers."""

from __future__ import annotations

from typing import Any

from core.serialization import serialize_datetime


def serialize_job_payload(
    job: Any,
    *,
    job_id: str | None = None,
) -> dict[str, Any]:
    return {
        "job_id": job_id or (str(job.id) if getattr(job, "id", None) else None),
        "job_type": getattr(job, "job_type", None),
        "task_id": getattr(job, "task_id", None),
        "operation_id": getattr(job, "operation_id", None),
        "status": getattr(job, "status", None),
        "stage": getattr(job, "stage", None),
        "progress": float(getattr(job, "progress", 0.0) or 0.0),
        "message": getattr(job, "message", None),
        "error": getattr(job, "error", None),
        "created_at": serialize_datetime(getattr(job, "created_at", None)),
        "started_at": serialize_datetime(getattr(job, "started_at", None)),
        "completed_at": serialize_datetime(getattr(job, "completed_at", None)),
        "updated_at": serialize_datetime(getattr(job, "updated_at", None)),
        "metadata": getattr(job, "metadata", None) or {},
        "result": getattr(job, "result", None),
    }


def serialize_job_progress(
    job: Any,
    *,
    job_id: str | None = None,
    metadata_field: str = "metrics",
    include_status: bool = True,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": job_id or (str(job.id) if getattr(job, "id", None) else None),
        "stage": getattr(job, "stage", None) or "unknown",
        "progress": float(getattr(job, "progress", 0.0) or 0.0),
        "message": getattr(job, "message", None) or "",
        metadata_field: getattr(job, "metadata", None) or {},
        "error": getattr(job, "error", None),
        "updated_at": serialize_datetime(getattr(job, "updated_at", None)),
    }
    if include_status:
        payload["status"] = getattr(job, "status", None) or "unknown"
    return payload


__all__ = ["serialize_job_payload", "serialize_job_progress"]
