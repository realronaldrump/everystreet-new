"""Real replica-set tests for transaction rollback and exact route identity."""

import asyncio
import os
from datetime import UTC, datetime
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from beanie import init_beanie
from fastapi import HTTPException
from pymongo import AsyncMongoClient

from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageState,
    GeneratedRoute,
    Job,
    Street,
    Trip,
)
from routing.route_store import (
    complete_generated_route,
    delete_generated_route,
    get_generated_route,
)
from street_coverage import trip_credit
from street_coverage.api.optimal_routes import (
    export_route_by_id,
    get_optimal_route_result,
)

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


@pytest.fixture
async def workflow_db():
    uri = os.environ.get("WORKFLOW_TEST_MONGO_URI")
    if not uri:
        pytest.skip("Requires an isolated replica set via WORKFLOW_TEST_MONGO_URI")
    assert "everystreet-workflow-mongo" in uri, (
        "Workflow tests must never use production Mongo"
    )
    client = AsyncMongoClient(uri, tz_aware=True)
    database = client[f"workflow_test_{uuid4().hex}"]
    await init_beanie(
        database=database,
        document_models=[
            Trip,
            CoverageArea,
            CoverageState,
            CoverageDriveEvent,
            Street,
            GeneratedRoute,
            Job,
        ],
    )
    yield database
    await client.drop_database(database.name)
    await client.close()


