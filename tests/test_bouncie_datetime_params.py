from __future__ import annotations

from datetime import UTC, datetime

from core.clients.bouncie import format_bouncie_datetime_param


def test_format_bouncie_datetime_param_uses_z_and_strips_microseconds() -> None:
    dt = datetime(2020, 3, 1, 12, 34, 56, 123456, tzinfo=UTC)
    assert format_bouncie_datetime_param(dt) == "2020-03-01T12:34:56Z"


def test_format_bouncie_datetime_param_coerces_naive_to_utc() -> None:
    dt = datetime(2020, 3, 1, 0, 0, 0)  # naive
    assert format_bouncie_datetime_param(dt) == "2020-03-01T00:00:00Z"

