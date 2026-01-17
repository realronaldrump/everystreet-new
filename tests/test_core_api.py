import logging

import pytest
from fastapi import HTTPException, status

from core.api import api_route
from core.exceptions import (
    AuthenticationException,
    AuthorizationException,
    DuplicateResourceException,
    ExternalServiceException,
    RateLimitException,
    ResourceNotFoundException,
    ValidationException,
)

logger = logging.getLogger("tests.core_api")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("exc", "expected_status", "expected_detail"),
    [
        (ValidationException("bad input"), status.HTTP_400_BAD_REQUEST, "bad input"),
        (
            ResourceNotFoundException("missing"),
            status.HTTP_404_NOT_FOUND,
            "missing",
        ),
        (
            DuplicateResourceException("duplicate"),
            status.HTTP_409_CONFLICT,
            "duplicate",
        ),
        (
            AuthenticationException("no auth"),
            status.HTTP_401_UNAUTHORIZED,
            "no auth",
        ),
        (
            AuthorizationException("no perms"),
            status.HTTP_403_FORBIDDEN,
            "no perms",
        ),
        (
            RateLimitException("slow down"),
            status.HTTP_429_TOO_MANY_REQUESTS,
            "slow down",
        ),
        (
            ExternalServiceException("upstream down"),
            status.HTTP_502_BAD_GATEWAY,
            "External service error: upstream down",
        ),
    ],
)
async def test_api_route_maps_domain_exceptions(
    exc: Exception,
    expected_status: int,
    expected_detail: str,
) -> None:
    @api_route(logger)
    async def handler():
        raise exc

    with pytest.raises(HTTPException) as raised:
        await handler()

    assert raised.value.status_code == expected_status
    assert raised.value.detail == expected_detail


@pytest.mark.asyncio
async def test_api_route_allows_http_exception_passthrough() -> None:
    @api_route(logger)
    async def handler():
        raise HTTPException(status_code=418, detail="nope")

    with pytest.raises(HTTPException) as raised:
        await handler()

    assert raised.value.status_code == 418
    assert raised.value.detail == "nope"


@pytest.mark.asyncio
async def test_api_route_wraps_unexpected_exception() -> None:
    @api_route(logger)
    async def handler():
        raise ValueError("boom")

    with pytest.raises(HTTPException) as raised:
        await handler()

    assert raised.value.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
    assert raised.value.detail == "boom"
