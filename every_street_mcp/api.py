"""Owner-facing operational status for the EveryStreet ChatGPT connection."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter

from db.models import McpAuditEvent

from .security import require_mtls
from .server import MODEL_TOOL_COUNT, SERVER_NAME, SERVER_VERSION, TOOL_COUNT

router = APIRouter(prefix="/api/chatgpt", tags=["chatgpt"])


@router.get("/status")
async def get_chatgpt_status() -> dict[str, object]:
    """Return non-sensitive MCP health and recent activity for the owner UI."""

    now = datetime.now(UTC)
    since = now - timedelta(hours=24)
    recent_query = {"created_at": {"$gte": since}}
    recent_calls = await McpAuditEvent.find(recent_query).count()
    recent_errors = await McpAuditEvent.find(
        {**recent_query, "outcome": {"$ne": "success"}},
    ).count()
    latest = (
        await McpAuditEvent.find_all().sort(-McpAuditEvent.created_at).first_or_none()
    )
    return {
        "status": "ready",
        "endpoint": "https://www.everystreet.me/mcp",
        "authentication": "none",
        "mtls_required": require_mtls(),
        "server": {"name": SERVER_NAME, "version": SERVER_VERSION},
        "tools": {"total": TOOL_COUNT, "model_visible": MODEL_TOOL_COUNT},
        "activity_24h": {"calls": recent_calls, "errors": recent_errors},
        "latest_call": (
            {
                "tool": latest.tool_name,
                "outcome": latest.outcome,
                "at": latest.created_at.astimezone(UTC).isoformat(),
            }
            if latest
            else None
        ),
        "as_of": now.isoformat(),
    }


__all__ = ["router"]
