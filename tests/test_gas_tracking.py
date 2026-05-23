from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from core.exceptions import DuplicateResourceException, ValidationException
from db.models import GasFillup, Trip, Vehicle
from db.schemas import GasFillupUpdateModel
from gas.services.fillup_service import FillupService
from gas.services.odometer_service import OdometerService
from gas.services.statistics_service import StatisticsService


def _trusted_fillup(**kwargs) -> GasFillup:
    if kwargs.get("odometer") is not None:
        kwargs.setdefault("odometer_source", "manual")
        kwargs.setdefault("odometer_is_estimated", False)
    return GasFillup(**kwargs)


@pytest.mark.asyncio
async def test_create_fillup_calculates_mpg_using_previous_sorted_fillup(
    beanie_db,
) -> None:
    imei = "imei-123"
    await Vehicle(imei=imei, vin="VIN-123").insert()

    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await _trusted_fillup(
        imei=imei,
        vin="VIN-123",
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "price_per_gallon": 3.5,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.vin == "VIN-123"
    assert created.previous_odometer == pytest.approx(1000.0)
    assert created.miles_since_last_fillup == pytest.approx(100.0)
    assert created.calculated_mpg == pytest.approx(10.0)
    assert created.total_cost == pytest.approx(35.0)


@pytest.mark.asyncio
async def test_update_fillup_missed_previous_clears_mpg(beanie_db) -> None:
    imei = "imei-456"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.calculated_mpg == pytest.approx(10.0)

    updated = await FillupService.update_fillup(
        str(created.id),
        {"missed_previous": True},
    )

    assert updated.calculated_mpg is None
    assert updated.miles_since_last_fillup is None
    assert updated.previous_odometer == pytest.approx(1000.0)


@pytest.mark.asyncio
async def test_update_fillup_rejects_null_boolean_flags(beanie_db) -> None:
    imei = "imei-null-flags"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t1,
            "gallons": 10.0,
            "odometer": 1000.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    with pytest.raises(ValidationException):
        await FillupService.update_fillup(str(created.id), {"is_full_tank": None})

    with pytest.raises(ValidationException):
        await FillupService.update_fillup(str(created.id), {"missed_previous": None})


@pytest.mark.asyncio
async def test_fillup_mutations_bump_trip_map_revision(beanie_db) -> None:
    imei = "imei-cache-bump"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    with patch(
        "gas.services.fillup_service.bump_trip_map_revision",
        new=AsyncMock(),
    ) as bump_revision:
        created = await FillupService.create_fillup(
            {
                "imei": imei,
                "fillup_time": t1,
                "gallons": 10.0,
                "odometer": 1000.0,
                "price_per_gallon": 3.5,
                "is_full_tank": True,
                "missed_previous": False,
            },
        )

        await FillupService.update_fillup(str(created.id), {"price_per_gallon": 3.75})
        await FillupService.delete_fillup(str(created.id))

    assert bump_revision.await_count == 3


@pytest.mark.asyncio
async def test_update_fillup_recalculates_next_fillup(beanie_db) -> None:
    imei = "imei-789"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    t2 = t1 + timedelta(days=1)
    b = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    t3 = t2 + timedelta(days=1)
    c = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 10.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert c.previous_odometer == pytest.approx(1100.0)
    assert c.calculated_mpg == pytest.approx(10.0)

    await FillupService.update_fillup(str(b.id), {"odometer": 1120.0})

    refreshed = await GasFillup.get(c.id)
    assert refreshed is not None
    assert refreshed.previous_odometer == pytest.approx(1120.0)
    assert refreshed.calculated_mpg == pytest.approx(8.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_uses_fillup_anchor_and_trip_distance(
    beanie_db,
) -> None:
    imei = "imei-odo"
    anchor_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await _trusted_fillup(
        imei=imei,
        fillup_time=anchor_time,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    await Trip(
        transactionId="tx-odo-1",
        imei=imei,
        startTime=anchor_time + timedelta(hours=1),
        endTime=anchor_time + timedelta(hours=2),
        distance=50.0,
    ).insert()

    target_time = anchor_time + timedelta(hours=3)
    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calculated_from_prev_manual"
    assert result["confidence"] == "low"
    assert result["previous_anchor"]["odometer"] == pytest.approx(1000.0)
    assert result["distance_diff"] == pytest.approx(50.0)
    assert result["estimated_odometer"] == pytest.approx(1050.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_calibrates_between_manual_anchors(
    beanie_db,
) -> None:
    imei = "imei-odo-calibrated"
    prev_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    target_time = prev_time + timedelta(hours=2)
    next_time = prev_time + timedelta(hours=4)

    await _trusted_fillup(
        imei=imei,
        fillup_time=prev_time,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await _trusted_fillup(
        imei=imei,
        fillup_time=next_time,
        gallons=10.0,
        odometer=1120.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await Trip(
        transactionId="tx-odo-calibrated-a",
        imei=imei,
        startTime=prev_time,
        endTime=target_time,
        distance=30.0,
        source="bouncie",
    ).insert()
    await Trip(
        transactionId="tx-odo-calibrated-b",
        imei=imei,
        startTime=target_time,
        endTime=next_time,
        distance=70.0,
        source="bouncie",
    ).insert()

    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calibrated_between_manual_anchors"
    assert result["confidence"] == "calibrated"
    assert result["distance_diff"] == pytest.approx(30.0)
    assert result["previous_anchor"]["odometer"] == pytest.approx(1000.0)
    assert result["next_anchor"]["odometer"] == pytest.approx(1120.0)
    assert result["estimated_odometer"] == pytest.approx(1036.0)


@pytest.mark.asyncio
async def test_get_vehicle_location_at_time_handles_missing_optional_fields(
    beanie_db,
) -> None:
    imei = "imei-location-optional"
    target_time = datetime(2026, 2, 8, 3, 21, tzinfo=UTC)

    await Trip(
        transactionId="tx-location-optional",
        imei=imei,
        startTime=target_time - timedelta(minutes=30),
        endTime=target_time + timedelta(minutes=30),
        endOdometer=12345.6,
        source="bouncie",
    ).insert()

    result = await OdometerService.get_vehicle_location_at_time(
        imei,
        target_time.isoformat(),
    )

    assert result["latitude"] is None
    assert result["longitude"] is None
    assert result["odometer"] == pytest.approx(12345.6)
    assert result["address"] is None
    assert result["timestamp"] == target_time


@pytest.mark.asyncio
async def test_create_fillup_requires_is_full_tank(beanie_db) -> None:
    with pytest.raises(ValidationException):
        await FillupService.create_fillup(
            {
                "imei": "imei-required-full",
                "fillup_time": datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
                "gallons": 8.0,
                "odometer": 5000.0,
            },
        )


@pytest.mark.asyncio
async def test_create_fillup_rolls_up_partial_fill_chain_for_mpg(beanie_db) -> None:
    imei = "imei-partial-chain"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    partial = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 3.0,
            "odometer": 1050.0,
            "is_full_tank": False,
            "missed_previous": False,
        },
    )
    assert partial.calculated_mpg is None
    assert partial.previous_odometer == pytest.approx(1000.0)

    full = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 6.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert full.previous_odometer == pytest.approx(1000.0)
    assert full.miles_since_last_fillup == pytest.approx(200.0)
    assert full.calculated_mpg == pytest.approx(200.0 / 9.0)


@pytest.mark.asyncio
async def test_partial_fillup_marked_missed_previous_breaks_future_mpg(
    beanie_db,
) -> None:
    imei = "imei-partial-missed"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    partial = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 3.0,
            "odometer": 1050.0,
            "is_full_tank": False,
            "missed_previous": True,
        },
    )
    assert partial.calculated_mpg is None
    assert partial.missed_previous is True

    full = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 8.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert full.calculated_mpg is None
    assert full.miles_since_last_fillup is None
    assert full.previous_odometer == pytest.approx(1050.0)


@pytest.mark.asyncio
async def test_create_fillup_rejects_exact_duplicate_submission(beanie_db) -> None:
    imei = "imei-duplicate"
    fillup_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    payload = {
        "imei": imei,
        "fillup_time": fillup_time,
        "gallons": 10.0,
        "odometer": 1000.0,
        "is_full_tank": True,
        "missed_previous": False,
    }

    await FillupService.create_fillup(payload)

    with pytest.raises(DuplicateResourceException):
        await FillupService.create_fillup(payload)


@pytest.mark.asyncio
async def test_gas_statistics_uses_weighted_mpg_and_price(beanie_db) -> None:
    imei = "imei-weighted-stats"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "price_per_gallon": 2.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )
    await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 5.0,
            "price_per_gallon": 4.0,
            "odometer": 1300.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    stats = await StatisticsService.get_gas_statistics(imei=imei)

    assert stats["average_mpg"] == pytest.approx(20.0)
    assert stats["average_price_per_gallon"] == pytest.approx(2.67)
    assert stats["cost_per_mile"] == pytest.approx(0.134)
    assert stats["records"]["best_mpg"]["mpg"] == pytest.approx(40.0)


@pytest.mark.asyncio
async def test_create_fillup_uses_full_anchor_marked_missed_previous(beanie_db) -> None:
    imei = "imei-anchor-missed-prev"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=True,
    ).insert()

    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.previous_odometer == pytest.approx(1000.0)
    assert created.miles_since_last_fillup == pytest.approx(100.0)
    assert created.calculated_mpg == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_create_fillup_skips_untrusted_full_tank_as_mpg_anchor(
    beanie_db,
) -> None:
    imei = "imei-untrusted-mpg-anchor"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await _trusted_fillup(
        imei=imei,
        fillup_time=t2,
        gallons=10.0,
        odometer=5000.0,
        odometer_source="estimated",
        odometer_is_estimated=True,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    created = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 10.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert created.previous_odometer == pytest.approx(1000.0)
    assert created.miles_since_last_fillup == pytest.approx(200.0)
    assert created.calculated_mpg == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_update_fillup_recalculates_same_timestamp_next_fillup(beanie_db) -> None:
    imei = "imei-same-time"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    b = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )
    c = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1200.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert c.previous_odometer == pytest.approx(1100.0)
    assert c.calculated_mpg == pytest.approx(10.0)

    await FillupService.update_fillup(str(b.id), {"odometer": 1120.0})

    refreshed = await GasFillup.get(c.id)
    assert refreshed is not None
    assert refreshed.previous_odometer == pytest.approx(1120.0)
    assert refreshed.calculated_mpg == pytest.approx(8.0)


