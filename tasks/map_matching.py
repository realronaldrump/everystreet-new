"""ARQ task for running map matching jobs."""

from __future__ import annotations

import uuid
from typing import Any

from tasks.ops import run_task_with_history
from trips.models import MapMatchJobRequest
from trips.services.map_matching_jobs import MapMatchingJobRunner


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
