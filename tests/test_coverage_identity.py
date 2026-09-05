from datetime import UTC, datetime, timedelta

from bson import BSON

from street_coverage.identity import trip_input_revision


def test_revision_survives_bson_millisecond_precision_and_timezone_roundtrip():
    when = datetime(2026, 9, 5, 12, 0, 0, 123456, tzinfo=UTC)
    trip = {
        "startTime": when,
        "endTime": when + timedelta(minutes=1),
        "matched_at": when,
        "coordinates": [{"timestamp": when}],
    }
    assert trip_input_revision(trip) == trip_input_revision(BSON.encode(trip).decode())


def test_real_sample_timing_change_invalidates_coverage_gap_decisions():
    when = datetime(2026, 9, 5, tzinfo=UTC)
    trip = {
        "coordinates": [
            {"timestamp": when},
            {"timestamp": when + timedelta(seconds=10)},
        ]
    }
    previous = trip_input_revision(trip)
    trip["coordinates"][1]["timestamp"] = when + timedelta(minutes=10)
    assert trip_input_revision(trip) != previous
