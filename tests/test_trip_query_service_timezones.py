from __future__ import annotations

from datetime import UTC, datetime

import pytest

from db.models import Trip
from trips.services.trip_query_service import TripQueryService


@pytest.mark.asyncio
async def test_get_trips_datatable_includes_timezone_alias_fields(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-timezone",
        source="bouncie",
        startTime=datetime(2026, 3, 1, 10, 0, tzinfo=UTC),
        endTime=datetime(2026, 3, 1, 11, 0, tzinfo=UTC),
        startTimeZone="America/Chicago",
        endTimeZone="America/Chicago",
        gps={
            "type": "LineString",
            "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
        },
        distance=10.0,
        maxSpeed=50.0,
    ).insert()

    result = await TripQueryService.get_trips_datatable(
        draw=1,
        start=0,
        length=10,
        search_value="",
        order=[],
        columns=[],
        filters={},
        start_date=None,
        end_date=None,
        price_map={},
    )

    assert result["recordsFiltered"] == 1
    row = result["data"][0]
    assert row["startTimeZone"] == "America/Chicago"
    assert row["endTimeZone"] == "America/Chicago"
    assert row["timeZone"] == "America/Chicago"
