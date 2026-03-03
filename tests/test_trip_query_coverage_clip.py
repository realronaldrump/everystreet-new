from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from trips.api.query import router as query_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(query_router)
    return app


class _SortableField:
    def __neg__(self):
        return self


class _TripDoc:
    def __init__(self, payload: dict):
        self._payload = payload

    def model_dump(self) -> dict:
        return dict(self._payload)


class _TripCursor:
    def __init__(self, docs: list[dict]):
        self._docs = [_TripDoc(doc) for doc in docs]

    def sort(self, *_args, **_kwargs):
        return self

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class _FakeTripModel:
    endTime = _SortableField()
    docs: list[dict] = []
    received_queries: list[dict] = []

    @classmethod
    def find(cls, query):
        cls.received_queries.append(query)
        return _TripCursor(cls.docs)


def _trip_docs() -> list[dict]:
    return [
        {
            "transactionId": "trip-intersects",
            "imei": "imei-1",
            "source": "bouncie",
            "startTime": "2026-03-01T10:00:00+00:00",
            "endTime": "2026-03-01T11:30:00+00:00",
            "distance": 200.0,
            "maxSpeed": 70.0,
            "avgSpeed": 40.0,
            "gps": {
                "type": "LineString",
                "coordinates": [[0.0, 0.0], [2.0, 0.0]],
            },
            "matchedGps": {
                "type": "LineString",
                "coordinates": [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]],
            },
        },
        {
            "transactionId": "trip-outside",
            "imei": "imei-2",
            "source": "bouncie",
            "startTime": "2026-03-01T12:00:00+00:00",
            "endTime": "2026-03-01T12:30:00+00:00",
            "distance": 120.0,
            "maxSpeed": 55.0,
            "avgSpeed": 30.0,
            "gps": {
                "type": "LineString",
                "coordinates": [[5.0, 0.0], [6.0, 0.0]],
            },
            "matchedGps": {
                "type": "LineString",
                "coordinates": [[5.0, 0.0], [5.5, 0.0], [6.0, 0.0]],
            },
        },
    ]


def _coverage_boundary() -> dict:
    return {
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


def _assert_prefilter_present(query: dict) -> None:
    assert "gps" in query
    assert "$geoIntersects" in query["gps"]
    geometry = query["gps"]["$geoIntersects"]["$geometry"]
    assert geometry["type"] == "Polygon"


def test_trips_endpoint_clips_to_selected_coverage_area() -> None:
    _FakeTripModel.docs = _trip_docs()
    _FakeTripModel.received_queries = []

    app = _create_app()
    with (
        patch("trips.api.query.Trip", _FakeTripModel),
        patch(
            "trips.api.query.CoverageArea.get",
            new=AsyncMock(return_value=SimpleNamespace(boundary=_coverage_boundary())),
        ),
        patch(
            "trips.api.query.TripCostService.get_fillup_price_map",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "trips.api.query.TripCostService.calculate_trip_cost",
            return_value=0.0,
        ),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/trips?clip_to_coverage=true&coverage_area_id=area-1",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 1
    feature = payload["features"][0]
    assert feature["properties"]["transactionId"] == "trip-intersects"
    assert feature["geometry"]["type"] in {"LineString", "MultiLineString"}
    assert feature["properties"]["coverageDistance"] > 0
    assert feature["properties"]["coverageDistance"] < feature["properties"]["distance"]

    _assert_prefilter_present(_FakeTripModel.received_queries[-1])


def test_matched_trips_endpoint_clips_and_omits_non_intersecting_trips() -> None:
    _FakeTripModel.docs = _trip_docs()
    _FakeTripModel.received_queries = []

    app = _create_app()
    with (
        patch("trips.api.query.Trip", _FakeTripModel),
        patch(
            "trips.api.query.CoverageArea.get",
            new=AsyncMock(return_value=SimpleNamespace(boundary=_coverage_boundary())),
        ),
        patch(
            "trips.api.query.TripCostService.get_fillup_price_map",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "trips.api.query.TripCostService.calculate_trip_cost",
            return_value=0.0,
        ),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/matched_trips?clip_to_coverage=true&coverage_area_id=area-1",
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 1
    feature = payload["features"][0]
    assert feature["properties"]["transactionId"] == "trip-intersects"
    assert feature["geometry"]["type"] in {"LineString", "MultiLineString"}
    assert feature["properties"]["coverageDistance"] > 0

    _assert_prefilter_present(_FakeTripModel.received_queries[-1])


def test_invalid_boundary_returns_422_and_does_not_query_trips() -> None:
    _FakeTripModel.docs = _trip_docs()
    _FakeTripModel.received_queries = []

    app = _create_app()
    with (
        patch("trips.api.query.Trip", _FakeTripModel),
        patch(
            "trips.api.query.CoverageArea.get",
            new=AsyncMock(
                return_value=SimpleNamespace(
                    boundary={"type": "Point", "coordinates": [0.0, 0.0]},
                ),
            ),
        ),
        patch(
            "trips.api.query.TripCostService.get_fillup_price_map",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "trips.api.query.TripCostService.calculate_trip_cost",
            return_value=0.0,
        ),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/trips?clip_to_coverage=true&coverage_area_id=invalid-area",
        )

    assert response.status_code == 422
    payload = response.json()
    assert payload["detail"] == (
        "Coverage area boundary is not a valid polygon and cannot be used for clipping."
    )
    assert _FakeTripModel.received_queries == []
