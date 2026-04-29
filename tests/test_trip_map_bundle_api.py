from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.map_bundle import router as map_bundle_router
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
    def __init__(self, docs: list[dict[str, Any]], *, has_missing_paths: bool = False):
        self.docs = docs
        self.has_missing_paths = has_missing_paths
        self.find_calls: list[tuple[dict[str, Any], dict[str, Any] | None]] = []

    async def find_one(self, _query, projection=None):
        if self.has_missing_paths:
            return {"_id": "missing"}
        return None

    def find(self, query, projection=None):
        self.find_calls.append((query, projection))
        geometry_field = "matchedGps" if "matchedGps" in query else "displayGps"
        filtered = []
        for doc in self.docs:
            if doc.get("source") != "bouncie":
                continue
            if doc.get("invalid") is True or doc.get("inactive") is True:
                continue
            if doc.get(geometry_field) is None:
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
) -> dict[str, Any]:
    display_geom = display or _line([-97.0, 32.0], [-97.1, 32.1])
    matched_geom = matched or _line([-97.0, 32.0], [-97.05, 32.05], [-97.1, 32.1])
    return {
        "_id": f"oid-{trip_id}",
        "transactionId": trip_id,
        "source": source,
        "invalid": invalid,
        "inactive": inactive,
        "imei": "imei-1",
        "startTime": datetime(2026, 3, 1, 10, 0, tzinfo=UTC),
        "endTime": datetime(2026, 3, 1, 11, 0, tzinfo=UTC),
        "distance": 42.0,
        "duration": 3600,
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
    assert display.headers["etag"] != matched.headers["etag"]


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


def test_trip_map_bundle_clips_to_coverage_area_with_full_detail_path() -> None:
    inside = _trip(
        "inside",
        display=_line([0.0, 0.0], [1.0, 0.0], [2.0, 0.0]),
    )
    outside = _trip(
        "outside",
        display=_line([5.0, 0.0], [6.0, 0.0]),
    )
    collection = _FakeTripCollection([inside, outside], has_missing_paths=True)
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
