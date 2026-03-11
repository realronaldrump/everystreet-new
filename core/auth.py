"""Authentication, authorization, and request security helpers."""

from __future__ import annotations

import logging
import os
import secrets
import time
from dataclasses import dataclass
from typing import Final
from urllib.parse import quote, urlparse

from fastapi import Request, WebSocket, WebSocketException, status
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pwdlib import PasswordHash
from starlette.middleware.base import BaseHTTPMiddleware

from core.redis import get_shared_redis

logger = logging.getLogger(__name__)

OWNER_ROLE: Final[str] = "owner"
VIEWER_ROLE: Final[str] = "viewer"
SESSION_COOKIE_NAME: Final[str] = "everystreet_session"
SESSION_TTL_SECONDS: Final[int] = 90 * 24 * 60 * 60
SESSION_REFRESH_INTERVAL_SECONDS: Final[int] = 5 * 60
CSRF_HEADER_NAME: Final[str] = "x-csrf-token"
LOGIN_RATE_LIMIT_ATTEMPTS: Final[int] = 10
LOGIN_RATE_LIMIT_WINDOW_SECONDS: Final[int] = 15 * 60
APP_SESSION_SECRET_ENV: Final[str] = "APP_SESSION_SECRET"
APP_SESSION_HTTPS_ONLY_ENV: Final[str] = "APP_SESSION_HTTPS_ONLY"
OWNER_PASSWORD_HASH_ENV: Final[str] = "OWNER_PASSWORD_HASH"
DEFAULT_SESSION_SECRET: Final[str] = "change-me-session-secret"
FORM_CSRF_PATHS: Final[set[str]] = {
    "/logout",
    "/control-center/credentials/add-vehicle",
    "/vehicles/add-vehicle",
}
LOCAL_HOST_ALIASES: Final[set[str]] = {
    "127.0.0.1",
    "::1",
    "localhost",
}

PUBLIC_PAGE_PATHS: Final[set[str]] = {
    "/",
    "/map",
    "/trips",
    "/insights",
    "/coverage-navigator",
    "/county-map",
}
OWNER_PAGE_PREFIXES: Final[tuple[str, ...]] = (
    "/control-center",
    "/vehicles",
    "/export",
    "/map-matching",
    "/coverage-management",
    "/turn-by-turn",
    "/setup-wizard",
    "/routes",
    "/visits",
    "/gas-tracking",
)
PUBLIC_EXACT_PATHS: Final[set[str]] = {
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/login",
    "/api/auth/session",
    "/api/status/live",
    "/bouncie-webhook",
    "/bouncie-webhook/",
}
PUBLIC_PREFIXES: Final[tuple[str, ...]] = (
    "/static/",
    "/static-v/",
    "/npm/",
    "/api/search/",
    "/api/routing/",
)
PUBLIC_MUTATION_PATHS: Final[set[str]] = {
    "/login",
    "/api/driving-navigation/next-route",
    "/bouncie-webhook",
    "/bouncie-webhook/",
}
PUBLIC_MUTATION_PREFIXES: Final[tuple[str, ...]] = (
    "/api/routing/",
)
PUBLIC_SAFE_API_PATHS: Final[set[str]] = {
    "/api/active_trip",
    "/api/trip_updates",
}
PUBLIC_SAFE_API_PREFIXES: Final[tuple[str, ...]] = (
    "/api/auth/",
    "/api/search/",
    "/api/routing/",
    "/api/driving-navigation/suggest-next-street/",
)
SAFE_METHODS: Final[set[str]] = {"GET", "HEAD", "OPTIONS"}

_password_hasher = PasswordHash.recommended()
_ephemeral_session_secret: str | None = None


@dataclass(slots=True)
class AuthContext:
    """Computed auth state for the current request."""

    role: str = VIEWER_ROLE
    is_owner: bool = False
    viewer_mode: bool = True
    csrf_token: str | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "role": self.role,
            "is_owner": self.is_owner,
            "viewer_mode": self.viewer_mode,
            "csrf_token": self.csrf_token,
        }

    def to_frontend_payload(self) -> dict[str, object]:
        return {
            "role": self.role,
            "isOwner": self.is_owner,
            "viewerMode": self.viewer_mode,
            "csrfToken": self.csrf_token,
        }


def _session_store(connection: Request | WebSocket) -> dict[str, object]:
    return connection.scope.setdefault("session", {})


def get_session_secret() -> str:
    """Return the configured session signing secret."""
    configured_secret = os.getenv(APP_SESSION_SECRET_ENV, "").strip()
    if configured_secret and configured_secret != DEFAULT_SESSION_SECRET:
        return configured_secret

    if owner_login_enabled():
        raise RuntimeError(
            "APP_SESSION_SECRET must be set to a non-default value when owner auth is enabled.",
        )

    global _ephemeral_session_secret
    if not _ephemeral_session_secret:
        _ephemeral_session_secret = secrets.token_urlsafe(32)
    return _ephemeral_session_secret


def _host_looks_local(host: str) -> bool:
    normalized = (host or "").strip().lower().split(":", 1)[0]
    return normalized in LOCAL_HOST_ALIASES or normalized.endswith(".localhost")


