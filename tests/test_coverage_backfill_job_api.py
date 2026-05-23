import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from beanie import PydanticObjectId
from db_helpers import init_mock_beanie

from db.models import CoverageArea, CoverageState, Job, Street, Trip
from street_coverage.api.areas import (
    BatchRecalculateRequest,
    queue_batch_recalculate,
    trigger_backfill,
)


@pytest.fixture
async def coverage_db():
    return await init_mock_beanie(CoverageArea, CoverageState, Job, Street, Trip)


@pytest.mark.asyncio
async def test_backfill_endpoint_supports_background_job(coverage_db) -> None:
    area = CoverageArea(
        display_name="Coverage Backfill Job Area",
        status="ready",
        health="healthy",
        total_length_miles=0.0,
        driveable_length_miles=0.0,
        total_segments=0,
    )
    await area.insert()
    assert area.id is not None

    job = Job(
        job_type="area_backfill",
        area_id=area.id,
        status="pending",
        stage="queued",
        progress=0.0,
        message="Queued",
    )
    await job.insert()

    with (
        patch(
            "street_coverage.api.areas.backfill_area", new=AsyncMock(return_value=job)
        ),
    ):
        response = await trigger_backfill(area.id, background=True)

    assert response.status_code == 202
    payload = json.loads(response.body.decode("utf-8"))
    assert payload["success"] is True
    assert payload["job_id"]
    assert payload["status_url"].endswith(payload["job_id"])

    job = await Job.find_one({"job_type": "area_backfill", "area_id": area.id})
    assert job is not None


@pytest.mark.asyncio
async def test_batch_recalculate_endpoint_queues_sequential_child_jobs(
    coverage_db,
) -> None:
    area_one = CoverageArea(
        display_name="Batch Area One",
        status="ready",
        health="healthy",
        total_length_miles=0.0,
        driveable_length_miles=0.0,
        total_segments=0,
        road_filter_version="current",
    )
    area_two = CoverageArea(
        display_name="Batch Area Two",
        status="ready",
        health="healthy",
        total_length_miles=0.0,
        driveable_length_miles=0.0,
        total_segments=0,
        road_filter_version="current",
    )
    await area_one.insert()
    await area_two.insert()
    assert area_one.id is not None
    assert area_two.id is not None

    fake_pool = SimpleNamespace(
        enqueue_job=AsyncMock(return_value=SimpleNamespace(job_id="batch-task-id")),
    )

    with (
        patch(
            "street_coverage.api.areas.get_arq_pool",
            AsyncMock(return_value=fake_pool),
        ),
    ):
        response = await queue_batch_recalculate(
            BatchRecalculateRequest(
                area_ids=[area_one.id, area_two.id],
                trip_mode="both",
                rebuild_policy="never",
            ),
        )

    assert response.success is True
    assert response.task_id == "batch-task-id"
    assert len(response.jobs) == 2
    assert {job.operation for job in response.jobs} == {"backfill"}

    parent_job = await Job.get(PydanticObjectId(response.batch_job_id))
    assert parent_job is not None
    assert parent_job.job_type == "coverage_recalculate_batch"
    assert parent_job.task_id == "batch-task-id"

    child_jobs = await Job.find({"job_type": "area_backfill"}).to_list()
    assert len(child_jobs) == 2
    assert {job.metadata.get("batch_job_id") for job in child_jobs} == {
        response.batch_job_id,
    }
