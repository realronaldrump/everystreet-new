from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bson import ObjectId

from geo_coverage.services import geo_coverage_service as service


class _FakeGeoRecalcJob:
    def __init__(
        self,
        *,
        status: str,
        updated_at: datetime,
        created_at: datetime | None = None,
    ) -> None:
        self.status = status
        self.updated_at = updated_at
        self.started_at = updated_at
        self.created_at = created_at or updated_at
        self.completed_at = None
        self.stage = "Processing"
        self.progress = 12.0
        self.message = "Working..."
        self.error = None
        self.saved = False

    async def save(self) -> None:
        self.saved = True


def test_get_incremental_checkpoint_requires_both_caches_and_uses_earliest() -> None:
    county_cache = SimpleNamespace(
        last_processed_trip_at=datetime(2026, 1, 20, tzinfo=UTC),
    )
    city_cache = SimpleNamespace(
        last_processed_trip_at=datetime(2026, 1, 10, tzinfo=UTC),
    )

    checkpoint = service._get_incremental_checkpoint(county_cache, city_cache)
    assert checkpoint == datetime(2026, 1, 10, tzinfo=UTC)

    assert service._get_incremental_checkpoint(county_cache, None) is None
    assert service._get_incremental_checkpoint(None, city_cache) is None


def test_is_geo_recalc_job_stale_uses_updated_at() -> None:
    now = datetime(2026, 6, 9, 18, 0, tzinfo=UTC)
    stale_job = _FakeGeoRecalcJob(
        status="running",
        updated_at=now - timedelta(hours=7),
    )
    fresh_job = _FakeGeoRecalcJob(
        status="running",
        updated_at=now - timedelta(minutes=5),
    )
    completed_job = _FakeGeoRecalcJob(
        status="completed",
        updated_at=now - timedelta(days=1),
    )

    assert service._is_geo_recalc_job_stale(stale_job, now=now)
    assert not service._is_geo_recalc_job_stale(fresh_job, now=now)
    assert not service._is_geo_recalc_job_stale(completed_job, now=now)


@pytest.mark.asyncio
async def test_get_active_geo_recalc_job_marks_stale_jobs_and_returns_fresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    stale_job = _FakeGeoRecalcJob(
        status="running",
        updated_at=now - timedelta(hours=7),
    )
    fresh_job = _FakeGeoRecalcJob(
        status="running",
        updated_at=now - timedelta(minutes=5),
    )

    monkeypatch.setattr(
        service,
        "_get_active_geo_recalc_candidates",
        AsyncMock(return_value=[stale_job, fresh_job]),
    )

    active_job = await service._get_active_geo_recalc_job()

    assert active_job is fresh_job
    assert stale_job.saved
    assert stale_job.status == "failed"
    assert stale_job.stage == "Stale"
    assert stale_job.completed_at is not None
    assert "status was 'running'" in stale_job.error


def test_build_trip_query_uses_invalid_field_and_incremental_markers() -> None:
    baseline_query = service._build_trip_query()
    assert baseline_query["source"] == "bouncie"
    assert baseline_query["invalid"] == {"$ne": True}
    assert "isInvalid" not in baseline_query

    checkpoint = datetime(2026, 2, 1, 12, 0, tzinfo=UTC)
    incremental_query = service._build_trip_query(checkpoint)
    assert incremental_query["source"] == "bouncie"

    geometry_filter = incremental_query["$and"][0]
    assert geometry_filter["invalid"] == {"$ne": True}
    assert "isInvalid" not in geometry_filter

    checkpoint_filters = incremental_query["$and"][1]["$or"]
    assert {"saved_at": {"$gt": checkpoint}} in checkpoint_filters

    object_id_filter = next(
        (entry for entry in checkpoint_filters if "_id" in entry),
        None,
    )
    assert object_id_filter is not None
    assert isinstance(object_id_filter["_id"]["$gt"], ObjectId)


def test_trip_marker_includes_saved_at_and_object_id_generation_time() -> None:
    trip = SimpleNamespace(
        saved_at=datetime(2026, 2, 2, 10, 0, tzinfo=UTC),
        lastUpdate=datetime(2025, 12, 31, 10, 0, tzinfo=UTC),
        matched_at=None,
        endTime=None,
        startTime=None,
        id=ObjectId.from_datetime(datetime(2026, 2, 1, 0, 0, tzinfo=UTC)),
    )
    assert service._trip_marker(trip) == datetime(2026, 2, 2, 10, 0, tzinfo=UTC)

    object_id_only_time = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    id_only_trip = SimpleNamespace(
        saved_at=None,
        lastUpdate=None,
        matched_at=None,
        endTime=None,
        startTime=None,
        id=ObjectId.from_datetime(object_id_only_time),
    )
    assert service._trip_marker(id_only_trip) == object_id_only_time


def test_extract_stop_points_keeps_end_stop_for_round_trip() -> None:
    start_time = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
    end_time = datetime(2026, 1, 1, 17, 0, tzinfo=UTC)
    gps = {
        "type": "LineString",
        "coordinates": [[-97.5, 30.2], [-97.5, 30.2]],
    }

    points = service._extract_stop_points(gps, start_time, end_time, start_time)

    assert len(points) == 2
    assert points[0][1] == start_time
    assert points[1][1] == end_time


@pytest.mark.asyncio
async def test_get_summary_merges_city_state_totals_with_normalized_fips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(service.CountyVisitedCache, "get", AsyncMock(return_value=None))
    monkeypatch.setattr(service.CityVisitedCache, "get", AsyncMock(return_value=None))
    monkeypatch.setattr(
        service,
        "_get_county_state_totals",
        AsyncMock(return_value={"01": {"name": "Alabama", "total": 67}}),
    )
    monkeypatch.setattr(
        service,
        "aggregate_to_list",
        AsyncMock(
            return_value=[
                {"_id": "1", "total": 3, "state_name": "Alabama"},
                {"_id": "01", "total": 2, "state_name": "Alabama"},
            ],
        ),
    )

    summary = await service.get_summary()

    assert summary["levels"]["city"]["total"] == 5
    alabama = next(row for row in summary["states"] if row.get("stateFips") == "01")
    assert alabama["city"]["total"] == 5
