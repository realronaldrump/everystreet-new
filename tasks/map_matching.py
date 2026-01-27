"""ARQ task for running map matching jobs."""

from __future__ import annotations

import uuid
from typing import Any

from map_matching.schemas import MapMatchJobRequest
from map_matching.service import MapMatchingJobRunner
from tasks.ops import run_task_with_history


async def map_match_trips(
    ctx: dict[str, Any],
    job_request: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    """Execute a queued map matching job."""
    job_id = None
    if isinstance(ctx, dict):
        job_id = ctx.get("job_id") or ctx.get("id")
    if not job_id:
        job_id = str(uuid.uuid4())
        if isinstance(ctx, dict):
            ctx["job_id"] = job_id

    request = MapMatchJobRequest(**job_request)
    runner = MapMatchingJobRunner()

    return await run_task_with_history(
        ctx,
        "map_match_trips",
        lambda: runner.run(job_id, request),
        manual_run=manual_run,
    )
