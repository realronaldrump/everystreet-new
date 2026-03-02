from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.journey import JourneyFeedService, build_historical_trip_query, router, service


@pytest.mark.asyncio
async def test_journey_feed_sorts_and_tolerates_partial_source_failures() -> None:
    service = JourneyFeedService()

    service._fetch_trip_events = AsyncMock(
        return_value=[
            {
                "id": "trip:1",
                "type": "trip",
                "timestamp": "2026-01-02T12:00:00Z",
                "title": "Trip",
                "summary": "",
                "source_url": "/trips?trip_id=1",
            }
        ]
    )
    service._fetch_visit_events = AsyncMock(
        return_value=[
            {
                "id": "visit:1",
                "type": "visit",
                "timestamp": "2026-01-01T12:00:00Z",
                "title": "Visit",
                "summary": "",
                "source_url": "/visits",
            }
        ]
    )
    service._fetch_fuel_events = AsyncMock(side_effect=RuntimeError("fuel unavailable"))
    service._fetch_coverage_events = AsyncMock(return_value=[])
    service._fetch_map_matching_events = AsyncMock(
        return_value=[
            {
                "id": "map_matching:1",
                "type": "map_matching",
                "timestamp": "2026-01-03T12:00:00Z",
                "title": "Map Matching",
                "summary": "",
                "source_url": "/map-matching?job=1",
            }
        ]
    )

    payload = await service.get_feed(
        start_date="2026-01-01",
        end_date="2026-01-03",
        vehicle=None,
        cursor=None,
        limit=10,
    )

    event_ids = [event["id"] for event in payload["events"]]
    assert event_ids == ["visit:1", "trip:1", "map_matching:1"]

    assert payload["meta"]["returned"] == 3
    assert payload["meta"]["source_counts"]["fuel"] == 0
    assert "fuel" in payload["errors"]


@pytest.mark.asyncio
async def test_journey_feed_pagination_cursor_and_has_more() -> None:
    service = JourneyFeedService()

    service._fetch_trip_events = AsyncMock(
        return_value=[
            {
                "id": "trip:1",
                "type": "trip",
                "timestamp": "2026-01-01T10:00:00Z",
                "title": "Trip 1",
                "summary": "",
                "source_url": "/trips?trip_id=1",
            },
            {
                "id": "trip:2",
                "type": "trip",
                "timestamp": "2026-01-01T11:00:00Z",
                "title": "Trip 2",
                "summary": "",
                "source_url": "/trips?trip_id=2",
            },
        ]
    )
    service._fetch_visit_events = AsyncMock(return_value=[])
    service._fetch_fuel_events = AsyncMock(return_value=[])
    service._fetch_coverage_events = AsyncMock(return_value=[])
    service._fetch_map_matching_events = AsyncMock(return_value=[])

    payload = await service.get_feed(
        start_date=None,
        end_date=None,
        vehicle=None,
        cursor=None,
        limit=1,
    )

    assert payload["meta"]["has_more"] is True
    assert payload["meta"]["next_cursor"] == "2026-01-01T10:00:00Z"
    assert len(payload["events"]) == 1


def test_build_historical_trip_query_enforces_bouncie_source() -> None:
    query = build_historical_trip_query(
        start_date=None,
        end_date=None,
        vehicle="imei-1",
        date_field="startTime",
    )

    assert query["source"] == "bouncie"
    assert query["imei"] == "imei-1"
    assert query["invalid"] == {"$ne": True}


def test_journey_feed_endpoint_wiring() -> None:
    app = FastAPI()
    app.include_router(router)

    original = service.get_feed
    service.get_feed = AsyncMock(  # type: ignore[method-assign]
        return_value={"events": [], "meta": {"returned": 0}, "errors": {}}
    )
    try:
        client = TestClient(app)
        response = client.get(
            "/api/journey/feed?start_date=2026-01-01&end_date=2026-01-02"
        )
    finally:
        service.get_feed = original  # type: ignore[method-assign]

    assert response.status_code == 200
    assert response.json()["meta"]["returned"] == 0
