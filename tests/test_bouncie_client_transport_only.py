from __future__ import annotations

from datetime import UTC, datetime

from aiohttp import ClientResponseError
import pytest

from core.clients.bouncie import BouncieClient


class _ResponseStub:
    def __init__(self, payload, *, status: int = 200):
        self._payload = payload
        self._status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        del exc_type, exc, tb
        return False

    def raise_for_status(self) -> None:
        if self._status >= 400:
            raise ClientResponseError(
                request_info=None,
                history=(),
                status=self._status,
                message="error",
                headers=None,
            )
        return

    async def json(self):
        return self._payload


class _SessionStub:
    def __init__(self, payloads):
        if isinstance(payloads, list) and payloads and all(
            isinstance(payload, _ResponseStub) for payload in payloads
        ):
            self._payloads = payloads
        else:
            self._payloads = [payloads]
        self.requests = []

    def get(self, *args, **kwargs):
        self.requests.append((args, kwargs))
        payload = self._payloads.pop(0)
        if isinstance(payload, _ResponseStub):
            return payload
        return _ResponseStub(payload)


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


@pytest.mark.asyncio
async def test_resilient_trip_fetch_refreshes_token_once_on_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = [
        {
            "transactionId": "tx-1",
            "startTime": "2026-03-01T10:00:00Z",
            "endTime": "2026-03-01T11:00:00Z",
        },
    ]
    session = _SessionStub(
        [
            _ResponseStub({}, status=401),
            _ResponseStub(payload),
        ],
    )
    refresh_flags: list[bool] = []

    async def fake_get_access_token(session_arg, credentials, *, force_refresh=False):
        del session_arg, credentials
        refresh_flags.append(force_refresh)
        return "fresh-token"

    monkeypatch.setattr(
        "core.clients.bouncie.BouncieOAuth.get_access_token",
        fake_get_access_token,
    )

    client = BouncieClient(session=session, credentials={})
    trips = await client.fetch_trips_for_device_resilient(
        "stale-token",
        "359486068397551",
        datetime(2020, 3, 1, tzinfo=UTC),
        datetime(2020, 3, 2, tzinfo=UTC),
    )

    assert trips == payload
    assert refresh_flags == [True]
    assert session.requests[0][1]["headers"]["Authorization"] == "stale-token"
    assert session.requests[1][1]["headers"]["Authorization"] == "fresh-token"
