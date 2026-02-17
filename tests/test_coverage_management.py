from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from beanie import PydanticObjectId, init_beanie
from mongomock_motor import AsyncMongoMockClient

from core.coverage import (
    backfill_coverage_for_area,
    mark_segment_undriveable,
    mark_segment_undriven,
    update_coverage_for_trip,
    update_coverage_for_segments,
)
from db.models import CoverageArea, CoverageState, Job, Street, Trip
from street_coverage import ingestion as coverage_ingestion


@pytest.fixture
async def coverage_db():
    client = AsyncMongoMockClient()
    db = client["test_db"]
    await init_beanie(
        database=db,
        document_models=[CoverageArea, CoverageState, Job, Street, Trip],
    )
    return db


@pytest.mark.asyncio
async def test_update_coverage_for_segments_monotonic_and_trip_id(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Test Area",
        status="ready",
        health="healthy",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-{area.area_version}-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    trip_newer = PydanticObjectId()
    t_newer = datetime(2025, 1, 2, tzinfo=UTC)
    await CoverageState(
        area_id=area.id,
        segment_id=segment_id,
        status="driven",
        first_driven_at=t_newer,
        last_driven_at=t_newer,
        driven_by_trip_id=trip_newer,
    ).insert()

    trip_older = PydanticObjectId()
    t_older = datetime(2025, 1, 1, tzinfo=UTC)
    result = await update_coverage_for_segments(
        area_id=area.id,
        segment_ids=[segment_id],
        trip_id=trip_older,
        driven_at=t_older,
    )
    assert result.newly_driven_segment_ids == []

    state = await CoverageState.find_one(
        {"area_id": area.id, "segment_id": segment_id},
    )
    assert state is not None
    assert state.status == "driven"
    assert state.last_driven_at == t_newer
    assert state.first_driven_at == t_older
    assert state.driven_by_trip_id == trip_newer

    trip_latest = PydanticObjectId()
    t_latest = datetime(2025, 1, 3, tzinfo=UTC)
    result2 = await update_coverage_for_segments(
        area_id=area.id,
        segment_ids=[segment_id],
        trip_id=trip_latest,
        driven_at=t_latest,
    )
    assert result2.newly_driven_segment_ids == []

    state2 = await CoverageState.find_one(
        {"area_id": area.id, "segment_id": segment_id},
    )
    assert state2 is not None
    assert state2.last_driven_at == t_latest
    assert state2.first_driven_at == t_older
    assert state2.driven_by_trip_id == trip_latest


@pytest.mark.asyncio
async def test_update_coverage_for_segments_ignores_unknown_segment_ids(
    coverage_db,
) -> None:
    area = CoverageArea(
        display_name="Coverage Unknown Segment Area",
        status="ready",
        health="healthy",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
    )
    await area.insert()
    assert area.id is not None

    valid_segment_id = f"{area.id}-{area.area_version}-0"
    unknown_segment_id = f"{area.id}-{area.area_version}-missing"
    await Street(
        segment_id=valid_segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    result = await update_coverage_for_segments(
        area_id=area.id,
        segment_ids=[unknown_segment_id, valid_segment_id],
        driven_at=datetime(2025, 1, 2, tzinfo=UTC),
    )
    assert result.updated == 1
    assert result.newly_driven_segment_ids == [valid_segment_id]
    assert result.newly_driven_length_miles == 1.0

    valid_state = await CoverageState.find_one(
        {"area_id": area.id, "segment_id": valid_segment_id},
    )
    assert valid_state is not None
    assert valid_state.status == "driven"

    unknown_state = await CoverageState.find_one(
        {"area_id": area.id, "segment_id": unknown_segment_id},
    )
    assert unknown_state is None

    refreshed_area = await CoverageArea.get(area.id)
    assert refreshed_area is not None
    assert refreshed_area.driven_segments == 1
    assert refreshed_area.driven_length_miles == 1.0


@pytest.mark.asyncio
async def test_update_coverage_for_segments_noops_when_area_missing(coverage_db) -> None:
    missing_area_id = PydanticObjectId()
    result = await update_coverage_for_segments(
        area_id=missing_area_id,
        segment_ids=[f"{missing_area_id}-1-0"],
        driven_at=datetime(2025, 1, 2, tzinfo=UTC),
    )

    assert result.updated == 0
    assert result.newly_driven_segment_ids == []
    assert result.newly_driven_length_miles == 0.0

    unexpected_state = await CoverageState.find_one({"area_id": missing_area_id})
    assert unexpected_state is None


@pytest.mark.asyncio
async def test_update_coverage_for_trip_ignores_invalid_trip_id(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Trip ID Area",
        status="ready",
        health="healthy",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
        bounding_box=[-98.0, 30.0, -96.0, 32.0],
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-{area.area_version}-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    with patch(
        "core.coverage.match_trip_to_streets",
        new=AsyncMock(return_value={area.id: [segment_id]}),
    ):
        updated = await update_coverage_for_trip(
            {
                "endTime": datetime(2025, 1, 2, tzinfo=UTC),
                "gps": {
                    "type": "LineString",
                    "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
                },
            },
            trip_id="not-an-object-id",
        )
    assert updated == 1

    state = await CoverageState.find_one({"area_id": area.id, "segment_id": segment_id})
    assert state is not None
    assert state.status == "driven"
    assert state.driven_by_trip_id is None


@pytest.mark.asyncio
async def test_manual_status_transitions_update_cached_stats(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Manual Stats Area",
        status="ready",
        health="healthy",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
        driven_segments=0,
        driven_length_miles=0.0,
        undriveable_segments=0,
        undriveable_length_miles=0.0,
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-{area.area_version}-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    await update_coverage_for_segments(
        area_id=area.id,
        segment_ids=[segment_id],
        driven_at=datetime(2025, 1, 1, tzinfo=UTC),
    )

    area_after_drive = await CoverageArea.get(area.id)
    assert area_after_drive is not None
    assert area_after_drive.driven_segments == 1
    assert area_after_drive.driven_length_miles == 1.0

    ok = await mark_segment_undriveable(area.id, segment_id)
    assert ok is True

    area_after_undriveable = await CoverageArea.get(area.id)
    assert area_after_undriveable is not None
    assert area_after_undriveable.driven_segments == 0
    assert area_after_undriveable.driven_length_miles == 0.0
    assert area_after_undriveable.undriveable_segments == 1
    assert area_after_undriveable.undriveable_length_miles == 1.0
    assert area_after_undriveable.driveable_length_miles == 0.0
    assert area_after_undriveable.coverage_percentage == 0.0

    ok2 = await mark_segment_undriven(area.id, segment_id)
    assert ok2 is True

    area_after_reset = await CoverageArea.get(area.id)
    assert area_after_reset is not None
    assert area_after_reset.driven_segments == 0
    assert area_after_reset.undriveable_segments == 0
    assert area_after_reset.undriveable_length_miles == 0.0
    assert area_after_reset.driveable_length_miles == 1.0


@pytest.mark.asyncio
async def test_backfill_sets_first_last_and_driven_by_trip_id(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Backfill Area",
        status="initializing",
        health="unavailable",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-{area.area_version}-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    t1 = datetime(2025, 1, 1, tzinfo=UTC)
    t2 = datetime(2025, 1, 2, tzinfo=UTC)
    trip1 = Trip(
        transactionId="trip-1",
        endTime=t1,
        gps={"type": "LineString", "coordinates": [[-97.0, 31.0], [-97.0, 31.001]]},
    )
    trip2 = Trip(
        transactionId="trip-2",
        endTime=t2,
        gps={"type": "LineString", "coordinates": [[-97.0, 31.0], [-97.0, 31.001]]},
    )
    await trip1.insert()
    await trip2.insert()
    assert trip1.id is not None
    assert trip2.id is not None

    payloads: list[dict] = []

    async def on_progress(payload: dict) -> None:
        payloads.append(payload)

    updated = await backfill_coverage_for_area(
        area.id,
        progress_callback=on_progress,
        progress_interval=1,
        progress_time_seconds=0.0,
    )
    assert updated == 1

    state = await CoverageState.find_one({"area_id": area.id, "segment_id": segment_id})
    assert state is not None
    assert state.status == "driven"
    assert state.first_driven_at == t1
    assert state.last_driven_at == t2
    assert state.driven_by_trip_id == trip2.id

    assert payloads
    assert {
        "processed_trips",
        "total_trips",
        "matched_trips",
        "segments_updated",
    } <= set(payloads[-1].keys())
    assert payloads[-1]["processed_trips"] == 2
    assert payloads[-1]["matched_trips"] == 2


@pytest.mark.asyncio
async def test_backfill_uses_raw_gps_not_matched_gps(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Raw GPS Only Area",
        status="initializing",
        health="unavailable",
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=1,
    )
    await area.insert()
    assert area.id is not None

    segment_id = f"{area.id}-{area.area_version}-0"
    await Street(
        segment_id=segment_id,
        area_id=area.id,
        area_version=area.area_version,
        geometry={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
        length_miles=1.0,
    ).insert()

    t1 = datetime(2025, 1, 1, tzinfo=UTC)
    trip = Trip(
        transactionId="trip-raw-vs-matched",
        endTime=t1,
        # Raw GPS is far away and should not match the segment.
        gps={
            "type": "LineString",
            "coordinates": [[-97.2, 31.0], [-97.2, 31.001]],
        },
        # Matched geometry overlaps the segment, but coverage should ignore it.
        matchedGps={
            "type": "LineString",
            "coordinates": [[-97.0, 31.0], [-97.0, 31.001]],
        },
    )
    await trip.insert()

    updated = await backfill_coverage_for_area(area.id)
    assert updated == 0

    state = await CoverageState.find_one({"area_id": area.id, "segment_id": segment_id})
    assert state is None


@pytest.mark.asyncio
async def test_backfill_bbox_query_uses_geo_intersects_without_ne(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage BBox Query Area",
        status="ready",
        health="healthy",
        bounding_box=[-97.1694267, 31.5124059, -97.1381935, 31.5315442],
    )
    await area.insert()
    assert area.id is not None

    class EmptyTripCursor:
        async def count(self) -> int:
            return 0

        def sort(self, *_args, **_kwargs) -> EmptyTripCursor:
            return self

        def __aiter__(self) -> EmptyTripCursor:
            return self

        async def __anext__(self) -> Trip:
            raise StopAsyncIteration

    captured_queries: list[dict] = []

    def fake_trip_find(query: dict) -> EmptyTripCursor:
        captured_queries.append(query)
        return EmptyTripCursor()

    with (
        patch(
            "core.coverage.get_area_segment_index",
            new=AsyncMock(),
        ),
        patch("core.coverage.Trip.find", side_effect=fake_trip_find),
    ):
        updated = await backfill_coverage_for_area(area.id)

    assert updated == 0
    assert len(captured_queries) == 2
    expected_polygon = {
        "type": "Polygon",
        "coordinates": [
            [
                [-97.1694267, 31.5124059],
                [-97.1381935, 31.5124059],
                [-97.1381935, 31.5315442],
                [-97.1694267, 31.5315442],
                [-97.1694267, 31.5124059],
            ],
        ],
    }

    first_query = captured_queries[0]
    assert first_query["invalid"] == {"$ne": True}
    assert first_query["gps"] == {"$geoIntersects": {"$geometry": expected_polygon}}
    assert "$ne" not in first_query["gps"]


@pytest.mark.asyncio
async def test_ingestion_pipeline_respects_cancelled_job(
    coverage_db,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    area = CoverageArea(
        display_name="Cancelled Ingestion Area",
        status="initializing",
        health="unavailable",
    )
    await area.insert()
    assert area.id is not None

    job = Job(
        job_type="area_ingestion",
        area_id=area.id,
        status="cancelled",
        stage="Cancelled by user",
        message="Cancelled",
    )
    await job.insert()
    assert job.id is not None

    # Ensure the pipeline exits early and doesn't overwrite the cancelled status.
    await coverage_ingestion._run_ingestion_pipeline(area.id, job.id)

    job_after = await Job.get(job.id)
    assert job_after is not None
    assert job_after.status == "cancelled"
    assert job_after.stage == "Cancelled by user"
    assert job_after.completed_at is not None

    area_after = await CoverageArea.get(area.id)
    assert area_after is not None
    assert area_after.status == "error"
    assert area_after.last_error == "Cancelled by user"
