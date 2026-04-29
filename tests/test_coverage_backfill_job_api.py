import json
from unittest.mock import AsyncMock, patch

import pytest
from db_helpers import init_mock_beanie

from db.models import CoverageArea, CoverageState, Job, Street, Trip
from street_coverage.api.areas import trigger_backfill


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
