from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from trips import events


class _FakeRedisClient:
    def __init__(self) -> None:
        self.ping_calls = 0

    async def ping(self) -> None:
        self.ping_calls += 1


@pytest.fixture(autouse=True)
def reset_trip_events_redis_state() -> None:
    events.RedisClientState.client = None
    yield
    events.RedisClientState.client = None


@pytest.mark.asyncio
async def test_get_redis_client_constructs_client_without_awaiting_from_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = _FakeRedisClient()
    from_url_mock = MagicMock(return_value=fake_client)

    monkeypatch.setattr(events, "get_redis_url", lambda: "redis://test:6379")
    monkeypatch.setattr(events.aioredis, "from_url", from_url_mock)

    result = await events.get_redis_client()

    assert result is fake_client
    from_url_mock.assert_called_once_with("redis://test:6379", decode_responses=True)
    assert fake_client.ping_calls == 1
