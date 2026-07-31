from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from db_helpers import init_mock_beanie

from db.models import Place, RecurringRoute, Trip
from visits.services.place_service import PlaceService


@pytest.fixture
async def places_db():
    return await init_mock_beanie(
        Place,
        Trip,
        RecurringRoute,
        database_name="test_places_db",
    )


@pytest.fixture(autouse=True)
def stub_preview_delete(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "visits.services.place_service.PlacePreviewService.delete_preview",
        AsyncMock(return_value=None),
    )


async def _make_place(name: str) -> Place:
    place = Place(name=name, geometry={"type": "Point", "coordinates": [0.0, 0.0]})
    await place.insert()
    return place


async def _make_route(key: str, **kwargs) -> RecurringRoute:
    route = RecurringRoute(route_key=key, route_signature=key, **kwargs)
    await route.insert()
    return route


@pytest.mark.asyncio
async def test_deleting_a_place_clears_trip_references(places_db) -> None:
    del places_db
    place = await _make_place("Home")
    place_id = str(place.id)
    await Trip(
        transactionId="tx-1",
        source="bouncie",
        destinationPlaceId=place_id,
        destinationPlaceName="Home",
    ).insert()

    result = await PlaceService.delete_place(place_id)

    assert result["trips_updated"] == 1
    trip = await Trip.find_one({"transactionId": "tx-1"})
    assert trip is not None
    assert trip.destinationPlaceId is None
    assert trip.destinationPlaceName is None


@pytest.mark.asyncio
async def test_deleting_a_place_clears_trip_start_reference(places_db) -> None:
    """A deleted place cannot be restored onto a route from a Historical Trip."""
    del places_db
    place = await _make_place("Home")
    place_id = str(place.id)
    await Trip(
        transactionId="tx-start",
        source="bouncie",
        startPlaceId=place_id,
    ).insert()

    result = await PlaceService.delete_place(place_id)

    assert result["trips_updated"] == 1
    trip = await Trip.find_one({"transactionId": "tx-start"})
    assert trip is not None
    assert getattr(trip, "startPlaceId", None) is None


@pytest.mark.asyncio
async def test_deleting_a_place_clears_both_trip_ends_once(places_db) -> None:
    """One Historical Trip can reference the same place at both ends."""
    del places_db
    place = await _make_place("Depot")
    place_id = str(place.id)
    await Trip(
        transactionId="tx-round-trip",
        source="bouncie",
        startPlaceId=place_id,
        destinationPlaceId=place_id,
        destinationPlaceName="Depot",
    ).insert()

    result = await PlaceService.delete_place(place_id)

    assert result["trips_updated"] == 1
    trip = await Trip.find_one({"transactionId": "tx-round-trip"})
    assert trip is not None
    assert getattr(trip, "startPlaceId", None) is None
    assert trip.destinationPlaceId is None
    assert trip.destinationPlaceName is None


@pytest.mark.asyncio
async def test_deleting_a_place_leaves_other_places_alone(places_db) -> None:
    del places_db
    doomed = await _make_place("Home")
    keeper = await _make_place("Work")
    await Trip(
        transactionId="tx-keep",
        source="bouncie",
        destinationPlaceId=str(keeper.id),
        destinationPlaceName="Work",
    ).insert()

    result = await PlaceService.delete_place(str(doomed.id))

    assert result["trips_updated"] == 0
    trip = await Trip.find_one({"transactionId": "tx-keep"})
    assert trip is not None
    assert trip.destinationPlaceId == str(keeper.id)
    assert await Place.get(keeper.id) is not None


@pytest.mark.asyncio
async def test_deleting_a_place_clears_only_the_matching_route_end(
    places_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del places_db
    refresh = AsyncMock(return_value={"status": "queued", "job_id": "job-1"})
    monkeypatch.setattr(
        "trips.services.inactive_trip_service.InactiveTripService"
        ".queue_recurring_routes_refresh",
        refresh,
    )

    doomed = await _make_place("Home")
    keeper = await _make_place("Work")
    await _make_route(
        "route-a",
        start_place_id=str(doomed.id),
        end_place_id=str(keeper.id),
    )

    result = await PlaceService.delete_place(str(doomed.id))

    assert result["routes_updated"] == 1
    route = await RecurringRoute.find_one({"route_key": "route-a"})
    assert route is not None
    assert route.start_place_id is None
    assert route.end_place_id == str(keeper.id)
    refresh.assert_awaited_once()


@pytest.mark.asyncio
async def test_no_route_rebuild_when_no_routes_referenced_the_place(
    places_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del places_db
    refresh = AsyncMock(return_value={"status": "queued"})
    monkeypatch.setattr(
        "trips.services.inactive_trip_service.InactiveTripService"
        ".queue_recurring_routes_refresh",
        refresh,
    )
    place = await _make_place("Home")

    result = await PlaceService.delete_place(str(place.id))

    assert result["routes_updated"] == 0
    refresh.assert_not_awaited()


@pytest.mark.asyncio
async def test_deleting_a_missing_place_is_a_no_op(places_db) -> None:
    del places_db
    place = await _make_place("Gone")
    place_id = str(place.id)
    await place.delete()

    result = await PlaceService.delete_place(place_id)

    assert result["status"] == "success"
    assert result["trips_updated"] == 0
    assert result["routes_updated"] == 0
