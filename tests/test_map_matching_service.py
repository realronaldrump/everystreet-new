import asyncio
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


def test_matching_engine_payload_reports_missing_mapbox_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MAPBOX_MAP_MATCHING_TOKEN", raising=False)

    payload = MapMatchingJobRunner._matching_engine_payload("auto")

    assert payload == {
        "provider_policy": "auto",
        "mapbox_available": False,
        "label": "Auto: Valhalla only, Mapbox token missing",
    }


def test_matching_engine_payload_reports_available_mapbox_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MAPBOX_MAP_MATCHING_TOKEN", "sk.test-token")

    payload = MapMatchingJobRunner._matching_engine_payload("auto")

    assert payload == {
        "provider_policy": "auto",
        "mapbox_available": True,
        "label": "Auto: Valhalla first, Mapbox fallback available",
    }


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
async def test_preflight_auto_allows_mapbox_when_valhalla_status_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = MapMatchingJobRunner()
    runner._active_provider_policy = "auto"
    monkeypatch.setenv("MAPBOX_MAP_MATCHING_TOKEN", "sk.test-token")

    async def fail_get_router() -> None:
        raise RuntimeError("Valhalla unavailable")

    monkeypatch.setattr(map_matching_jobs, "get_router", fail_get_router)

    ready, message = await runner._preflight_router()

    assert ready is True
    assert message is None


@pytest.mark.asyncio
async def test_preflight_auto_blocks_without_any_ready_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = MapMatchingJobRunner()
    runner._active_provider_policy = "auto"
    monkeypatch.delenv("MAPBOX_MAP_MATCHING_TOKEN", raising=False)

    async def fail_get_router() -> None:
        raise RuntimeError("Valhalla unavailable")

    monkeypatch.setattr(map_matching_jobs, "get_router", fail_get_router)

    ready, message = await runner._preflight_router()

    assert ready is False
    assert message == "Routing provider not ready: Valhalla unavailable"


@pytest.mark.asyncio
async def test_provider_summary_counts_historical_matches_by_provider(
    beanie_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del beanie_db
    monkeypatch.setenv("MAPBOX_MAP_MATCHING_TOKEN", "sk.test-token")
    line = {"type": "LineString", "coordinates": [[-97.0, 32.0], [-97.1, 32.1]]}

    await Trip(
        transactionId="tx-valhalla",
        source="bouncie",
        matchedGps=line,
        matchProvider="valhalla",
    ).insert()
    await Trip(
        transactionId="tx-mapbox-fallback",
        source="bouncie",
        matchedGps=line,
        matchProvider="mapbox",
        matchFallbackUsed=True,
    ).insert()
    await Trip(
        transactionId="tx-mapbox-only",
        source="bouncie",
        matchedGps=line,
        matchProvider="mapbox",
        matchFallbackUsed=False,
    ).insert()
    await Trip(
        transactionId="tx-no-engine-tag",
        source="bouncie",
        matchedGps=line,
    ).insert()
    await Trip(
        transactionId="tx-failed",
        source="bouncie",
        matchStatus="error:no-geometry",
    ).insert()
    await Trip(
        transactionId="tx-skipped",
        source="bouncie",
        matchStatus="skipped:no-gps",
    ).insert()
    await Trip(transactionId="tx-unmatched", source="bouncie").insert()
    await Trip(
        transactionId="tx-live-ignored",
        source="live",
        matchedGps=line,
        matchProvider="mapbox",
    ).insert()

    summary = await MapMatchingJobService().provider_summary()

    assert summary["total"] == 7
    assert summary["matched"] == 4
    assert summary["unmatched"] == 3
    assert summary["valhalla_matched"] == 1
    assert summary["mapbox_matched"] == 2
    assert summary["mapbox_fallback_matched"] == 1
    assert summary["mapbox_only_matched"] == 1
    assert summary["untracked_matched"] == 1
    assert summary["failed"] == 1
    assert summary["skipped"] == 1
    assert summary["matching_engine"]["mapbox_available"] is True


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

    async def fake_process_trips_directly(
        *_args: Any, **_kwargs: Any
    ) -> dict[str, int]:
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


@pytest.mark.asyncio
async def test_map_matching_job_marks_progress_failed_when_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = MapMatchingJobRunner()
    progress = SimpleNamespace(
        id="progress-1",
        stage="processing",
        status="running",
        progress=32,
        message="Processing",
        error=None,
        metadata={},
        updated_at=None,
        completed_at=None,
        save=AsyncMock(),
    )

    class FakeFind:
        async def to_list(self) -> list[Any]:
            return [SimpleNamespace(transactionId="tx-1")]

    monkeypatch.setattr(
        runner,
        "_get_or_create_progress",
        AsyncMock(return_value=progress),
    )
    monkeypatch.setattr(
        runner,
        "_preflight_router",
        AsyncMock(return_value=(True, None)),
    )
    monkeypatch.setattr(
        runner,
        "_process_trips_directly",
        AsyncMock(side_effect=asyncio.CancelledError()),
    )
    monkeypatch.setattr(runner, "_update_progress", AsyncMock())
    monkeypatch.setattr(map_matching_jobs.Trip, "find", lambda _query: FakeFind())
    monkeypatch.setattr(map_matching_jobs, "find_job", AsyncMock(return_value=progress))

    with pytest.raises(asyncio.CancelledError):
        await runner.run(
            "job-1",
            MapMatchJobRequest(mode="trip_ids", trip_ids=["tx-1"]),
        )

    assert progress.status == "failed"
    assert progress.stage == "error"
    assert progress.error == "Task cancelled before completion."
    progress.save.assert_awaited_once()
