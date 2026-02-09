from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trips.services.trip_history_import_service import _expand_window_bounds_for_bouncie


def test_expand_window_bounds_expands_when_under_a_week() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    expanded_start, expanded_end = _expand_window_bounds_for_bouncie(start, end)

    # We bias the lower bound by -1s to cover the strict "starts-after" semantics.
    assert expanded_start == start - timedelta(seconds=1)
    # For shorter windows, we can keep the end bound as-is.
    assert expanded_end == end


def test_expand_window_bounds_does_not_exceed_a_week() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=7)
    expanded_start, expanded_end = _expand_window_bounds_for_bouncie(start, end)

    # Keep strictly under 7 days: query_start is -1s, so query_end clamps by -2s.
    assert expanded_start == start - timedelta(seconds=1)
    assert expanded_end == end - timedelta(seconds=2)
