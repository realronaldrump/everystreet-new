from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from db.models import (
    CoverageArea,
    CoverageDriveEvent,
    CoverageOverride,
    CoverageStatusEvent,
    CoverageState,
    CoverageJournalRollup,
    Street,
    Trip,
)
from street_coverage.matching import MATCHING_VERSION
from street_coverage.projection import area_metrics, set_manual_status
from street_coverage.projection import CoverageDeferred
from street_coverage.stats import calculate_area_stats, update_area_stats
from street_coverage.trip_credit import credit_trip_area
from trips.services.inactive_trip_service import InactiveTripService


@pytest.fixture
async def evidence_area(monkeypatch):
    await init_mock_beanie(CoverageArea, Trip, CoverageJournalRollup)
    monkeypatch.setattr(
        "street_coverage.intelligence.CoverageIntelligenceService.reconcile_historical_trip",
        AsyncMock(),
    )
    area = CoverageArea(
        display_name="Interval test",
        status="ready",
        coverage_matching_version=MATCHING_VERSION,
        total_segments=2,
        total_length_miles=1,
        driveable_length_miles=1,
    )
    await area.insert()
    ids = [f"{area.id}-1-{index}" for index in range(2)]
    for index, sid in enumerate(ids):
        await Street(
            area_id=area.id,
            area_version=1,
            segment_id=sid,
            length_miles=0.5,
            geometry={
                "type": "LineString",
                "coordinates": [
                    [-107 + index * 0.01, 39],
                    [-107 + index * 0.01, 39.001],
                ],
            },
        ).insert()
    trip = Trip(
        transactionId="interval",
        source="bouncie",
        startTime=datetime(2026, 1, 1, tzinfo=UTC),
        endTime=datetime(2026, 1, 1, 1, tzinfo=UTC),
    )
    await trip.insert()
    return area, ids, trip


async def credit(area, trip, sid, intervals):
    return await credit_trip_area(
        trip.model_dump(),
        trip.id,
        area.id,
        {sid: {"intervals": intervals, "max_offset_meters": 0}},
        "matched",
        area_version=1,
        geometry_source="matchedGps",
    )


async def test_partial_credit_is_length_weighted_and_repeat_is_idempotent(
    evidence_area,
):
    area, ids, trip = evidence_area
    await credit(area, trip, ids[0], [[0, 0.5]])
    await credit(area, trip, ids[0], [[0, 0.5]])
    current = await CoverageArea.get(area.id)
    assert current.driven_length_miles == 0.25
    assert current.coverage_percentage == 25
    assert current.driven_segments == 0
    assert not current.is_complete
    assert await CoverageDriveEvent.find_all().count() == 1


async def test_refresh_keeps_published_states_and_replaces_totals(
    evidence_area, monkeypatch
):
    area, ids, trip = evidence_area
    await credit(area, trip, ids[0], [[0, 1]])
    current = await CoverageArea.get(area.id)
    monkeypatch.setattr(
        "trips.services.inactive_trip_service.backfill_area",
        AsyncMock(return_value=None),
    )
    await InactiveTripService._start_area_refresh(current)
    assert await CoverageState.find({"status": "driven"}).count() == 1
    await update_area_stats(area.id)
    current = await CoverageArea.get(area.id)
    assert current.driven_segments == 1
    assert current.driven_length_miles == 0.5
    assert (await calculate_area_stats(area.id))["driven_length_miles"] == 0.5


async def test_manual_reset_survives_reconciliation_and_can_restore_automatic(
    evidence_area,
):
    area, ids, trip = evidence_area
    await credit(area, trip, ids[0], [[0, 1]])
    await set_manual_status(area.id, [ids[0]], "undriven")
    await update_area_stats(area.id)
    assert (await CoverageArea.get(area.id)).driven_length_miles == 0
    await set_manual_status(area.id, [ids[0]], "automatic")
    assert (await CoverageArea.get(area.id)).driven_length_miles == 0.5


async def test_manual_driven_can_replace_exclusion_and_correct_denominator(
    evidence_area,
):
    area, ids, _ = evidence_area
    await set_manual_status(area.id, [ids[0]], "undriveable")
    assert (await CoverageArea.get(area.id)).driveable_length_miles == 0.5
    result = await set_manual_status(area.id, [ids[0]], "driven")
    assert result["states"][ids[0]]["status"] == "driven"
    assert result["driveable_length_miles"] == 1
    assert result["driven_length_miles"] == 0.5


async def test_excluded_segment_does_not_abort_other_historical_credit(evidence_area):
    area, ids, trip = evidence_area
    await set_manual_status(area.id, [ids[0]], "undriveable")
    await credit_trip_area(
        trip.model_dump(),
        trip.id,
        area.id,
        {sid: {"intervals": [[0, 1]], "max_offset_meters": 0} for sid in ids},
        "matched",
        area_version=1,
        geometry_source="matchedGps",
    )
    current = await CoverageArea.get(area.id)
    assert current.is_complete
    assert current.driven_length_miles == current.driveable_length_miles == 0.5


async def test_changed_trip_retracts_its_old_intervals(evidence_area):
    area, ids, trip = evidence_area
    await credit(area, trip, ids[0], [[0, 1]])
    trip.endTime = datetime(2026, 1, 1, 2, tzinfo=UTC)
    await trip.save()
    await credit(area, trip, ids[0], [[0, 0.25]])
    assert (await CoverageArea.get(area.id)).driven_length_miles == 0.125


async def test_repeat_manual_decision_preserves_date_and_does_not_add_history(
    evidence_area,
):
    area, ids, _ = evidence_area
    await set_manual_status(area.id, [ids[0]], "driven")
    marked_at = (await CoverageOverride.find_one({"area_id": area.id})).marked_at
    result = await set_manual_status(area.id, [ids[0]], "driven")
    assert result["updated"] == 0
    assert (
        await CoverageOverride.find_one({"area_id": area.id})
    ).marked_at == marked_at
    assert await CoverageStatusEvent.find_all().count() == 1


async def test_matching_old_inventory_requests_retry_instead_of_losing_credit(
    evidence_area,
):
    area, ids, trip = evidence_area
    await area.set({"area_version": 2})
    with pytest.raises(CoverageDeferred, match="inventory changed"):
        await credit(area, trip, ids[0], [[0, 1]])
    assert await CoverageDriveEvent.find_all().count() == 0


def test_completion_never_depends_on_rounded_percentage():
    values = area_metrics(
        total_segments=2,
        total_length_miles=100,
        driven_segments=1,
        driven_length_miles=99.999,
        undriveable_segments=0,
        undriveable_length_miles=0,
    )
    assert round(values["coverage_percentage"], 2) == 100
    assert not values["is_complete"]
    with pytest.raises(ValueError):
        area_metrics(
            total_segments=2,
            total_length_miles=1,
            driven_segments=3,
            driven_length_miles=1,
            undriveable_segments=0,
            undriveable_length_miles=0,
        )