def session_cookie_https_only() -> bool:
    """Return whether the session cookie should be marked Secure."""
    raw_value = os.getenv(APP_SESSION_HTTPS_ONLY_ENV, "").strip().lower()
    if raw_value in {"1", "true", "yes", "on"}:
        return True
    if raw_value in {"0", "false", "no", "off"}:
        return False
    return not any(_host_looks_local(host) for host in parse_allowed_hosts())


def owner_login_enabled() -> bool:
    """Return whether owner password auth is configured."""
    return bool(os.getenv(OWNER_PASSWORD_HASH_ENV, "").strip())


def get_request_auth_context(connection: Request | WebSocket) -> AuthContext:
    """Return auth context from connection scope/session."""
    session = connection.scope.get("session", {}) or {}
    session_is_owner = owner_login_enabled() and session.get("role") == OWNER_ROLE
    expected_csrf = session.get("csrf_token") if session_is_owner else None

    cached = getattr(getattr(connection, "state", None), "auth", None)
    if (
        isinstance(cached, AuthContext)
        and cached.is_owner == session_is_owner
        and cached.csrf_token == expected_csrf
    ):
        return cached

    is_owner = session_is_owner
    context = AuthContext(
        role=OWNER_ROLE if is_owner else VIEWER_ROLE,
        is_owner=is_owner,
        viewer_mode=not is_owner,
        csrf_token=expected_csrf,
    )
    state = getattr(connection, "state", None)
    if state is not None:
        state.auth = context
    return context


def mark_owner_session(request: Request) -> AuthContext:
    """Persist the owner session and return the new auth context."""
    now = int(time.time())
    csrf_token = secrets.token_urlsafe(32)
    session = _session_store(request)
    session.clear()
    session.update(
        {
            "role": OWNER_ROLE,
            "issued_at": now,
            "last_seen": now,
            "csrf_token": csrf_token,
        },
    )
    context = AuthContext(
        role=OWNER_ROLE,
        is_owner=True,
        viewer_mode=False,
        csrf_token=csrf_token,
    )
    request.state.auth = context
    return context


def clear_auth_session(request: Request) -> None:
    """Remove any persisted auth session."""
    _session_store(request).clear()
    request.state.auth = AuthContext()


def refresh_owner_session(request: Request) -> None:
    """Refresh rolling session timestamps for active owner sessions."""
    context = get_request_auth_context(request)
    if not context.is_owner:
        return

    now = int(time.time())
    session = _session_store(request)
    last_seen = int(session.get("last_seen") or 0)
    if now - last_seen < SESSION_REFRESH_INTERVAL_SECONDS:
        return

    session["last_seen"] = now
    request.state.auth = AuthContext(
        role=OWNER_ROLE,
        is_owner=True,
        viewer_mode=False,
        csrf_token=session.get("csrf_token"),
    )


def verify_owner_password(password: str) -> bool:
    """Verify the configured owner password."""
    password_hash = os.getenv(OWNER_PASSWORD_HASH_ENV, "").strip()
    if not password_hash or not password:
        return False
    try:
        return _password_hasher.verify(password, password_hash)
    except Exception:
        logger.exception("Failed to verify owner password hash")
        return False


def hash_password_for_owner(password: str) -> str:
    """Hash a plaintext password for env configuration."""
    return _password_hasher.hash(password)


def get_client_ip(request: Request) -> str:
    """Return the best-effort client IP for logging/rate limiting."""
    forwarded_for = (request.headers.get("x-forwarded-for") or "").strip()
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


def _login_rate_limit_key(ip_address: str) -> str:
    return f"auth:login_failures:{ip_address}"


async def check_login_rate_limit(ip_address: str) -> None:
    """Raise a 429-style response when the login window is exhausted."""
    try:
        redis = await get_shared_redis()
        attempts = await redis.get(_login_rate_limit_key(ip_address))
    except Exception:
        logger.exception("Failed to read login rate limit from Redis")
        return

    if attempts is not None and int(attempts) >= LOGIN_RATE_LIMIT_ATTEMPTS:
        raise TooManyLoginAttemptsError


async def record_failed_login(ip_address: str) -> None:
    """Increment failed login attempts for the given IP."""
    try:
        redis = await get_shared_redis()
        key = _login_rate_limit_key(ip_address)
        attempts = await redis.incr(key)
        if attempts == 1:
            await redis.expire(key, LOGIN_RATE_LIMIT_WINDOW_SECONDS)
    except Exception:
        logger.exception("Failed to record login failure in Redis")


async def clear_failed_login_attempts(ip_address: str) -> None:
    """Clear failed login attempt state after a successful login."""
    try:
        redis = await get_shared_redis()
        await redis.delete(_login_rate_limit_key(ip_address))
    except Exception:
        logger.exception("Failed to clear login failure counter in Redis")


def sanitize_next_path(candidate: str | None, default: str = "/map") -> str:
    """Allow only local absolute paths for login redirects."""
    if not candidate:
        return default
    parsed = urlparse(candidate)
    if parsed.scheme or parsed.netloc:
        return default
    path = parsed.path or default
    if not path.startswith("/"):
        return default
    query = f"?{parsed.query}" if parsed.query else ""
    return f"{path}{query}"


