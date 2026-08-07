"""Optional reverse-proxy mTLS enforcement for the anonymous MCP endpoint."""

from __future__ import annotations

import os
from typing import Any

from starlette.responses import JSONResponse

MCP_REQUIRE_MTLS_ENV = "EVERYSTREET_MCP_REQUIRE_MTLS"
MCP_MTLS_VERIFIED_HEADER_ENV = "EVERYSTREET_MCP_MTLS_VERIFIED_HEADER"
MCP_MTLS_VERIFIED_VALUE_ENV = "EVERYSTREET_MCP_MTLS_VERIFIED_VALUE"
DEFAULT_VERIFIED_HEADER = "cf-tls-client-auth-cert-verified"
DEFAULT_VERIFIED_VALUE = "success"


def require_mtls() -> bool:
    return os.getenv(MCP_REQUIRE_MTLS_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class OpenAIMtlsProxyGuard:
    """Require a trusted edge's verified-client-certificate assertion when enabled."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or not require_mtls():
            await self.app(scope, receive, send)
            return
        header_name = (
            os.getenv(
                MCP_MTLS_VERIFIED_HEADER_ENV,
                DEFAULT_VERIFIED_HEADER,
            )
            .strip()
            .lower()
        )
        expected = (
            os.getenv(
                MCP_MTLS_VERIFIED_VALUE_ENV,
                DEFAULT_VERIFIED_VALUE,
            )
            .strip()
            .lower()
        )
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        if headers.get(header_name, "").strip().lower() != expected:
            response = JSONResponse(
                {"error": "verified OpenAI client certificate required"},
                status_code=403,
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


class ExactMcpPathAdapter:
    """Adapt FastAPI's exact ``/mcp`` route to the SDK app's root route."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        adapted = dict(scope)
        adapted["root_path"] = f"{scope.get('root_path', '')}/mcp"
        adapted["path"] = "/"
        adapted["raw_path"] = b"/"
        await self.app(adapted, receive, send)


__all__ = ["ExactMcpPathAdapter", "OpenAIMtlsProxyGuard", "require_mtls"]
