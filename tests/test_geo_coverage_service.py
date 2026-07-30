from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from shapely import STRtree
from shapely.geometry import Point, box

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


def test_build_trip_query_always_scans_all_valid_historical_trips() -> None:
    query = service._build_trip_query()

    assert query["source"] == "bouncie"
    assert query["invalid"] == {"$ne": True}
    assert query["inactive"] == {"$ne": True}
    assert "isInvalid" not in query
    assert "lastUpdate" not in str(query)


def test_boundary_identifiers_and_geometry_must_be_usable() -> None:
    assert service._county_fips(1001) == "01001"
    assert service._county_fips(None) is None
    assert service._county_fips("not-fips") is None
    assert service._valid_state_fips("1") == "01"
    assert service._valid_state_fips("bad") is None
    assert service._valid_boundary_geometry({}) is None


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


def test_point_trip_records_boundary_visit_as_well_as_stop() -> None:
    boundary = box(-98.0, 29.0, -96.0, 31.0)
    boundaries = [boundary]
    visits: dict[str, dict[str, datetime | None]] = {}
    visit_time = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)

    service._record_boundary_visits(
        trip_geometry=Point(-97.0, 30.0),
        boundary_tree=STRtree(boundaries),
        boundary_index_lookup=service._build_query_index(boundaries),
        boundary_shapes=boundaries,
        boundary_ids=["boundary-1"],
        visit_map=visits,
        visit_time=visit_time,
    )

    assert visits == {
        "boundary-1": {"firstVisit": visit_time, "lastVisit": visit_time}
    }


@pytest.mark.parametrize("field", ["lastStop", "firstVisit", "lastVisit"])
def test_descending_activity_sort_puts_missing_dates_last(field: str) -> None:
    rows = [
        {"name": "Never", field: None},
        {"name": "Older", field: "2026-01-01T00:00:00+00:00"},
        {"name": "Newer", field: "2026-02-01T00:00:00+00:00"},
    ]

    rows.sort(key=lambda row: service._descending_activity_sort_key(row, field))

    assert [row["name"] for row in rows] == ["Newer", "Older", "Never"]


@pytest.mark.asyncio
async def test_get_summary_merges_city_state_totals_with_normalized_fips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    county_cache = SimpleNamespace(
        counties={},
        stopped_counties={},
        state_rollups={
            "01": {"stateName": "Alabama", "total": 67},
        },
        updated_at=None,
    )
    city_cache = SimpleNamespace(
        state_rollups={
            "1": {
                "stateName": "Alabama",
                "total": 5,
                "visited": 0,
                "stopped": 0,
            }
        },
        updated_at=None,
    )
    monkeypatch.setattr(
        service.CountyVisitedCache,
        "get",
        AsyncMock(return_value=county_cache),
    )
    monkeypatch.setattr(
        service.CityVisitedCache,
        "get",
        AsyncMock(return_value=city_cache),
    )

    summary = await service.get_summary()

    assert summary["levels"]["city"]["total"] == 5
    alabama = next(row for row in summary["states"] if row.get("stateFips") == "01")
    assert alabama["city"]["total"] == 5
