from datetime import UTC, date, datetime

from date_utils import (
    ensure_utc,
    normalize_calendar_date,
    normalize_to_utc_datetime,
    parse_timestamp,
)


def test_parse_timestamp_handles_empty_and_invalid() -> None:
    assert parse_timestamp("") is None
    assert parse_timestamp("not-a-date") is None


def test_parse_timestamp_normalizes_to_utc() -> None:
    parsed = parse_timestamp("2024-01-01T00:00:00-05:00")
    assert parsed is not None
    assert parsed.tzinfo == UTC
    assert parsed.hour == 5


def test_ensure_utc_handles_naive_datetime() -> None:
    value = datetime(2024, 1, 1, 12, 0, 0)
    normalized = ensure_utc(value)
    assert normalized is not None
    assert normalized.tzinfo == UTC
    assert normalized.hour == 12


def test_normalize_to_utc_datetime_accepts_date_and_string() -> None:
    normalized = normalize_to_utc_datetime(date(2024, 2, 3))
    assert normalized is not None
    assert normalized.tzinfo == UTC
    assert normalized.isoformat().startswith("2024-02-03T00:00:00")

    parsed = normalize_to_utc_datetime("2024-02-03")
    assert parsed is not None
    assert parsed.tzinfo == UTC
    assert parsed.isoformat().startswith("2024-02-03T00:00:00")


def test_normalize_calendar_date_formats_input() -> None:
    assert normalize_calendar_date("2024-03-01") == "2024-03-01"
    assert normalize_calendar_date(date(2024, 3, 1)) == "2024-03-01"
