"""Worker health utilities for ARQ."""

from __future__ import annotations

from datetime import UTC, datetime


async def worker_heartbeat(ctx: dict) -> dict[str, str]:
    redis = ctx.get("redis")
    if not redis:
        return {"status": "error", "message": "redis unavailable"}

    now = datetime.now(UTC).isoformat()
    await redis.set("arq:worker:heartbeat", now, ex=120)
    return {"status": "ok", "last_seen": now}
