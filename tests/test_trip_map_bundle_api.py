from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.map_bundle import _build_trip_map_summary, router as map_bundle_router
from core.http.valhalla import ValhallaClient
from trips.services.trip_map_geometry import build_encoded_path_metadata


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(map_bundle_router)
    return app


class _FakeCursor:
    def __init__(self, docs: list[dict[str, Any]]):
        self.docs = docs

    def sort(self, *_args, **_kwargs):
        self.docs = sorted(
            self.docs,
            key=lambda doc: doc.get("endTime") or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )
        return self

    def __aiter__(self):
        self._iter = iter(self.docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeTripCollection:
    def __init__(self, docs: list[dict[str, Any]]):
        self.docs = docs
        self.find_calls: list[tuple[dict[str, Any], dict[str, Any] | None]] = []

    async def find_one(self, _query, projection=None):
        raise AssertionError("Normal map bundles must not probe for missing paths")

    def find(self, query, projection=None):
        self.find_calls.append((query, projection))
        geometry_field = "matchedGps" if "matchedGps" in query else "displayGps"
        allowed_geometry_types = query.get(f"{geometry_field}.type", {}).get("$in")
        filtered = []
        for doc in self.docs:
            if doc.get("source") != "bouncie":
                continue
            if doc.get("invalid") is True or doc.get("inactive") is True:
                continue
            if doc.get(geometry_field) is None:
                continue
            if (
                allowed_geometry_types
                and doc[geometry_field].get("type") not in allowed_geometry_types
            ):
                continue
            if projection:
                filtered.append(
                    {
                        key: doc.get(key)
                        for key, include in projection.items()
                        if include and key in doc
                    },
                )
            else:
                filtered.append(dict(doc))
        return _FakeCursor(filtered)


class _FakeTripModel:
    collection: _FakeTripCollection

    @classmethod
    def get_pymongo_collection(cls):
        return cls.collection


def _line(*points: list[float]) -> dict[str, Any]:
    return {"type": "LineString", "coordinates": list(points)}


def _trip(
    trip_id: str,
    *,
    display: dict[str, Any] | None = None,
    matched: dict[str, Any] | None = None,
    source: str = "bouncie",
    invalid: bool | None = None,
    inactive: bool = False,
    duration: float = 3600,
) -> dict[str, Any]:
    display_geom = display or _line([-97.0, 32.0], [-97.1, 32.1])
    matched_geom = matched or _line([-97.0, 32.0], [-97.05, 32.05], [-97.1, 32.1])
    start_time = datetime(2026, 3, 1, 10, 0, tzinfo=UTC)
    return {
        "_id": f"oid-{trip_id}",
        "transactionId": trip_id,
        "source": source,
        "invalid": invalid,
        "inactive": inactive,
        "imei": "imei-1",
        "startTime": start_time,
        "startTimeZone": "UTC",
        "endTime": start_time + timedelta(seconds=duration),
        "distance": 42.0,
        "avgSpeed": 42.0,
        "maxSpeed": 75.0,
        "fuelConsumed": 1.5,
        "displayGps": display_geom,
        "matchedGps": matched_geom,
        "displayMapPath": build_encoded_path_metadata(
            display_geom,
            geometry_source="displayGps",
        ),
        "matchedMapPath": build_encoded_path_metadata(
            matched_geom,
            geometry_source="matchedGps",
        ),
    }


@contextmanager
def _client_for(collection: _FakeTripCollection):
    app = _create_app()
    _FakeTripModel.collection = collection
    with (
        patch("api.map_bundle.Trip", _FakeTripModel),
        patch("api.map_bundle.get_trip_map_revision", new=AsyncMock(return_value="7")),
        patch("api.map_bundle._get_cached_body", new=AsyncMock(return_value=None)),
        patch("api.map_bundle._set_cached_body", new=AsyncMock()),
        patch(
            "api.map_bundle.TripCostService.get_fillup_price_map",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "api.map_bundle.TripCostService.calculate_trip_cost",
            return_value=5.25,
        ),
    ):
        yield TestClient(app)


def test_trip_map_bundle_uses_display_and_matched_materialized_paths() -> None:
    collection = _FakeTripCollection([_trip("trip-1")])

    with _client_for(collection) as client:
        display = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02",
        )
        matched = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02&mode=matched",
        )

    assert display.status_code == 200
    assert matched.status_code == 200

    display_trip = display.json()["trips"][0]
    matched_trip = matched.json()["trips"][0]
    assert display_trip["geometry_source"] == "displayGps"
    assert matched_trip["geometry_source"] == "matchedGps"
    assert display_trip["point_count"] == 2
    assert matched_trip["point_count"] == 3
    assert "geom" not in display_trip
    assert display_trip["estimated_cost"] == 5.25
    assert matched_trip["estimated_cost"] == 5.25
    assert display.json()["summary"]["total_driving_time"] == "1:00"
    assert "avg_driving_time" not in display.json()["summary"]
    assert display.headers["etag"] != matched.headers["etag"]
    display_projection = collection.find_calls[0][1]
    matched_projection = collection.find_calls[1][1]
    assert display_projection is not None
    assert matched_projection is not None
    assert "displayGps" not in display_projection
    assert "matchedGps" not in matched_projection


def test_trip_map_bundle_excludes_invalid_inactive_and_non_bouncie_trips() -> None:
    collection = _FakeTripCollection(
        [
            _trip("visible"),
            _trip("invalid", invalid=True),
            _trip("inactive", inactive=True),
            _trip("manual", source="manual"),
        ],
    )

    with _client_for(collection) as client:
        response = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["trip_count"] == 1
    assert payload["trips"][0]["id"] == "visible"


