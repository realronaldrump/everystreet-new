from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from mongomock_motor import AsyncMongoMockClient

from core.date_utils import parse_timestamp
from db.models import AppSettings, ServerLog
from logs.api import clear_server_logs, get_logs_stats, get_server_logs


@pytest.fixture
async def logs_beanie_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(database=database, document_models=[AppSettings, ServerLog])
    return database


@pytest.mark.asyncio
async def test_soft_clear_sets_cutoff_and_filters_queries(
    logs_beanie_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Avoid any real Redis/ARQ work during the unit test.
    async def _no_arq_pool():
        raise RuntimeError("arq disabled for tests")

    monkeypatch.setattr("tasks.arq.get_arq_pool", _no_arq_pool)

    clear_result = await clear_server_logs()
    assert clear_result["soft_cleared"] is True

    cutoff_dt = parse_timestamp(clear_result["cutoff_timestamp"])
    assert cutoff_dt is not None

    await ServerLog(
        timestamp=cutoff_dt - timedelta(seconds=1),
        level="INFO",
        logger_name="test",
        message="before",
    ).insert()
    await ServerLog(
        timestamp=cutoff_dt + timedelta(seconds=1),
        level="INFO",
        logger_name="test",
        message="after",
    ).insert()

    logs_result = await get_server_logs(limit=1000)
    assert logs_result["returned_count"] == 1
    assert logs_result["logs"][0].message == "after"

    stats_result = await get_logs_stats()
    assert stats_result["total_count"] == 1


@pytest.mark.asyncio
async def test_filtered_clear_hard_deletes_without_cutoff(
    logs_beanie_db,
) -> None:
    now = datetime.now(UTC)
    await ServerLog(
        timestamp=now - timedelta(minutes=5),
        level="INFO",
        logger_name="test",
        message="a",
    ).insert()
    await ServerLog(
        timestamp=now - timedelta(minutes=4),
        level="ERROR",
        logger_name="test",
        message="b",
    ).insert()

    result = await clear_server_logs(level="INFO")
    assert result["soft_cleared"] is False
    assert result["deleted_count"] == 1

    settings = await AppSettings.find_one()
    assert settings is None

