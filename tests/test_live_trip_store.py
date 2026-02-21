from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from tracking.services import live_trip_store


class _FakeRedisClient:
    def __init__(self) -> None:
        self.ping_calls = 0

    async def ping(self) -> None:
        self.ping_calls += 1


@pytest.fixture(autouse=True)
def reset_live_trip_redis_state() -> None:
    live_trip_store._RedisState.client = None
    yield
    live_trip_store._RedisState.client = None


@pytest.mark.asyncio
async def test_get_redis_client_constructs_client_without_awaiting_from_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_client = _FakeRedisClient()
    from_url_mock = MagicMock(return_value=fake_client)

    monkeypatch.setattr(live_trip_store, "get_redis_url", lambda: "redis://test:6379")
    monkeypatch.setattr(live_trip_store.aioredis, "from_url", from_url_mock)

    result = await live_trip_store._get_redis_client()

    assert result is fake_client
    from_url_mock.assert_called_once_with("redis://test:6379", decode_responses=True)
    assert fake_client.ping_calls == 1