def build_login_redirect_target(request: Request) -> str:
    """Return a login URL with the current path preserved as next=."""
    path = request.url.path
    if request.url.query:
        path = f"{path}?{request.url.query}"
    return f"/login?next={quote(path, safe='/?=&')}"


def is_public_page_path(path: str) -> bool:
    """Return whether an HTML page is viewer-safe."""
    return path in PUBLIC_PAGE_PATHS


def is_owner_page_path(path: str) -> bool:
    """Return whether an HTML page is owner-only."""
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in OWNER_PAGE_PREFIXES)


def is_public_request(method: str, path: str) -> bool:
    """Return whether a request path is public without owner auth."""
    normalized_method = method.upper()

    if normalized_method == "OPTIONS":
        return True

    if path in PUBLIC_EXACT_PATHS:
        return True

    if any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES):
        return True

    if normalized_method in SAFE_METHODS:
        if path in PUBLIC_SAFE_API_PATHS:
            return True
        if any(path.startswith(prefix) for prefix in PUBLIC_SAFE_API_PREFIXES):
            return True
        if is_public_page_path(path):
            return True
        return False

    if path in PUBLIC_MUTATION_PATHS:
        return True

    return any(path.startswith(prefix) for prefix in PUBLIC_MUTATION_PREFIXES)


def is_html_request(request: Request) -> bool:
    """Best-effort HTML request detection for redirect behavior."""
    path = request.url.path
    accept = (request.headers.get("accept") or "").lower()
    if path.startswith("/api/"):
        return False
    return "text/html" in accept or is_public_page_path(path) or is_owner_page_path(path)


async def validate_csrf(request: Request) -> bool:
    """Validate CSRF token from the request header."""
    context = get_request_auth_context(request)
    expected_token = context.csrf_token
    if not expected_token:
        return False

    provided = request.headers.get(CSRF_HEADER_NAME)
    return bool(provided) and secrets.compare_digest(provided, expected_token)


def validate_form_csrf_token(request: Request, provided_token: str | None) -> bool:
    """Validate a CSRF token already parsed from a form endpoint."""
    context = get_request_auth_context(request)
    expected_token = context.csrf_token
    return bool(
        expected_token
        and provided_token
        and secrets.compare_digest(provided_token, expected_token),
    )


def should_defer_csrf_to_form_handler(request: Request) -> bool:
    """Return whether a known HTML form route validates CSRF in the endpoint."""
    path = request.url.path
    if path not in FORM_CSRF_PATHS:
        return False
    content_type = (request.headers.get("content-type") or "").lower()
    return (
        "application/x-www-form-urlencoded" in content_type
        or "multipart/form-data" in content_type
    )


def unauthorized_api_response() -> JSONResponse:
    """Return the standard owner-auth-required API response."""
    return JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"detail": "Owner session required."},
    )


async def guard_request(request: Request) -> Response | None:
    """Apply shared auth + CSRF policy for HTTP requests."""
    context = get_request_auth_context(request)
    refresh_owner_session(request)

    method = request.method.upper()
    path = request.url.path

    if is_public_request(method, path):
        return None

    if not context.is_owner:
        if is_html_request(request):
            return RedirectResponse(
                url=build_login_redirect_target(request),
                status_code=status.HTTP_303_SEE_OTHER,
            )
        return unauthorized_api_response()

    if method not in SAFE_METHODS and should_defer_csrf_to_form_handler(request):
        return None

    if method not in SAFE_METHODS and not await validate_csrf(request):
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": "Invalid CSRF token."},
        )

    return None


async def auth_guard_dispatch(request: Request, call_next) -> Response:
    """BaseHTTPMiddleware dispatch that applies the shared auth policy."""
    response = await guard_request(request)
    if response is not None:
        return response
    return await call_next(request)


def require_owner_websocket(websocket: WebSocket) -> AuthContext:
    """Require an owner session for websocket connections."""
    context = get_request_auth_context(websocket)
    if not context.is_owner:
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Owner session required.",
        )
    return context


def parse_cors_allowed_origins() -> list[str]:
    """Return explicit allowed origins for credentialed requests."""
    raw = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return [
        "https://www.everystreet.me",
        "https://everystreet.me",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]


def parse_allowed_hosts() -> list[str]:
    """Return explicit allowed hosts for TrustedHostMiddleware."""
    raw = os.getenv("ALLOWED_HOSTS", "").strip()
    if raw:
        return [host.strip() for host in raw.split(",") if host.strip()]
    return [
        "www.everystreet.me",
        "everystreet.me",
        "localhost",
        "127.0.0.1",
        "*.localhost",
    ]


class TooManyLoginAttemptsError(RuntimeError):
    """Raised when the login rate limit is exhausted."""


class AuthGuardMiddleware(BaseHTTPMiddleware):
    """HTTP middleware wrapper around the shared auth guard."""

    async def dispatch(self, request: Request, call_next) -> Response:
        return await auth_guard_dispatch(request, call_next)
