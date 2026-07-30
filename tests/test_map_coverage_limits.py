from __future__ import annotations

import pytest

from db.models import Trip
from map_data import auto_provision
from map_data.coverage import _build_trip_geometry, build_trip_coverage_polygon


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


def test_trip_geometry_downsampling_never_exceeds_point_cap() -> None:
    coordinates = [[float(index), 0.0] for index in range(199)]

    geometry, points_used = _build_trip_geometry(
        {"type": "LineString", "coordinates": coordinates},
        max_points=100,
    )

    assert geometry is not None
    assert points_used == 100
    assert list(geometry.coords)[0] == (0.0, 0.0)
    assert list(geometry.coords)[-1] == (198.0, 0.0)


class _FakeTripCursor:
    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        self._iterator = iter(self._rows)
        return self

    async def __anext__(self):
        try:
            return next(self._iterator)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _StateDetectionCollection:
    def __init__(self, rows):
        self.rows = rows
        self.query = None

    def find(self, query, _projection):
        self.query = query
        return _FakeTripCursor(self.rows)


@pytest.mark.asyncio
async def test_state_detection_counts_each_trip_once_per_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    collection = _StateDetectionCollection(
        [
            {
                "gps": {
                    "type": "LineString",
                    "coordinates": [[-100.0, 31.0], [-99.9, 31.1], [-99.8, 31.2]],
                },
                "destinationGeoPoint": {
                    "type": "Point",
                    "coordinates": [-99.7, 31.3],
                },
            }
        ]
    )
    monkeypatch.setattr(
        Trip,
        "get_pymongo_collection",
        staticmethod(lambda: collection),
    )

    result = await auto_provision.detect_trip_states()

    texas = next(row for row in result["state_details"] if row["code"] == "TX")
    assert texas["trip_count"] == 1
    assert result["sample_size"] == 4
    assert collection.query["source"] == "bouncie"


@pytest.mark.asyncio
async def test_state_detection_samples_every_multiline_part(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    collection = _StateDetectionCollection(
        [
            {
                "gps": {
                    "type": "MultiLineString",
                    "coordinates": [
                        [[-100.0, 31.0], [-99.8, 31.2]],
                        [[-105.0, 39.0], [-104.8, 39.2]],
                    ],
                },
            }
        ]
    )
    monkeypatch.setattr(
        Trip,
        "get_pymongo_collection",
        staticmethod(lambda: collection),
    )

    result = await auto_provision.detect_trip_states()

    counts = {row["code"]: row["trip_count"] for row in result["state_details"]}
    assert counts["TX"] == 1
    assert counts["CO"] == 1
    assert result["sample_size"] == 4
