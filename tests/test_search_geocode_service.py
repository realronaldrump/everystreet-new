from unittest.mock import AsyncMock

import pytest

from search.services.search_service import SearchService


@pytest.mark.asyncio
async def test_geocode_search_merges_proximity_and_global_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forward_geocode = AsyncMock(
        side_effect=[
            [
                {
                    "text": "Starbucks",
                    "place_name": "Starbucks, Waco, Texas",
                    "center": [-97.1905, 31.5338],
                    "osm_id": 101,
                    "osm_type": "node",
                    "importance": 0.8,
                },
            ],
            [
                {
                    "text": "Starbucks",
                    "place_name": "Starbucks, Waco, Texas",
                    "center": [-97.1905, 31.5338],
                    "osm_id": 101,
                    "osm_type": "node",
                    "importance": 0.8,
                },
                {
                    "text": "Starbucks Reserve",
                    "place_name": "Starbucks Reserve, Austin, Texas",
                    "center": [-97.7431, 30.2672],
                    "osm_id": 202,
                    "osm_type": "node",
                    "importance": 0.7,
                },
            ],
        ],
    )
    monkeypatch.setattr(SearchService._geo_service, "forward_geocode", forward_geocode)

    response = await SearchService.geocode_search(
        query="Starbucks",
        limit=2,
        proximity_lon=-97.1467,
        proximity_lat=31.5493,
    )

    results = response["results"]
    assert len(results) == 2
    assert forward_geocode.await_count == 2
    assert results[0]["text"] == "Starbucks"
    assert results[1]["text"] == "Starbucks Reserve"

    first_call = forward_geocode.await_args_list[0]
    assert first_call.args[0] == "Starbucks"
    assert first_call.kwargs["strict_bounds"] is False

    second_call = forward_geocode.await_args_list[1]
    assert second_call.args[0] == "Starbucks"
    assert second_call.kwargs["proximity"] is None


@pytest.mark.asyncio
async def test_geocode_search_skips_global_fallback_when_primary_has_enough(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forward_geocode = AsyncMock(
        return_value=[
            {
                "text": "Austin",
                "place_name": "Austin, Texas",
                "center": [-97.7431, 30.2672],
                "osm_id": 333,
                "osm_type": "relation",
                "importance": 0.9,
            },
            {
                "text": "Austin County",
                "place_name": "Austin County, Texas",
                "center": [-96.3, 29.9],
                "osm_id": 444,
                "osm_type": "relation",
                "importance": 0.6,
            },
        ],
    )
    monkeypatch.setattr(SearchService._geo_service, "forward_geocode", forward_geocode)

    response = await SearchService.geocode_search(
        query="Austin",
        limit=2,
        proximity_lon=-97.7431,
        proximity_lat=30.2672,
    )

    assert len(response["results"]) == 2
    assert forward_geocode.await_count == 1
