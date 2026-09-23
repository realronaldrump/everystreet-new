from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shapely.geometry import MultiPoint

from visits.api import stats as stats_api
from visits.services import visit_stats_service, visit_tracking_service
from visits.services.visit_stats_service import VisitStatsService


class _FakePlaceQuery:
    async def to_list(self) -> list[object]:
        return []


@pytest.mark.asyncio
async def test_get_visit_suggestions_uses_shared_destination_extractors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    docs = [
        {
            "endTime": datetime(2026, 3, 1, 14, tzinfo=UTC),
            "destinationPlaceName": "Coffee Shop",
            "destinationGeoPoint": {
                "type": "Point",
                "coordinates": [-97.7431, 30.2671],
            },
        },
        {
            "endTime": datetime(2026, 3, 2, 14, tzinfo=UTC),
            "destination": {"formatted_address": "123 Main St"},
            "destinationGeoPoint": {
                "type": "Point",
                "coordinates": [-97.7432, 30.2672],
            },
        },
    ]

    async def fake_aggregate_to_list(*_args, **_kwargs) -> list[dict[str, object]]:
        return docs

    def fake_transformers(*_args, **_kwargs):
        return (lambda lng, lat: (lng, lat), lambda lng, lat: (lng, lat))

    def fake_boundary(*, points: list[tuple[float, float]], cell_size_m: int):
        del cell_size_m
        return MultiPoint(points).convex_hull.buffer(0.0001)

    monkeypatch.setattr(
        "visits.services.visit_stats_service.aggregate_to_list",
        fake_aggregate_to_list,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.Place.find_all",
        lambda: _FakePlaceQuery(),
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.get_local_transformers",
        fake_transformers,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.build_destination_cluster_boundary",
        fake_boundary,
    )

    suggestions = await VisitStatsService.get_visit_suggestions(
        min_visits=2,
        cell_size_m=1,
    )

    assert len(suggestions) == 1
    assert suggestions[0].suggestedName == "Coffee Shop"
    assert suggestions[0].totalVisits == 2


@pytest.mark.asyncio
async def test_visit_read_is_compact_visible_and_bounded_by_timeframe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_aggregate(_model, pipeline, **_kwargs):
        captured["pipeline"] = pipeline
        return []

    monkeypatch.setattr(visit_tracking_service, "aggregate_to_list", fake_aggregate)
    cutoff = datetime(2026, 3, 1, tzinfo=UTC)
    place = SimpleNamespace(id="place-1", geometry=None)

    await visit_tracking_service.VisitTrackingService.calculate_visits_for_place(
        place,
        arrival_since=cutoff,
    )

    pipeline = captured["pipeline"]
    outer_match = pipeline[0]["$match"]
    assert outer_match["source"] == "bouncie"
    assert outer_match["invalid"] == {"$ne": True}
    assert outer_match["inactive"] == {"$ne": True}
    assert outer_match["$or"] == [
        {"endTime": {"$gte": cutoff}},
        {"startTime": {"$gte": cutoff}},
    ]
    assert len(pipeline) == 2
    projection = pipeline[1]["$project"]
    assert projection["imei"] == 1
    assert projection["startTime"] == 1
    assert projection["destinationGeoPoint"] == 1
    assert "gps" not in projection
    assert "coordinates" not in projection


@pytest.mark.asyncio
async def test_all_place_statistics_forwards_arrival_timeframe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cutoff = datetime(2026, 2, 1, tzinfo=UTC)
    place = SimpleNamespace(id="place-1", name="Home", geometry=None)
    captured: list[datetime | None] = []

    class _PlacesQuery:
        async def to_list(self):
            return [place]

    async def fake_visits(_places, *, arrival_since=None):
        captured.append(arrival_since)
        return {"place-1": []}

    monkeypatch.setattr(
        "visits.services.visit_stats_service._resolve_timeframe_start",
        lambda *_args, **_kwargs: cutoff,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.Place.find_all",
        _PlacesQuery,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.VisitTrackingService.calculate_visits_for_places",
        fake_visits,
    )

    rows = await VisitStatsService.get_all_places_statistics("month")

    assert len(rows) == 1
    assert captured == [cutoff]


