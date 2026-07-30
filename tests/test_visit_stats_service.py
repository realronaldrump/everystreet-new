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
async def test_visit_lookup_uses_same_visible_bouncie_vehicle_and_allows_zero_dwell(
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
    assert outer_match["endTime"] == {"$gte": cutoff}

    lookup = pipeline[2]["$lookup"]
    assert lookup["let"] == {
        "arrivalEnd": "$endTime",
        "arrivalImei": "$imei",
    }
    lookup_expr = lookup["pipeline"][0]["$match"]["$expr"]["$and"]
    assert {"$ne": ["$$arrivalImei", ""]} in lookup_expr
    assert {"$eq": ["$imei", "$$arrivalImei"]} in lookup_expr
    assert {"$gte": ["$startTime", "$$arrivalEnd"]} in lookup_expr
    assert lookup["pipeline"][1]["$match"] == {
        "source": "bouncie",
        "invalid": {"$ne": True},
        "inactive": {"$ne": True},
    }


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

    async def fake_visits(_place, *, arrival_since=None):
        captured.append(arrival_since)
        return []

    monkeypatch.setattr(
        "visits.services.visit_stats_service._resolve_timeframe_start",
        lambda *_args, **_kwargs: cutoff,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.Place.find_all",
        _PlacesQuery,
    )
    monkeypatch.setattr(
        "visits.services.visit_stats_service.VisitTrackingService.calculate_visits_for_place",
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