@pytest.fixture
async def area_and_trip(workflow_db, monkeypatch):
    area = CoverageArea(
        display_name="Workflow test area",
        status="ready",
        total_segments=1,
        total_length_miles=1.0,
        driveable_length_miles=1.0,
    )
    await area.insert()
    segment_id = f"{area.id}-1-0"
    await Street(
        area_id=area.id,
        area_version=1,
        segment_id=segment_id,
        length_miles=1,
        geometry={"type": "LineString", "coordinates": [[-107, 39], [-107, 39.01]]},
    ).insert()
    trip = Trip(
        transactionId=uuid4().hex,
        source="bouncie",
        startTime=datetime(2026, 9, 1, 12, tzinfo=UTC),
        endTime=datetime(2026, 9, 1, 13, tzinfo=UTC),
    )
    await trip.insert()
    monkeypatch.setattr(
        trip_credit, "_increment_journal_rollup", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(trip_credit, "ensure_journal_rollup", AsyncMock())
    from street_coverage.intelligence import CoverageIntelligenceService

    monkeypatch.setattr(
        CoverageIntelligenceService, "reconcile_historical_trip", AsyncMock()
    )
    return area, trip, segment_id


async def test_failed_event_write_rolls_back_streets_and_totals(
    area_and_trip, monkeypatch
):
    area, trip, segment_id = area_and_trip
    original = CoverageDriveEvent.insert
    monkeypatch.setattr(
        CoverageDriveEvent,
        "insert",
        AsyncMock(side_effect=RuntimeError("crash before event write")),
    )
    with pytest.raises(RuntimeError, match="crash"):
        await trip_credit.credit_trip_area(
            trip.model_dump(), trip.id, area.id, [segment_id], "regular"
        )
    assert await CoverageState.find({"area_id": area.id}).count() == 0
    assert (await CoverageArea.get(area.id)).driven_segments == 0
    monkeypatch.setattr(CoverageDriveEvent, "insert", original)
    await trip_credit.credit_trip_area(
        trip.model_dump(), trip.id, area.id, [segment_id], "regular"
    )
    assert (await CoverageArea.get(area.id)).driven_segments == 1


async def test_projection_failure_replays_original_credit_without_double_count(
    area_and_trip, monkeypatch
):
    area, trip, segment_id = area_and_trip
    monkeypatch.setattr(
        trip_credit,
        "ensure_journal_rollup",
        AsyncMock(side_effect=[RuntimeError("projection unavailable"), None]),
    )
    with pytest.raises(RuntimeError, match="projection"):
        await trip_credit.credit_trip_area(
            trip.model_dump(), trip.id, area.id, [segment_id], "regular"
        )
    assert (await CoverageArea.get(area.id)).driven_segments == 1
    await trip_credit.credit_trip_area(
        trip.model_dump(), trip.id, area.id, [segment_id], "regular"
    )
    assert (await CoverageArea.get(area.id)).driven_segments == 1
    assert await CoverageDriveEvent.find_all().count() == 1
    from street_coverage.intelligence import CoverageIntelligenceService

    assert CoverageIntelligenceService.reconcile_historical_trip.await_args.kwargs[
        "newly_driven_segment_ids"
    ] == [segment_id]


async def test_concurrent_trips_credit_shared_street_once(area_and_trip):
    area, trip, segment_id = area_and_trip
    other = Trip(
        transactionId=uuid4().hex,
        source="bouncie",
        startTime=trip.startTime,
        endTime=trip.endTime,
    )
    await other.insert()
    await asyncio.gather(
        *(
            trip_credit.credit_trip_area(
                item.model_dump(), item.id, area.id, [segment_id], "regular"
            )
            for item in [trip, other]
        )
    )
    refreshed = await CoverageArea.get(area.id)
    assert refreshed.driven_segments == 1
    assert refreshed.driven_length_miles == 1
    events = await CoverageDriveEvent.find_all().to_list()
    assert len(events) == 2
    assert sum(len(event.newly_driven_segment_ids) for event in events) == 1


async def save_route(area, *, cluster=False, coordinates=None):
    task_id = uuid4().hex
    job = Job(
        job_type="optimal_route", task_id=task_id, area_id=area.id, status="running"
    )
    await job.insert()
    result = await complete_generated_route(
        task_id=task_id,
        area_id=area.id,
        area_version=area.area_version,
        journal_revision=area.journal_revision,
        segment_ids={"cluster-street"} if cluster else None,
        start_coords=None,
        result={
            "status": "success",
            "coordinates": coordinates or [[-107, 39], [-107, 39.01]],
            "total_distance_m": 1609.344,
        },
    )
    return job, result


async def test_cluster_preview_task_result_and_export_keep_exact_identity(
    area_and_trip,
):
    area, _, _ = area_and_trip
    _, full = await save_route(area)
    job, cluster = await save_route(
        area, cluster=True, coordinates=[[-108, 40], [-108, 40.01]]
    )
    assert str((await CoverageArea.get(area.id)).optimal_route_id) == full["route_id"]
    task_result = await get_optimal_route_result(job.task_id)
    assert task_result["route_id"] == cluster["route_id"]
    from beanie import PydanticObjectId

    loaded = await get_generated_route(PydanticObjectId(cluster["route_id"]))
    assert loaded["coordinates"] == cluster["coordinates"]
    response = await export_route_by_id(PydanticObjectId(cluster["route_id"]))
    import xml.etree.ElementTree as ET

    points = ET.fromstring(response.body).findall(".//{*}trkpt")
    assert [
        [float(point.attrib["lon"]), float(point.attrib["lat"])] for point in points
    ] == cluster["coordinates"]


async def test_route_completion_write_failure_rolls_back_result_and_pointer(
    area_and_trip, monkeypatch
):
    area, _, _ = area_and_trip
    collection = Job.get_pymongo_collection()
    original = collection.update_one
    monkeypatch.setattr(
        collection,
        "update_one",
        AsyncMock(side_effect=RuntimeError("completion write failed")),
    )
    with pytest.raises(RuntimeError, match="completion write"):
        await save_route(area)
    assert await GeneratedRoute.find_all().count() == 0
    assert (await CoverageArea.get(area.id)).optimal_route_id is None
    assert (await Job.find_one({"area_id": area.id})).status == "running"
    monkeypatch.setattr(collection, "update_one", original)


async def test_route_is_not_published_until_transaction_commits(
    area_and_trip, monkeypatch
):
    area, _, _ = area_and_trip
    entered, release = asyncio.Event(), asyncio.Event()
    original = GeneratedRoute.insert

    async def delayed_insert(self, **kwargs):
        await original(self, **kwargs)
        entered.set()
        await release.wait()
        return self

    monkeypatch.setattr(GeneratedRoute, "insert", delayed_insert)
    task = asyncio.create_task(save_route(area))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await GeneratedRoute.find_all().count() == 0
        assert (await Job.find_one({"area_id": area.id})).status == "running"
    finally:
        release.set()
        await task
    assert await GeneratedRoute.find_all().count() == 1


async def test_replay_deletion_and_rebuilt_area_keep_routes_consistent(area_and_trip):
    from beanie import PydanticObjectId

    area, _, _ = area_and_trip
    job, first = await save_route(area)
    again = await complete_generated_route(
        task_id=job.task_id,
        area_id=area.id,
        area_version=1,
        journal_revision=0,
        segment_ids=None,
        start_coords=None,
        result={"coordinates": [[0, 0], [1, 1]]},
    )
    assert again["route_id"] == first["route_id"]
    assert again["coordinates"] == first["coordinates"]
    _, second = await save_route(area)
    await delete_generated_route(PydanticObjectId(first["route_id"]))
    assert str((await CoverageArea.get(area.id)).optimal_route_id) == second["route_id"]
    await area.set({"area_version": 2})
    with pytest.raises(HTTPException) as exc:
        await get_generated_route(PydanticObjectId(second["route_id"]))
    assert exc.value.status_code == 409