def test_places_statistics_api_forwards_timeframe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service_mock = AsyncMock(return_value=[])
    monkeypatch.setattr(
        stats_api.VisitStatsService,
        "get_all_places_statistics",
        service_mock,
    )
    app = FastAPI()
    app.include_router(stats_api.router)

    response = TestClient(app).get("/api/places/statistics?timeframe=month")

    assert response.status_code == 200
    service_mock.assert_awaited_once_with("month")

    service_mock.reset_mock()
    response = TestClient(app).get("/api/places/statistics")
    assert response.status_code == 200
    service_mock.assert_awaited_once_with(None)


@pytest.mark.asyncio
async def test_non_custom_visit_match_includes_null_place_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_aggregate(_model, pipeline, **_kwargs):
        captured["pipeline"] = pipeline
        return []

    monkeypatch.setattr(
        "visits.services.visit_stats_service.aggregate_to_list",
        fake_aggregate,
    )

    await VisitStatsService.get_non_custom_places_visits()

    match = captured["pipeline"][0]["$match"]
    assert match["source"] == "bouncie"
    place_id_clause = match["$and"][0]["$or"]
    assert {"destinationPlaceId": None} in place_id_clause
    assert {"destinationPlaceId": ""} in place_id_clause


def test_visit_suggestion_match_is_scoped_to_bouncie() -> None:
    match = visit_stats_service._suggestion_match_stage("month")

    assert match["source"] == "bouncie"
    assert match["invalid"] == {"$ne": True}
    assert match["inactive"] == {"$ne": True}


@pytest.mark.parametrize("timeframe", [None, "", "all", "ALL", " all "])
def test_all_timeframe_is_unbounded(timeframe) -> None:
    assert (
        visit_stats_service._resolve_timeframe_start(
            timeframe, error_message="bad timeframe"
        )
        is None
    )


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 3, 1, hour, minute, tzinfo=UTC)


