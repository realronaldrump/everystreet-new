from __future__ import annotations

from datetime import UTC, datetime

import pytest

from db.models import Trip
from trips.services.trip_history_import_service import build_import_windows
from trips.services.trip_history_import_service_config import (
    resolve_import_start_dt_from_db,
)


def test_build_import_windows_seven_day_windows_with_24h_overlap() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = datetime(2024, 1, 15, tzinfo=UTC)

    windows = build_import_windows(start, end, window_days=7, overlap_hours=24)

    assert len(windows) == 3
    assert windows[0] == (start, datetime(2024, 1, 8, tzinfo=UTC))
    assert windows[1] == (
        datetime(2024, 1, 7, tzinfo=UTC),
        datetime(2024, 1, 14, tzinfo=UTC),
    )
    assert windows[2] == (datetime(2024, 1, 13, tzinfo=UTC), end)


@pytest.mark.asyncio
async def test_resolve_import_start_dt_from_db_uses_bouncie_anchor_only(
    beanie_db,
) -> None:
    del beanie_db

    await Trip(
        transactionId="tx-webhook-old",
        source="webhook",
        startTime=datetime(2020, 1, 1, tzinfo=UTC),
        endTime=datetime(2020, 1, 1, 1, 0, tzinfo=UTC),
    ).insert()
    await Trip(
        transactionId="tx-bouncie-newer",
        source="bouncie",
        startTime=datetime(2021, 1, 1, tzinfo=UTC),
        endTime=datetime(2021, 1, 1, 1, 0, tzinfo=UTC),
    ).insert()

    start_dt = await resolve_import_start_dt_from_db(None)
    assert start_dt == datetime(2021, 1, 1, tzinfo=UTC)
