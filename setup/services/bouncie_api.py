"""Bouncie API helpers for vehicle retrieval."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

from config import API_BASE_URL

logger = logging.getLogger(__name__)

DEFAULT_VEHICLE_PAGE_LIMIT = 100
MAX_RATE_LIMIT_RETRIES = 3
DEFAULT_RETRY_AFTER_SECONDS = 1
MAX_RETRY_AFTER_SECONDS = 10


class BouncieApiError(RuntimeError):
    """Base class for Bouncie API errors."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class BouncieUnauthorizedError(BouncieApiError):
    """Raised when the Bouncie API returns 401/403."""


class BouncieRateLimitError(BouncieApiError):
    """Raised when the Bouncie API rate limits requests."""


def _retry_after_seconds(headers: Any) -> int:
    value = None
    if isinstance(headers, dict):
        value = headers.get("Retry-After")
    if value is None:
        return DEFAULT_RETRY_AFTER_SECONDS
    try:
        seconds = int(str(value).strip())
    except ValueError:
        return DEFAULT_RETRY_AFTER_SECONDS
    return max(1, min(seconds, MAX_RETRY_AFTER_SECONDS))


async def _fetch_vehicle_page(
    session: aiohttp.ClientSession,
    token: str,
    *,
    limit: int,
    skip: int,
) -> list[dict[str, Any]]:
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
    }
    params = {"limit": limit, "skip": skip}
    url = f"{API_BASE_URL}/vehicles"

    for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
        async with session.get(url, headers=headers, params=params) as response:
            if response.status == 429:
                retry_after = _retry_after_seconds(response.headers)
                logger.warning(
                    "Bouncie API rate limit hit (skip=%d, limit=%d). Retrying in %d seconds.",
                    skip,
                    limit,
                    retry_after,
                )
                if attempt >= MAX_RATE_LIMIT_RETRIES:
                    error_text = await response.text()
                    raise BouncieRateLimitError(
                        f"Rate limited by Bouncie API after {attempt + 1} attempts: {error_text}",
                        status=response.status,
                    )
                await asyncio.sleep(retry_after)
                continue

            if response.status in {401, 403}:
                error_text = await response.text()
                raise BouncieUnauthorizedError(
                    f"Bouncie API unauthorized: {error_text}",
                    status=response.status,
                )

            if response.status != 200:
                error_text = await response.text()
                raise BouncieApiError(
                    f"Bouncie API error {response.status}: {error_text}",
                    status=response.status,
                )

            payload = await response.json()
            if not isinstance(payload, list):
                raise BouncieApiError(
                    "Unexpected vehicles response format; expected list",
                    status=response.status,
                )
            logger.debug(
                "Fetched Bouncie vehicles page: skip=%d limit=%d count=%d",
                skip,
                limit,
                len(payload),
            )
            return payload

    raise BouncieRateLimitError("Rate limited by Bouncie API", status=429)


async def fetch_all_vehicles(
    session: aiohttp.ClientSession,
    token: str,
    *,
    limit: int = DEFAULT_VEHICLE_PAGE_LIMIT,
) -> list[dict[str, Any]]:
    """Fetch all vehicles, handling pagination and rate limiting."""
    all_vehicles: list[dict[str, Any]] = []
    limit = max(1, limit)
    skip = 0

    while True:
        page = await _fetch_vehicle_page(
            session,
            token,
            limit=limit,
            skip=skip,
        )
        if not page:
            break

        all_vehicles.extend(page)
        if len(page) < limit:
            break

        skip += limit

    return all_vehicles
