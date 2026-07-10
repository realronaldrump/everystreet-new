"""Durable export jobs."""

from __future__ import annotations

from typing import Any

from exports.services.export_service import ExportService


async def run_export_job(
    ctx: dict[str, Any],
    job_id: str,
) -> dict[str, Any]:
    del ctx
    return await ExportService.run_job(job_id)
