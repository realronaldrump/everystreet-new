from datetime import UTC, datetime, timedelta

import pytest

from db.models import GasFillup
from trips.services.trip_cost_service import TripCostService


@pytest.mark.asyncio
async def test_trip_cost_uses_total_cost_derived_price(beanie_db) -> None:
    imei = "123"
    t0 = datetime(2025, 1, 1, tzinfo=UTC)

    # Fillup with total_cost but no explicit price_per_gallon.
    await GasFillup(
        imei=imei,
        fillup_time=t0,
        gallons=10.0,
        total_cost=35.0,
        price_per_gallon=None,
    ).insert()

    price_map = await TripCostService.get_fillup_price_map()

    trip = {
        "imei": imei,
        "startTime": (t0 + timedelta(hours=1)).isoformat(),
        "endTime": (t0 + timedelta(hours=2)).isoformat(),
        "fuelConsumed": 2.0,
    }
    cost = TripCostService.calculate_trip_cost(trip, price_map)
    assert cost == pytest.approx(7.0)  # 2 gal * ($35/10 gal)


@pytest.mark.asyncio
async def test_trip_cost_uses_end_time_when_available(beanie_db) -> None:
    imei = "456"
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    fill_time = t0 + timedelta(hours=2)

    await GasFillup(
        imei=imei,
        fillup_time=fill_time,
        gallons=10.0,
        total_cost=40.0,
        price_per_gallon=None,
    ).insert()

    price_map = await TripCostService.get_fillup_price_map()

    # Trip starts before fillup but ends after it; endTime should pick this fillup.
    trip = {
        "imei": imei,
        "startTime": (t0 + timedelta(hours=1)).isoformat(),
        "endTime": (t0 + timedelta(hours=3)).isoformat(),
        "fuelConsumed": 1.0,
    }
    cost = TripCostService.calculate_trip_cost(trip, price_map)
    assert cost == pytest.approx(4.0)  # 1 gal * ($40/10 gal)

