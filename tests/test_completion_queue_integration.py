import os
from urllib.parse import urlparse

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from arq.jobs import Job

from trips.services import completed_trip_sync

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


@pytest.fixture
async def completion_queue(monkeypatch):
    url = os.environ.get("WORKFLOW_TEST_REDIS_URL")
    if not url:
        pytest.skip("Requires an isolated Redis via WORKFLOW_TEST_REDIS_URL")
    parsed = urlparse(url)
    assert parsed.hostname == "everystreet-workflow-redis"
    redis = await create_pool(
        RedisSettings(host=parsed.hostname, port=parsed.port or 6379, database=3)
    )
    await redis.flushdb()

    async def pool():
        return redis

    monkeypatch.setattr(completed_trip_sync, "get_arq_pool", pool)
    yield redis
    await redis.flushdb()
    await redis.aclose()


async def test_real_queue_deduplicates_and_stores_only_the_transaction_id(
    completion_queue,
):
    assert await completed_trip_sync.enqueue_completed_trip_sync("queue-test-trip")
    assert not await completed_trip_sync.enqueue_completed_trip_sync("queue-test-trip")
    info = await Job(
        completed_trip_sync.sync_job_id("queue-test-trip"), redis=completion_queue
    ).info()
    assert info.function == "sync_completed_trip"
    assert info.args == ("queue-test-trip",)
    assert info.kwargs == {}
    status = await completed_trip_sync.completion_sync_status()
    assert status["pending"] == 1
    assert status["failed"] == 0


async def test_failed_completion_status_is_visible_and_can_be_requeued(
    completion_queue,
):
    await completed_trip_sync._set_status(
        "failed-test-trip", "failed", attempt=8, error="Provider unavailable"
    )
    assert (await completed_trip_sync.completion_sync_status())["failed"] == 1
    assert await completed_trip_sync.retry_failed_completion_syncs() == 1
    status = await completed_trip_sync.completion_sync_status()
    assert status["failed"] == 0
    assert status["pending"] == 1
