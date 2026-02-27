from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from trips import events


@pytest.mark.asyncio
async def test_publish_trip_state_publishes_message() -> None:
    """publish_trip_state should publish JSON to the trip updates channel."""
    fake_redis = AsyncMock()
    fake_redis.publish.return_value = 1

    with patch.object(events, "get_shared_redis", return_value=fake_redis):
        result = await events.publish_trip_state(
            "tx-123",
            {"foo": "bar"},
            status="active",
        )

    assert result is True
    fake_redis.publish.assert_awaited_once()
    call_args = fake_redis.publish.call_args
    assert call_args[0][0] == events.TRIP_UPDATES_CHANNEL


@pytest.mark.asyncio
async def test_publish_trip_state_returns_false_on_error() -> None:
    """publish_trip_state should return False when Redis fails."""
    fake_redis = AsyncMock()
    fake_redis.publish.side_effect = RuntimeError("connection lost")

    with patch.object(events, "get_shared_redis", return_value=fake_redis):
        result = await events.publish_trip_state("tx-456", {"foo": "bar"})

    assert result is False
