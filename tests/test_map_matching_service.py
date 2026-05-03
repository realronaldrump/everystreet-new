from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from db.models import Trip
from trips.models import MapMatchJobRequest
from trips.services import map_matching_jobs
from trips.services.map_matching_jobs import MapMatchingJobRunner, MapMatchingJobService


def test_normalize_request_requires_trip_id() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="trip_id")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_requires_trip_ids() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="trip_ids")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_requires_date_range() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(mode="date_range")
    with pytest.raises(HTTPException):
        service._normalize_request(request)


def test_normalize_request_rematch_clears_unmatched_only() -> None:
    service = MapMatchingJobService()
    request = MapMatchJobRequest(
        mode="date_range",
        start_date="2024-01-01",
        end_date="2024-01-02",
        unmatched_only=True,
        rematch=True,
    )
    normalized = service._normalize_request(request)
    assert normalized.unmatched_only is False


def test_build_query_unmatched_sets_filter() -> None:
    request = MapMatchJobRequest(mode="unmatched")
    query = MapMatchingJobRunner._build_query(request)
    assert query.get("matchedGps") is None
    assert query.get("matchStatus") == {
        "$not": {
            "$regex": "^(?:skipped:|error:)",
            "$options": "i",
        },
    }


@pytest.mark.asyncio
async def test_map_matching_job_bumps_revision_once_for_changed_batch(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-job-1",
        source="bouncie",
        startTime=datetime(2025, 1, 1, tzinfo=UTC),
        endTime=datetime(2025, 1, 1, 1, tzinfo=UTC),
    ).insert()
    await Trip(
        transactionId="tx-job-2",
        source="bouncie",
        startTime=datetime(2025, 1, 2, tzinfo=UTC),
        endTime=datetime(2025, 1, 2, 1, tzinfo=UTC),
    ).insert()

    runner = MapMatchingJobRunner()
    bump_revision = AsyncMock()

    async def fake_preflight_router() -> tuple[bool, None]:
        return True, None

    async def fake_get_progress(_job_id: str) -> Any:
        return SimpleNamespace(stage="initializing", status="running")

    async def fake_update_progress(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def fake_process_trips_directly(*_args: Any, **_kwargs: Any) -> dict[str, int]:
        return {
            "matched": 2,
            "failed": 0,
            "skipped": 0,
            "processed": 2,
            "changed": 2,
        }

    monkeypatch.setattr(runner, "_preflight_router", fake_preflight_router)
    monkeypatch.setattr(runner, "_get_or_create_progress", fake_get_progress)
    monkeypatch.setattr(runner, "_update_progress", fake_update_progress)
    monkeypatch.setattr(
        runner,
        "_process_trips_directly",
        fake_process_trips_directly,
    )
    monkeypatch.setattr(map_matching_jobs, "bump_trip_map_revision", bump_revision)

    result = await runner.run(
        "job-1",
        MapMatchJobRequest(
            mode="trip_ids",
            trip_ids=["tx-job-1", "tx-job-2"],
        ),
    )

    assert result["status"] == "success"
    assert result["map_matched"] == 2
    assert bump_revision.await_count == 1
