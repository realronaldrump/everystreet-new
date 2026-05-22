from __future__ import annotations

import pytest

from db.models import Trip
from map_data.coverage import build_trip_coverage_polygon


class _FakeTripCollection:
    def __init__(self, total_trips: int) -> None:
        self.total_trips = total_trips
        self.find_called = False
        self.count_query = None

    async def count_documents(self, query):
        self.count_query = query
        return self.total_trips

    def find(self, *_args, **_kwargs):
        self.find_called = True
        raise AssertionError("coverage scan should be skipped above the trip cap")


@pytest.mark.asyncio
async def test_trip_coverage_polygon_skips_before_heavy_scan_when_trip_cap_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    collection = _FakeTripCollection(total_trips=1001)
    monkeypatch.setattr(
        Trip,
        "get_pymongo_collection",
        staticmethod(lambda: collection),
    )

    coverage, stats = await build_trip_coverage_polygon(
        buffer_miles=10,
        simplify_feet=50,
        max_points_per_trip=6000,
        batch_size=200,
        max_trips=1000,
    )

    assert coverage is None
    assert stats.total_trips == 1001
    assert stats.skipped_reason == "trip count 1,001 exceeds safety cap 1,000"
    assert collection.find_called is False
