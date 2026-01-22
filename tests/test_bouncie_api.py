from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from http_fakes import FakeResponse, FakeSession
from setup.services.bouncie_api import (
    BouncieRateLimitError,
    BouncieUnauthorizedError,
    fetch_all_vehicles,
)


@pytest.mark.asyncio
async def test_fetch_all_vehicles_paginates() -> None:
    session = FakeSession(
        get_responses=[
            FakeResponse(status=200, json_data=[{"imei": "1"}, {"imei": "2"}]),
            FakeResponse(status=200, json_data=[{"imei": "3"}]),
        ],
    )

    vehicles = await fetch_all_vehicles(session, "token", limit=2)

    assert len(vehicles) == 3
    assert session.requests[0][2]["params"] == {"limit": 2, "skip": 0}
    assert session.requests[1][2]["params"] == {"limit": 2, "skip": 2}


@pytest.mark.asyncio
async def test_fetch_all_vehicles_unauthorized() -> None:
    session = FakeSession(
        get_responses=[FakeResponse(status=401, text_data="unauthorized")],
    )

    with pytest.raises(BouncieUnauthorizedError):
        await fetch_all_vehicles(session, "token", limit=2)


@pytest.mark.asyncio
async def test_fetch_all_vehicles_rate_limited(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakeSession(
        get_responses=[
            FakeResponse(status=429, text_data="rate limited"),
            FakeResponse(status=429, text_data="rate limited"),
            FakeResponse(status=429, text_data="rate limited"),
            FakeResponse(status=429, text_data="rate limited"),
        ],
    )
    monkeypatch.setattr(
        "setup.services.bouncie_api.asyncio.sleep",
        AsyncMock(),
    )

    with pytest.raises(BouncieRateLimitError):
        await fetch_all_vehicles(session, "token", limit=2)
