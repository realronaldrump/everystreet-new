"""ARQ task wrapper for Bouncie webhook health check."""

from __future__ import annotations

from typing import Any

from setup.services.bouncie_webhooks import ensure_webhook_active
from tasks.ops import run_task_with_history


async def monitor_bouncie_webhook(
    ctx: dict,
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "monitor_bouncie_webhook",
        ensure_webhook_active,
        manual_run=manual_run,
    )
