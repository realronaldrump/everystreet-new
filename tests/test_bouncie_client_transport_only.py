from __future__ import annotations

import pytest

from core.clients.bouncie import BouncieClient


class _ResponseStub:
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        del exc_type, exc, tb
        return False

    def raise_for_status(self) -> None:
        return

    async def json(self):
        return self._payload


class _SessionStub:
    def __init__(self, payload):
        self._payload = payload

    def get(self, *_args, **_kwargs):
        return _ResponseStub(self._payload)


@pytest.mark.asyncio
async def test_fetch_trip_by_transaction_id_returns_raw_payload() -> None:
    payload = [
        {
            "transactionId": "tx-1",
            "startTime": "2026-03-01T10:00:00Z",
            "endTime": "2026-03-01T11:00:00Z",
            "timeZone": "America/Chicago",
        },
    ]

    client = BouncieClient(session=_SessionStub(payload), credentials={})
    trips = await client.fetch_trip_by_transaction_id("Bearer token", "tx-1")

    assert trips == payload
    assert isinstance(trips[0]["startTime"], str)
    assert isinstance(trips[0]["endTime"], str)
