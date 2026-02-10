"""ARQ task for building recurring route templates from stored trips."""

from __future__ import annotations

import uuid
from typing import Any

from recurring_routes.models import BuildRecurringRoutesRequest
from recurring_routes.services.builder import RecurringRoutesBuilder
from tasks.ops import run_task_with_history


async def build_recurring_routes(
    ctx: dict[str, Any],
    build_request: dict[str, Any] | None = None,
    manual_run: bool = False,
) -> dict[str, Any]:
    """Execute a queued recurring routes build job."""
    job_id = None
    if isinstance(ctx, dict):
        job_id = ctx.get("job_id") or ctx.get("id")
    if not job_id:
        job_id = str(uuid.uuid4())
        if isinstance(ctx, dict):
            ctx["job_id"] = job_id

    request = BuildRecurringRoutesRequest(**(build_request or {}))
    builder = RecurringRoutesBuilder()

    return await run_task_with_history(
        ctx,
        "build_recurring_routes",
        lambda: builder.run(job_id, request),
        manual_run=manual_run,
    )

