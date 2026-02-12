"""
Tests for _fetch_trips_for_window boundary clamping.

The _expand_window_bounds_for_bouncie function was removed and its logic
was inlined into _fetch_trips_for_window.  These tests verify the
clamping still behaves correctly via the public helper
build_import_windows.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trips.services.trip_history_import_service import build_import_windows


def test_build_import_windows_stays_under_seven_days() -> None:
    """Each window produced by build_import_windows must be <= 7 days."""
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=30)
    windows = build_import_windows(start, end)
    for w_start, w_end in windows:
        assert (w_end - w_start) <= timedelta(days=7)


def test_build_import_windows_single_window_under_seven_days() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    windows = build_import_windows(start, end)
    assert len(windows) == 1
    assert windows[0] == (start, end)
