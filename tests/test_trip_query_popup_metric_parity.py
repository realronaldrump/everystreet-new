from __future__ import annotations

from typing import ClassVar
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
    docs: ClassVar[list[dict]] = []

    @classmethod
    def find(cls, _query):
        return _TripCursor(cls.docs)


def test_trip_popup_metrics_match_for_regular_and_matched_layers() -> None:
    _FakeTripModel.docs = [
        {
            "transactionId": "trip-1",
            "imei": "imei-1",
            "source": "bouncie",
            "startTime": "2026-03-01T10:00:00+00:00",
            "endTime": "2026-03-01T11:30:00+00:00",
            "startTimeZone": "America/Chicago",
            "endTimeZone": "America/Chicago",
            "distance": 42.1,
            "maxSpeed": 78.0,
            "avgSpeed": 36.2,
            "gps": {
                "type": "LineString",
                "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
            },
            "matchedGps": {
                "type": "LineString",
                "coordinates": [[-97.0, 32.0], [-97.1, 32.1], [-97.2, 32.2]],
            },
        },
    ]

    app = _create_app()

    with (
        patch("trips.api.query.Trip", _FakeTripModel),
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
        regular = client.get("/api/trips")
        matched = client.get("/api/matched_trips")

    assert regular.status_code == 200
    assert matched.status_code == 200

    regular_props = regular.json()["features"][0]["properties"]
    matched_props = matched.json()["features"][0]["properties"]

    for key in ("startTime", "endTime", "distance", "duration", "avgSpeed", "maxSpeed"):
        assert matched_props[key] == regular_props[key]

    assert regular_props["startTimeZone"] == "America/Chicago"
    assert regular_props["endTimeZone"] == "America/Chicago"
    assert regular_props["timeZone"] == "America/Chicago"
    assert matched_props["timeZone"] == "America/Chicago"
