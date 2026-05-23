from __future__ import annotations

from pathlib import Path

from beanie import PydanticObjectId
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import FileResponse

from core.job_serialization import serialize_job_payload
from db.models import Job
from exports.auth import enforce_owner, get_owner_key
from exports.models import (
    ExportJobResponse,
    ExportRequest,
    ExportResult,
    ExportStatusResponse,
)
from exports.services.export_service import ExportService

router = APIRouter(prefix="/api/exports", tags=["exports"])


def _export_result_from_job(job: Job) -> ExportResult | None:
    if not job.result:
        return None
    return ExportResult(
        artifact_name=job.result.get("artifact_name"),
        artifact_size_bytes=job.result.get("artifact_size_bytes"),
        records=job.result.get("records", {}),
        files=job.result.get("files", []),
    )


def _export_job_response(job: Job) -> ExportJobResponse:
    payload = serialize_job_payload(job)
    return ExportJobResponse(
        id=str(payload["job_id"]),
        status=payload["status"],
        progress=payload["progress"],
        message=payload["message"],
        created_at=payload["created_at"],
    )


def _export_status_response(job: Job) -> ExportStatusResponse:
    payload = serialize_job_payload(job)
    download_url = (
        f"/api/exports/{job.id}/download"
        if payload["status"] == "completed" and payload["result"]
        else None
    )
    return ExportStatusResponse(
        id=str(payload["job_id"]),
        status=payload["status"],
        progress=payload["progress"],
        message=payload["message"],
        created_at=payload["created_at"],
        started_at=payload["started_at"],
        completed_at=payload["completed_at"],
        error=payload["error"],
        result=_export_result_from_job(job),
        download_url=download_url,
    )


@router.post("", response_model=ExportJobResponse)
async def create_export_job(
    export_request: ExportRequest,
    background_tasks: BackgroundTasks,
    request: Request,
):
    owner_key = get_owner_key(request)
    try:
        job = await ExportService.create_job(export_request, owner_key)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    background_tasks.add_task(ExportService.run_job, str(job.id))

    return _export_job_response(job)


@router.get("/{job_id}", response_model=ExportStatusResponse)
async def get_export_job(job_id: PydanticObjectId, request: Request):
    owner_key = get_owner_key(request)
    job = await Job.get(job_id)
    if not job or job.job_type != "export":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )

    enforce_owner(job.owner_key, owner_key)

    return _export_status_response(job)


@router.get("/{job_id}/download")
async def download_export_job(job_id: PydanticObjectId, request: Request):
    owner_key = get_owner_key(request)
    job = await Job.get(job_id)
    if not job or job.job_type != "export":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found",
        )

    enforce_owner(job.owner_key, owner_key)

    if job.status != "completed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Export is not ready yet.",
        )

    if not job.result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export artifact not found.",
        )

    artifact_path = job.result.get("artifact_path")
    artifact_name = job.result.get("artifact_name")
    if not artifact_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export artifact missing.",
        )

    path = Path(artifact_path)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Export artifact is no longer available.",
        )

    filename = artifact_name or path.name
    return FileResponse(
        path,
        media_type="application/zip",
        filename=filename,
    )
