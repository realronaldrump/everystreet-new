from __future__ import annotations

from pathlib import Path

from beanie import PydanticObjectId
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import FileResponse

from db.models import ExportJob
from exports.auth import enforce_owner, get_owner_key
from exports.models import ExportJobResponse, ExportRequest, ExportResult, ExportStatusResponse
from exports.services.export_service import ExportService
router = APIRouter(prefix="/api/exports", tags=["exports"])


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

    return ExportJobResponse(
        id=str(job.id),
        status=job.status,
        progress=job.progress,
        message=job.message,
        created_at=job.created_at.isoformat(),
    )


@router.get("/{job_id}", response_model=ExportStatusResponse)
async def get_export_job(job_id: PydanticObjectId, request: Request):
    owner_key = get_owner_key(request)
    job = await ExportJob.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    enforce_owner(job.owner_key, owner_key)

    result = None
    if job.result:
        result = ExportResult(
            artifact_name=job.result.get("artifact_name"),
            artifact_size_bytes=job.result.get("artifact_size_bytes"),
            records=job.result.get("records", {}),
            files=job.result.get("files", []),
        )

    download_url = None
    if job.status == "completed" and job.result:
        download_url = f"/api/exports/{job.id}/download"

    return ExportStatusResponse(
        id=str(job.id),
        status=job.status,
        progress=job.progress,
        message=job.message,
        created_at=job.created_at.isoformat(),
        started_at=job.started_at.isoformat() if job.started_at else None,
        completed_at=job.completed_at.isoformat() if job.completed_at else None,
        error=job.error,
        result=result,
        download_url=download_url,
    )


@router.get("/{job_id}/download")
async def download_export_job(job_id: PydanticObjectId, request: Request):
    owner_key = get_owner_key(request)
    job = await ExportJob.get(job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

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
