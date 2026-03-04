"""HTTP client utilities and session management."""

from core.http.blocklist import DEFAULT_FORBIDDEN_HOSTS, is_forbidden_host
from core.http.nominatim import (
    NominatimClient,
)
from core.http.request import request_json
from core.http.retry import retry_async
from core.http.session import cleanup_session, get_session
from core.http.valhalla import ValhallaClient

__all__ = [
    "DEFAULT_FORBIDDEN_HOSTS",
    "NominatimClient",
    "ValhallaClient",
    "cleanup_session",
    "get_session",
    "is_forbidden_host",
    "request_json",
    "retry_async",
]