def test_batch_visits_match_boundaries_once_and_find_same_vehicle_departures() -> None:
    place = SimpleNamespace(
        id="home",
        name="Home",
        geometry={
            "type": "Polygon",
            "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        },
    )
    empty_place = SimpleNamespace(id="empty", name="Empty", geometry=None)
    docs = [
        {
            "transactionId": "later",
            "imei": "one",
            "startTime": _at(12),
            "endTime": _at(13),
            "destinationPlaceId": "home",
        },
        {
            "transactionId": "arrival",
            "imei": "one",
            "startTime": _at(8),
            "endTime": _at(9),
            "destinationPlaceId": "home",
            "destinationGeoPoint": {"type": "Point", "coordinates": [0.5, 0.5]},
        },
        {"transactionId": "other-vehicle", "imei": "two", "startTime": _at(9, 5)},
        {"transactionId": "overlap", "imei": "one", "startTime": _at(8, 50)},
        {"transactionId": "departure", "imei": "one", "startTime": _at(10)},
        {
            "transactionId": "boundary",
            "imei": "one",
            "startTime": _at(10, 30),
            "endTime": _at(11),
            "destinationGeoPoint": {"type": "Point", "coordinates": [0, 0.5]},
        },
        {"transactionId": "zero-dwell", "imei": "one", "startTime": _at(11)},
    ]

    grouped = visit_tracking_service._calculate_visits(docs, [place, empty_place])

    visits = grouped["home"]
    assert grouped["empty"] == []
    assert [v["arrival_trip"]["transactionId"] for v in visits] == [
        "arrival",
        "boundary",
        "later",
    ]
    assert [v["duration"] for v in visits] == [3600, 0, None]
    assert [v["departure_time"] for v in visits] == [_at(10), _at(11), None]
    assert [v["time_since_last"] for v in visits] == [None, 3600, 7200]


def test_batch_visits_timeframe_missing_vehicle_and_invalid_geometry() -> None:
    place = SimpleNamespace(id="home", geometry={"type": "bad geometry"})
    docs = [
        {
            "transactionId": "before",
            "imei": "one",
            "startTime": _at(8),
            "endTime": _at(9),
            "destinationPlaceId": "home",
        },
        {
            "transactionId": "missing-imei",
            "imei": None,
            "startTime": _at(9),
            "endTime": _at(10),
            "destinationPlaceId": "home",
        },
        {"transactionId": "empty-imei", "imei": "", "startTime": _at(11)},
        {"transactionId": "departure", "imei": "one", "startTime": _at(12)},
    ]

    visits = visit_tracking_service._calculate_visits(
        docs, [place], arrival_since=_at(10)
    )["home"]

    assert len(visits) == 1
    assert visits[0]["arrival_trip"]["transactionId"] == "missing-imei"
    assert visits[0]["duration"] is None
    assert visits[0]["departure_time"] is None
    assert visits[0]["time_since_last"] is None


@pytest.mark.asyncio
async def test_all_places_share_one_trip_read(monkeypatch: pytest.MonkeyPatch) -> None:
    places = [
        SimpleNamespace(id=str(i), name=f"Place {i}", geometry=None) for i in range(41)
    ]

    class _PlacesQuery:
        async def to_list(self):
            return places

    trip_read = AsyncMock(return_value=[])
    monkeypatch.setattr(visit_stats_service.Place, "find_all", _PlacesQuery)
    monkeypatch.setattr(visit_tracking_service, "aggregate_to_list", trip_read)

    rows = await VisitStatsService.get_all_places_statistics("all")

    assert len(rows) == 41
    assert all(row.totalVisits == 0 for row in rows)
    trip_read.assert_awaited_once()


@pytest.mark.asyncio
async def test_compact_trip_read_filters_invisible_departures(beanie_db) -> None:
    await beanie_db.trips.insert_many(
        [
            {
                "source": "bouncie",
                "transactionId": "arrival",
                "imei": "one",
                "startTime": _at(8),
                "endTime": _at(9),
                "destinationPlaceId": "home",
                "gps": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            },
            {
                "source": "bouncie",
                "transactionId": "invalid",
                "imei": "one",
                "startTime": _at(9, 5),
                "invalid": True,
            },
            {
                "source": "bouncie",
                "transactionId": "inactive",
                "imei": "one",
                "startTime": _at(9, 10),
                "inactive": True,
            },
            {
                "source": "upload",
                "transactionId": "uploaded",
                "imei": "one",
                "startTime": _at(9, 15),
            },
            {
                "source": "bouncie",
                "transactionId": "other-vehicle",
                "imei": "two",
                "startTime": _at(9, 20),
            },
            {
                "source": "bouncie",
                "transactionId": "departure",
                "imei": "one",
                "startTime": _at(10),
            },
        ]
    )

    visits = (
        await visit_tracking_service.VisitTrackingService.calculate_visits_for_place(
            SimpleNamespace(id="home", geometry=None), arrival_since=_at(9)
        )
    )

    assert len(visits) == 1
    assert visits[0]["duration"] == 3600
    assert visits[0]["departure_time"] == _at(10)
    assert "gps" not in visits[0]["arrival_trip"]


@pytest.mark.asyncio
async def test_suggestions_project_endpoints_instead_of_full_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    trip_read = AsyncMock(return_value=[])
    monkeypatch.setattr(visit_stats_service, "aggregate_to_list", trip_read)

    assert await VisitStatsService.get_visit_suggestions(timeframe="all") == []

    pipeline = trip_read.call_args.args[1]
    projection = pipeline[1]["$project"]
    assert projection["gps"]["type"] == {"$literal": "Point"}
    branches = projection["gps"]["coordinates"]["$switch"]["branches"]
    assert branches[0]["then"] == {"$arrayElemAt": ["$gps.coordinates", -1]}


@pytest.mark.asyncio
async def test_suggestion_projection_preserves_route_endpoint(
    monkeypatch: pytest.MonkeyPatch, beanie_db
) -> None:
    await beanie_db.trips.insert_one(
        {
            "source": "bouncie",
            "endTime": _at(9),
            "gps": {"type": "LineString", "coordinates": [[0, 0], [1, 1], [2, 2]]},
        }
    )
    captured = []

    def build(docs, *_args, **_kwargs):
        captured.extend(docs)
        return []

    monkeypatch.setattr(visit_stats_service.Place, "find_all", _FakePlaceQuery)
    monkeypatch.setattr(visit_stats_service, "_build_visit_suggestions", build)

    assert await VisitStatsService.get_visit_suggestions(timeframe="all") == []
    assert len(captured) == 1
    assert captured[0]["gps"] == {"type": "Point", "coordinates": [2, 2]}


@pytest.mark.parametrize(
    "query", ["min_visits=0", "min_visits=1001", "cell_size_m=0", "cell_size_m=2001"]
)
def test_suggestion_api_rejects_unbounded_inputs(query: str) -> None:
    app = FastAPI()
    app.include_router(stats_api.router)

    assert TestClient(app).get(f"/api/visit_suggestions?{query}").status_code == 422
