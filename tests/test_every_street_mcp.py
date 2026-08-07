from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from db_helpers import init_mock_beanie
from httpx import ASGITransport, AsyncClient

from app import app
from db.models import McpAuditEvent
from every_street_mcp.api import get_chatgpt_status
from every_street_mcp.security import OpenAIMtlsProxyGuard
from every_street_mcp.server import (
    ACTION_RESOURCE_URI,
    EXPLORER_RESOURCE_URI,
    LIVE_RESOURCE_URI,
    MODEL_TOOL_COUNT,
    TOOL_COUNT,
    mcp,
    mcp_lifespan,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def mcp_db():
    return await init_mock_beanie(McpAuditEvent, database_name="test_mcp_db")


async def test_mcp_catalog_is_anonymous_and_contains_expected_tools() -> None:
    tools = {tool.name: tool for tool in await mcp.list_tools()}
    expected = {
        "get_every_street_snapshot",
        "analyze_driving_history",
        "find_trips",
        "get_trip_details",
        "analyze_places",
        "analyze_recurring_routes",
        "get_geographic_coverage",
        "list_coverage_areas",
        "get_coverage_intelligence",
        "recommend_coverage_missions",
        "get_live_drive",
        "get_vehicle_economics",
        "get_system_health",
        "render_every_street_explorer",
        "prepare_every_street_action",
        "get_view_data",
        "commit_every_street_action",
    }
    assert expected <= set(tools)
    assert len(tools) == TOOL_COUNT
    assert sum(tool.meta["ui"]["visibility"] != ["app"] for tool in tools.values()) == (
        MODEL_TOOL_COUNT
    )
    for tool in tools.values():
        assert tool.meta["securitySchemes"] == [{"type": "noauth"}]


async def test_commit_and_view_tools_are_hidden_from_model() -> None:
    tools = {tool.name: tool for tool in await mcp.list_tools()}

    assert tools["get_view_data"].meta["ui"]["visibility"] == ["app"]
    assert tools["commit_every_street_action"].meta["ui"]["visibility"] == ["app"]
    assert tools["prepare_every_street_action"].annotations.readOnlyHint is True
    assert tools["commit_every_street_action"].annotations.readOnlyHint is False
    assert tools["commit_every_street_action"].annotations.destructiveHint is False


async def test_mcp_registers_versioned_app_resources() -> None:
    resources = {str(resource.uri): resource for resource in await mcp.list_resources()}

    assert {EXPLORER_RESOURCE_URI, LIVE_RESOURCE_URI, ACTION_RESOURCE_URI} <= set(
        resources
    )
    assert resources[EXPLORER_RESOURCE_URI].mimeType == "text/html+skybridge"
    assert resources[EXPLORER_RESOURCE_URI].meta["ui"]["domain"] == (
        "https://www.everystreet.me"
    )


async def test_fastapi_mount_serves_anonymous_mcp_initialize() -> None:
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "every-street-test", "version": "1.0"},
        },
    }
    async with (
        mcp_lifespan(),
        AsyncClient(
            transport=ASGITransport(app=app),
            base_url="https://www.everystreet.me",
        ) as client,
    ):
        response = await client.post(
            "/mcp",
            json=request,
            headers={
                "Accept": "application/json, text/event-stream",
                "Content-Type": "application/json",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["result"]["serverInfo"]["name"] == "every-street-intelligence"


async def test_optional_mtls_guard_requires_trusted_proxy_assertion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def downstream(scope, receive, send):
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    monkeypatch.setenv("EVERYSTREET_MCP_REQUIRE_MTLS", "true")
    guarded = OpenAIMtlsProxyGuard(downstream)
    async with AsyncClient(
        transport=ASGITransport(app=guarded),
        base_url="https://www.everystreet.me",
    ) as client:
        rejected = await client.get("/")
        accepted = await client.get(
            "/",
            headers={"cf-tls-client-auth-cert-verified": "SUCCESS"},
        )

    assert rejected.status_code == 403
    assert accepted.status_code == 204


async def test_owner_status_reports_redacted_mcp_activity(mcp_db) -> None:
    now = datetime.now(UTC)
    await McpAuditEvent(
        request_id="request-1",
        subject_hash="anonymous-hash",
        tool_name="get_every_street_snapshot",
        outcome="success",
        duration_ms=12,
        created_at=now,
        expires_at=now + timedelta(days=30),
    ).insert()

    status = await get_chatgpt_status()

    assert status["authentication"] == "none"
    assert status["activity_24h"] == {"calls": 1, "errors": 0}
    assert status["latest_call"]["tool"] == "get_every_street_snapshot"
    assert "subject_hash" not in status["latest_call"]
