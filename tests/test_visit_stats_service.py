from __future__ import annotations

from datetime import UTC, datetime

import pytest
from shapely.geometry import MultiPoint

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
