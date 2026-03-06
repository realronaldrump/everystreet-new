"""Background monitoring for the public Bouncie webhook."""

from __future__ import annotations

from setup.services.bouncie_webhooks import ensure_bouncie_live_trip_webhook
from tasks.ops import run_task_with_history


async def monitor_bouncie_webhook(ctx: dict) -> dict[str, object]:
    """Probe and reconcile the public Bouncie webhook configuration."""
    return await run_task_with_history(
        ctx,
        "monitor_bouncie_webhook",
        lambda: ensure_bouncie_live_trip_webhook(),
    )
