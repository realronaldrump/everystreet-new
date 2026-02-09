from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trips.services.trip_history_import_service import _expand_window_bounds_for_bouncie


def test_expand_window_bounds_expands_when_under_a_week() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=1)
    expanded_start, expanded_end = _expand_window_bounds_for_bouncie(start, end)

    assert expanded_start == start - timedelta(seconds=1)
    assert expanded_end == end + timedelta(seconds=1)


def test_expand_window_bounds_does_not_exceed_a_week() -> None:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    end = start + timedelta(days=7)
    expanded_start, expanded_end = _expand_window_bounds_for_bouncie(start, end)

    # A +/-1s expansion would violate Bouncie's "no longer than a week" constraint.
    assert (expanded_start, expanded_end) == (start, end)

