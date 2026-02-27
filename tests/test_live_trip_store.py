from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tracking.services import live_trip_store


@pytest.mark.asyncio
async def test_save_trip_snapshot_stores_to_redis() -> None:
    """save_trip_snapshot should set keys via pipeline."""
    fake_pipe = AsyncMock()
    fake_redis = AsyncMock()
    fake_redis.pipeline.return_value = fake_pipe

    trip = {"transactionId": "tx-1", "status": "active"}

    with patch.object(live_trip_store, "get_shared_redis", return_value=fake_redis):
        await live_trip_store.save_trip_snapshot(trip)

    fake_pipe.execute.assert_awaited_once()


@pytest.mark.asyncio
async def test_save_trip_snapshot_rejects_missing_tx_id() -> None:
    """save_trip_snapshot should raise ValueError if transactionId is missing."""
    with pytest.raises(ValueError, match="transactionId"):
        await live_trip_store.save_trip_snapshot({})