def test_trip_map_bundle_summary_reports_total_drive_time() -> None:
    collection = _FakeTripCollection(
        [
            _trip("trip-1", duration=3600),
            _trip("trip-2", duration=1800),
        ],
    )

    with _client_for(collection) as client:
        response = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02",
        )

    assert response.status_code == 200
    summary = response.json()["summary"]
    assert summary["total_driving_time"] == "1:30"
    assert "avg_driving_time" not in summary


def test_trip_map_summary_pairs_distance_and_duration_for_average_speed() -> None:
    summary = _build_trip_map_summary(
        [
            {
                "distance_miles": 100.0,
                "duration_seconds": None,
                "start_time": datetime(2026, 3, 1, 10, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
            {
                "distance_miles": 10.0,
                "duration_seconds": 3600.0,
                "start_time": datetime(2026, 3, 1, 11, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
        ]
    )

    assert summary["avg_speed"] == 10.0
    assert summary["total_driving_time"] == "1:00"


def test_trip_map_summary_uses_circular_local_start_time_with_minutes() -> None:
    summary = _build_trip_map_summary(
        [
            {
                "start_time": datetime(2026, 1, 1, 23, 29, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
            {
                "start_time": datetime(2026, 1, 2, 0, 31, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
        ]
    )

    assert summary["avg_start_time"] == "12:00 AM"


def test_trip_map_summary_does_not_pair_clipped_distance_with_full_duration() -> None:
    summary = _build_trip_map_summary(
        [
            {
                "distance_miles": 100.0,
                "coverage_distance_miles": 10.0,
                "duration_seconds": 3600,
                "start_time": datetime(2026, 1, 1, tzinfo=UTC),
                "start_time_zone": "UTC",
            }
        ]
    )

    assert summary["total_distance_miles"] == 10.0
    assert summary["avg_distance_miles"] == 10.0
    assert summary["avg_speed"] == 100.0


def test_trip_map_summary_reports_undefined_circular_start_time() -> None:
    summary = _build_trip_map_summary(
        [
            {
                "start_time": datetime(2026, 1, 1, 0, 0, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
            {
                "start_time": datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
                "start_time_zone": "UTC",
            },
        ]
    )

    assert summary["avg_start_time"] == "--:--"


def test_trip_map_bundle_excludes_non_line_geometry() -> None:
    line_trip = _trip("line")
    point_trip = _trip(
        "point",
        display={"type": "Point", "coordinates": [-97.0, 32.0]},
    )
    point_trip["displayMapPath"] = {
        "version": 2,
        "geometry_source": "displayGps",
        "path": "stale-point-path",
        "bbox": [-97.0, 32.0, -97.0, 32.0],
        "point_count": 1,
    }
    collection = _FakeTripCollection([line_trip, point_trip])

    with _client_for(collection) as client:
        response = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02",
        )

    assert response.status_code == 200
    assert [trip["id"] for trip in response.json()["trips"]] == ["line"]


def test_trip_map_bundle_clips_to_coverage_area_with_full_detail_path() -> None:
    inside = _trip(
        "inside",
        display=_line([0.0, 0.0], [1.0, 0.0], [2.0, 0.0]),
    )
    outside = _trip(
        "outside",
        display=_line([5.0, 0.0], [6.0, 0.0]),
    )
    collection = _FakeTripCollection([inside, outside])
    app = _create_app()

    boundary = {
        "type": "Polygon",
        "coordinates": [
            [
                [0.5, -0.5],
                [1.5, -0.5],
                [1.5, 0.5],
                [0.5, 0.5],
                [0.5, -0.5],
            ],
        ],
    }

    _FakeTripModel.collection = collection
    with (
        patch("api.map_bundle.Trip", _FakeTripModel),
        patch(
            "api.map_bundle.CoverageArea.get",
            new=AsyncMock(return_value=SimpleNamespace(boundary=boundary)),
        ),
        patch("api.map_bundle.get_trip_map_revision", new=AsyncMock(return_value="7")),
        patch("api.map_bundle._get_cached_body", new=AsyncMock(return_value=None)),
        patch("api.map_bundle._set_cached_body", new=AsyncMock()),
        patch(
            "api.map_bundle.TripCostService.get_fillup_price_map",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "api.map_bundle.TripCostService.calculate_trip_cost",
            return_value=None,
        ),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/map/trips/bundle"
            "?start_date=2026-03-01&end_date=2026-03-02"
            "&clip_to_coverage=true&coverage_area_id=area-1",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["trip_count"] == 1
    trip = payload["trips"][0]
    assert trip["id"] == "inside"
    assert trip["coverage_distance_miles"] > 0

    decoded = ValhallaClient._decode_polyline(trip["path"], 6)
    assert len(decoded) == trip["point_count"]
    assert len(decoded) >= 2

    projection = collection.find_calls[-1][1]
    assert projection["displayGps"] == 1


def test_trip_map_bundle_returns_null_bbox_when_no_trips_match() -> None:
    collection = _FakeTripCollection([])

    with _client_for(collection) as client:
        response = client.get(
            "/api/map/trips/bundle?start_date=2026-03-01&end_date=2026-03-02",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["trip_count"] == 0
    assert payload["trips"] == []
    assert payload["bbox"] is None
