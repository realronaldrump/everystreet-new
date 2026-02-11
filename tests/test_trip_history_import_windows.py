from __future__ import annotations

from datetime import UTC, datetime

from trips.services.trip_history_import_service import build_import_windows


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