@pytest.mark.asyncio
async def test_update_fillup_recalculates_through_partial_chain(beanie_db) -> None:
    imei = "imei-cascade-chain"
    t1 = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    t2 = t1 + timedelta(days=1)
    t3 = t2 + timedelta(days=1)
    t4 = t3 + timedelta(days=1)

    await _trusted_fillup(
        imei=imei,
        fillup_time=t1,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    b = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t2,
            "gallons": 10.0,
            "odometer": 1100.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )
    await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t3,
            "gallons": 2.0,
            "odometer": 1150.0,
            "is_full_tank": False,
            "missed_previous": False,
        },
    )
    d = await FillupService.create_fillup(
        {
            "imei": imei,
            "fillup_time": t4,
            "gallons": 8.0,
            "odometer": 1300.0,
            "is_full_tank": True,
            "missed_previous": False,
        },
    )

    assert d.previous_odometer == pytest.approx(1100.0)
    assert d.calculated_mpg == pytest.approx(20.0)

    await FillupService.update_fillup(str(b.id), {"odometer": 1120.0})

    refreshed = await GasFillup.get(d.id)
    assert refreshed is not None
    assert refreshed.previous_odometer == pytest.approx(1120.0)
    assert refreshed.miles_since_last_fillup == pytest.approx(180.0)
    assert refreshed.calculated_mpg == pytest.approx(18.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_prorates_partial_trip_overlap(
    beanie_db,
) -> None:
    imei = "imei-odo-overlap"
    anchor_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await _trusted_fillup(
        imei=imei,
        fillup_time=anchor_time,
        gallons=10.0,
        odometer=1000.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    await Trip(
        transactionId="tx-odo-overlap",
        imei=imei,
        startTime=anchor_time - timedelta(minutes=30),
        endTime=anchor_time + timedelta(minutes=30),
        distance=60.0,
        source="bouncie",
    ).insert()

    target_time = anchor_time + timedelta(minutes=15)
    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calculated_from_prev_manual"
    assert result["confidence"] == "low"
    assert result["distance_diff"] == pytest.approx(15.0)
    assert result["estimated_odometer"] == pytest.approx(1015.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_uses_next_manual_anchor_with_low_confidence(
    beanie_db,
) -> None:
    imei = "imei-odo-next-anchor"
    target_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    next_time = target_time + timedelta(hours=2)
    await _trusted_fillup(
        imei=imei,
        fillup_time=next_time,
        gallons=10.0,
        odometer=1100.0,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await Trip(
        transactionId="tx-odo-next-anchor",
        imei=imei,
        startTime=target_time + timedelta(minutes=30),
        endTime=target_time + timedelta(hours=1),
        distance=40.0,
        source="bouncie",
    ).insert()

    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calculated_from_next_manual"
    assert result["confidence"] == "low"
    assert result["distance_diff"] == pytest.approx(40.0)
    assert result["next_anchor"]["odometer"] == pytest.approx(1100.0)
    assert result["estimated_odometer"] == pytest.approx(1060.0)


@pytest.mark.asyncio
async def test_get_vehicle_location_at_time_interpolates_odometer_inside_trip(
    beanie_db,
) -> None:
    imei = "imei-location-interp"
    start_time = datetime(2026, 2, 8, 2, 0, tzinfo=UTC)
    end_time = start_time + timedelta(hours=1)
    target_time = start_time + timedelta(minutes=15)

    await Trip(
        transactionId="tx-location-interp",
        imei=imei,
        startTime=start_time,
        endTime=end_time,
        startOdometer=1000.0,
        endOdometer=1060.0,
        coordinates=[
            {"timestamp": start_time, "lat": 30.0, "lon": -97.0},
            {"timestamp": end_time, "lat": 31.0, "lon": -96.0},
        ],
        source="bouncie",
    ).insert()

    result = await OdometerService.get_vehicle_location_at_time(
        imei,
        target_time.isoformat(),
    )

    assert result["timestamp"] == target_time
    assert result["odometer"] == pytest.approx(1015.0)
    assert result["odometer_source"] == "trip_interpolated"
    assert result["odometer_is_estimated"] is True
    assert result["latitude"] == pytest.approx(30.25)
    assert result["longitude"] == pytest.approx(-96.75)


@pytest.mark.asyncio
async def test_get_vehicle_location_at_time_uses_closest_future_trip_start(
    beanie_db,
) -> None:
    imei = "imei-location-closest"
    target_time = datetime(2026, 2, 8, 12, 0, tzinfo=UTC)

    await Trip(
        transactionId="tx-location-previous-far",
        imei=imei,
        startTime=target_time - timedelta(hours=3),
        endTime=target_time - timedelta(hours=2),
        startOdometer=900.0,
        endOdometer=950.0,
        gps={"type": "LineString", "coordinates": [[-100.0, 40.0], [-99.0, 41.0]]},
        source="bouncie",
    ).insert()
    next_start = target_time + timedelta(minutes=5)
    await Trip(
        transactionId="tx-location-next-close",
        imei=imei,
        startTime=next_start,
        endTime=next_start + timedelta(minutes=30),
        startOdometer=1000.0,
        endOdometer=1030.0,
        gps={"type": "LineString", "coordinates": [[-97.0, 30.0], [-96.0, 31.0]]},
        source="bouncie",
    ).insert()

    result = await OdometerService.get_vehicle_location_at_time(
        imei,
        target_time.isoformat(),
    )

    assert result["timestamp"] == next_start
    assert result["odometer"] == pytest.approx(1000.0)
    assert result["odometer_source"] == "trip_start"
    assert result["latitude"] == pytest.approx(30.0)
    assert result["longitude"] == pytest.approx(-97.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_ignores_untrusted_fillup_anchors(
    beanie_db,
) -> None:
    imei = "imei-estimated-anchor"
    trusted_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    estimated_time = trusted_time + timedelta(days=1)
    target_time = estimated_time + timedelta(hours=2)

    await _trusted_fillup(
        imei=imei,
        fillup_time=trusted_time,
        gallons=10.0,
        odometer=1000.0,
        odometer_source="manual",
        odometer_is_estimated=False,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await _trusted_fillup(
        imei=imei,
        fillup_time=estimated_time,
        gallons=10.0,
        odometer=5000.0,
        odometer_source="estimated",
        odometer_is_estimated=True,
        is_full_tank=True,
        missed_previous=False,
    ).insert()
    await Trip(
        transactionId="tx-estimated-anchor-distance",
        imei=imei,
        startTime=trusted_time + timedelta(hours=1),
        endTime=trusted_time + timedelta(hours=2),
        distance=25.0,
        source="bouncie",
    ).insert()

    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "calculated_from_prev_manual"
    assert result["confidence"] == "low"
    assert result["previous_anchor"]["odometer"] == pytest.approx(1000.0)
    assert result["estimated_odometer"] == pytest.approx(1025.0)


@pytest.mark.asyncio
async def test_estimate_odometer_reading_returns_no_data_without_manual_anchor(
    beanie_db,
) -> None:
    imei = "imei-no-manual-anchor"
    target_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    await Trip(
        transactionId="tx-no-manual-anchor",
        imei=imei,
        startTime=target_time - timedelta(hours=1),
        endTime=target_time - timedelta(minutes=30),
        endOdometer=5000.0,
        distance=25.0,
        source="bouncie",
    ).insert()
    await _trusted_fillup(
        imei=imei,
        fillup_time=target_time - timedelta(minutes=15),
        gallons=10.0,
        odometer=5000.0,
        odometer_source="bouncie_untrusted",
        odometer_is_estimated=True,
        is_full_tank=True,
        missed_previous=False,
    ).insert()

    result = await OdometerService.estimate_odometer_reading(
        imei,
        target_time.isoformat(),
    )

    assert result["method"] == "no_data"
    assert result["confidence"] == "none"
    assert result["estimated_odometer"] is None


@pytest.mark.asyncio
async def test_sync_vehicles_from_trips_only_uses_bouncie_source(beanie_db) -> None:
    start_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    await Trip(
        transactionId="tx-sync-bouncie",
        imei="imei-sync-bouncie",
        vin="VIN-B",
        startTime=start_time,
        endTime=start_time + timedelta(minutes=30),
        source="bouncie",
    ).insert()

    await Trip(
        transactionId="tx-sync-legacy",
        imei="imei-sync-legacy",
        vin="VIN-L",
        startTime=start_time,
        endTime=start_time + timedelta(minutes=45),
        source="legacy",
    ).insert()

    result = await StatisticsService.sync_vehicles_from_trips()
    bouncie_vehicle = await Vehicle.find_one(Vehicle.imei == "imei-sync-bouncie")
    legacy_vehicle = await Vehicle.find_one(Vehicle.imei == "imei-sync-legacy")

    assert bouncie_vehicle is not None
    assert legacy_vehicle is None
    assert result["synced"] == 1


@pytest.mark.asyncio
async def test_recalculate_subsequent_fillup_does_not_raise_on_internal_errors(
    monkeypatch,
) -> None:
    async def boom(**_kwargs):
        msg = "simulated failure"
        raise RuntimeError(msg)

    monkeypatch.setattr(FillupService, "_get_next_fillup", boom)

    await FillupService.recalculate_subsequent_fillup(
        "imei-recalc-safe",
        datetime(2024, 1, 1, 12, 0, tzinfo=UTC),
    )


def test_gas_fillup_update_model_allows_partial_payloads() -> None:
    payload = GasFillupUpdateModel(missed_previous=True)
    assert payload.model_dump(exclude_unset=True) == {"missed_previous": True}


@pytest.mark.parametrize("field_name", ["is_full_tank", "missed_previous"])
def test_gas_fillup_update_model_rejects_null_boolean_flags(field_name: str) -> None:
    with pytest.raises(ValidationError):
        GasFillupUpdateModel(**{field_name: None})
