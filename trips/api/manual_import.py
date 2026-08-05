"""Owner-only API routes for previewing and importing Bouncie trip files."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from trips.services.manual_trip_import_service import (
    MAX_IMPORT_BATCH_SIZE,
    MAX_SINGLE_UPLOAD_BYTES,
    MAX_TOTAL_UPLOAD_BYTES,
    MAX_UPLOAD_CONTAINERS,
    ManualTripImportError,
    ManualTripImportService,
    UploadedTripContainer,
    build_uploaded_container,
)

router = APIRouter()
manual_import_service = ManualTripImportService()


async def _read_uploads(files: list[UploadFile]) -> list[UploadedTripContainer]:
    if not files:
        raise ManualTripImportError("Choose at least one ZIP or JSON file")
    if len(files) > MAX_UPLOAD_CONTAINERS:
        raise ManualTripImportError("Too many files were selected")

    containers: list[UploadedTripContainer] = []
    total_bytes = 0
    try:
        for upload in files:
            content = await upload.read(MAX_SINGLE_UPLOAD_BYTES + 1)
            if len(content) > MAX_SINGLE_UPLOAD_BYTES:
                raise ManualTripImportError(
                    f"{upload.filename or 'Upload'} exceeds the per-file size limit",
                )
            total_bytes += len(content)
            if total_bytes > MAX_TOTAL_UPLOAD_BYTES:
                raise ManualTripImportError(
                    "Selected files exceed the total upload limit"
                )
            containers.append(build_uploaded_container(upload.filename, content))
    finally:
        for upload in files:
            await upload.close()
    return containers


def _parse_selected_ids(value: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ManualTripImportError("Selected trip IDs must be valid JSON") from exc
    if not isinstance(parsed, list) or any(
        not isinstance(item, str) for item in parsed
    ):
        raise ManualTripImportError("Selected trip IDs must be a JSON string array")
    selected = list(dict.fromkeys(item.strip() for item in parsed if item.strip()))
    if len(selected) > MAX_IMPORT_BATCH_SIZE:
        raise ManualTripImportError(
            f"Import at most {MAX_IMPORT_BATCH_SIZE} trips per batch"
        )
    if any(len(item) > 200 for item in selected):
        raise ManualTripImportError("A selected trip ID is too long")
    return selected


@router.post("/api/trips/manual-import/preview", response_model=dict[str, object])
async def preview_manual_trip_import(
    files: Annotated[list[UploadFile], File(...)],
) -> dict[str, object]:
    """Parse, validate, and compare uploaded trips without persisting them."""
    try:
        containers = await _read_uploads(files)
        analysis = await manual_import_service.analyze(containers)
    except ManualTripImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return analysis.to_payload()


@router.post("/api/trips/manual-import/commit", response_model=dict[str, object])
async def commit_manual_trip_import(
    files: Annotated[list[UploadFile], File(...)],
    fingerprint: Annotated[str, Form(...)],
    selected_ids: Annotated[str, Form(...)],
) -> dict[str, object]:
    """Revalidate and insert one small, idempotent batch of reviewed trips."""
    try:
        containers = await _read_uploads(files)
        parsed_ids = _parse_selected_ids(selected_ids)
        analysis = await manual_import_service.analyze(
            containers,
            requested_ids=set(parsed_ids),
        )
    except ManualTripImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    if not fingerprint or analysis.fingerprint != fingerprint:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The selected files changed after review. Scan them again.",
        )

    try:
        return await manual_import_service.import_selected(analysis, parsed_ids)
    except ManualTripImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


__all__ = ["router"]
