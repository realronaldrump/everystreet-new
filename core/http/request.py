"""
Shared HTTP request helpers for service backends.

Keeps JSON request/response handling and error mapping consistent across
Valhalla and Nominatim clients.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from core.exceptions import ExternalServiceException
from core.http.blocklist import is_forbidden_host

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)


async def request_json(
    method: str,
    url: str,
    *,
    session: Any,
    params: dict[str, Any] | None = None,
    json: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    expected_status: int | Iterable[int] = 200,
    none_on: Iterable[int] | None = None,
    service_name: str = "Service",
    timeout: Any | None = None,
) -> Any | None:
    method_upper = method.upper()
    if isinstance(expected_status, int):
        expected = {expected_status}
    else:
        expected = set(expected_status)
    none_on_set = set(none_on or [])

    if is_forbidden_host(url):
        msg = f"{service_name} blocked host: {url}"
        raise ValueError(msg)

    if method_upper == "GET":
        request_fn = session.get
    elif method_upper == "POST":
        request_fn = session.post
    else:
        request_fn = getattr(session, "request", None)
        if request_fn is None:
            msg = f"{service_name} request error: unsupported method {method_upper}"
            raise ExternalServiceException(msg, {"url": url})

    request_kwargs: dict[str, Any] = {
        "params": params,
        "json": json,
        "headers": headers,
    }
    if timeout is not None:
        request_kwargs["timeout"] = timeout

    async with request_fn(url, **request_kwargs) as response:
        if response.status in none_on_set:
            logger.debug("%s returned %s for %s", service_name, response.status, url)
            return None
        if response.status == 429:
            retry_after = int(response.headers.get("Retry-After", 5))
            msg = f"{service_name} error: 429"
            raise ExternalServiceException(
                msg,
                {
                    "status": 429,
                    "retry_after": retry_after,
                    "url": str(getattr(response, "url", url)),
                },
            )
        if response.status not in expected:
            body = await response.text()
            msg = f"{service_name} error: {response.status}"
            raise ExternalServiceException(
                msg,
                {
                    "status": response.status,
                    "body": body,
                    "url": str(getattr(response, "url", url)),
                },
            )
        return await response.json()
