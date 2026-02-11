from datetime import UTC, datetime, timedelta

import pytest
from beanie import init_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from db.models import Place, RecurringRoute, Trip
from recurring_routes.api import routes as recurring_routes_api


@pytest.fixture
async def place_pair_db():
    client = AsyncMongoMockClient()
    database = client["test_db"]
    await init_beanie(
        database=database,  # type: ignore[arg-type]
        document_models=[Trip, RecurringRoute, Place],
    )
    return database


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(recurring_routes_api.router)
    return app


def _point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [lon, lat]}


def _line(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": coords}


@pytest.mark.asyncio
async def test_place_pair_analysis_honors_90d_timeframe_and_place_fallback(place_pair_db) -> None:
    now = datetime.now(UTC).replace(microsecond=0)

    start_place = Place(name="Home", geometry=_point(-122.401, 37.790), created_at=now)
    end_place = Place(name="Office", geometry=_point(-122.394, 37.781), created_at=now)
    await start_place.insert()
    await end_place.insert()

    route = RecurringRoute(
        route_key="rk-home-office",
        route_signature="sig-home-office",
        auto_name="Home → Office",
        start_label="Home",
        end_label="Office",
    )
    await route.insert()

    # Forward, recent, linked route.
    await Trip(
        transactionId="pp-forward-1",
        imei="imei-1",
        startTime=now - timedelta(days=1),
        endTime=now - timedelta(days=1) + timedelta(minutes=24),
        startTimeZone="-0800",
        duration=1440,
        distance=8.4,
        gps=_line([[-122.401, 37.790], [-122.398, 37.786], [-122.394, 37.781]]),
        startGeoPoint=_point(-122.401, 37.790),
        destinationGeoPoint=_point(-122.394, 37.781),
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
        recurringRouteId=route.id,
    ).insert()

    # Forward, recent, destinationPlaceId fallback (no destinationGeoPoint).
    await Trip(
        transactionId="pp-forward-2",
        imei="imei-1",
        startTime=now - timedelta(days=2),
        endTime=now - timedelta(days=2) + timedelta(minutes=22),
        startTimeZone="-08:00",
        duration=1320,
        distance=8.1,
        gps=_line([[-122.401, 37.790], [-122.399, 37.787], [-122.395, 37.782]]),
        startGeoPoint=_point(-122.401, 37.790),
        destinationGeoPoint=None,
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
        recurringRouteId=route.id,
    ).insert()

    # Reverse, recent.
    await Trip(
        transactionId="pp-reverse-1",
        imei="imei-1",
        startTime=now - timedelta(days=3),
        endTime=now - timedelta(days=3) + timedelta(minutes=20),
        duration=1200,
        distance=8.0,
        gps=_line([[-122.394, 37.781], [-122.398, 37.786], [-122.401, 37.790]]),
        startGeoPoint=_point(-122.394, 37.781),
        destinationGeoPoint=_point(-122.401, 37.790),
        startPlaceId=str(end_place.id),
        destinationPlaceId=str(start_place.id),
    ).insert()

    # Forward but outside default 90d timeframe.
    await Trip(
        transactionId="pp-forward-old",
        imei="imei-1",
        startTime=now - timedelta(days=120),
        endTime=now - timedelta(days=120) + timedelta(minutes=30),
        duration=1800,
        distance=9.0,
        gps=_line([[-122.401, 37.790], [-122.398, 37.786], [-122.394, 37.781]]),
        startGeoPoint=_point(-122.401, 37.790),
        destinationGeoPoint=_point(-122.394, 37.781),
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
    ).insert()

    # Forward, gps-only endpoint fallback (no place ids or explicit GeoPoints).
    await Trip(
        transactionId="pp-forward-gps-only",
        imei="imei-1",
        startTime=now - timedelta(days=4),
        endTime=now - timedelta(days=4) + timedelta(minutes=26),
        duration=1560,
        distance=8.2,
        gps=_line([[-122.401, 37.790], [-122.397, 37.785], [-122.394, 37.781]]),
        startGeoPoint=None,
        destinationGeoPoint=None,
    ).insert()

    client = TestClient(_build_app())
    resp = client.get(
        "/api/recurring_routes/place_pair_analysis",
        params={
            "start_place_id": str(start_place.id),
            "end_place_id": str(end_place.id),
            "timeframe": "90d",
            "limit": 500,
        },
    )

    assert resp.status_code == 200
    body = resp.json()

    assert body["status"] == "success"
    assert body["start_place"]["id"] == str(start_place.id)
    assert body["end_place"]["id"] == str(end_place.id)
    assert body["include_reverse"] is False
    assert body["timeframe"] == "90d"
    assert body["query"]["matched"] == 3
    assert body["query"]["include_reverse"] is False
    assert body["query"]["requested_timeframe"] == "90d"
    assert body["query"]["timeframe"] == "90d"
    assert body["query"]["timeframe_cutoff"] is not None
    assert body["query"]["sample_limit"] == 500

    assert body["places"]["start"]["id"] == str(start_place.id)
    assert body["places"]["end"]["id"] == str(end_place.id)

    assert body["summary"]["trip_count"] == 3
    assert body["summary"]["variant_count"] >= 2
    assert body["summary"]["median_distance"] is not None
    assert body["summary"]["median_duration"] is not None
    assert body["summary"]["trips_per_week"] == pytest.approx(1.5)
    assert body["tripsPerWeek"] == pytest.approx(1.5)
    assert body["summary"]["first_trip"] is not None
    assert body["summary"]["last_trip"] is not None
    assert len(body["byHour"]) == 24
    assert len(body["byDayOfWeek"]) == 7

    linked_variant = next(
        (variant for variant in body["variants"] if variant.get("route_id") == str(route.id)),
        None,
    )
    assert linked_variant is not None
    assert linked_variant["trip_count"] == 2
    assert linked_variant["preview_path"]
    assert linked_variant["representative_geometry"]

    assert len(body["sampleTrips"]) == 3
    assert "pp-forward-old" not in {trip["transactionId"] for trip in body["sampleTrips"]}
    assert body["sampleTrips"][0]["startPlaceId"] == str(start_place.id)
    assert body["sampleTrips"][0]["destinationPlaceId"] == str(end_place.id)
    assert body["sampleTrips"][0]["place_links"]["start"]["label"] == "Home"
    assert body["sampleTrips"][0]["place_links"]["end"]["label"] == "Office"


@pytest.mark.asyncio
async def test_place_pair_analysis_include_reverse_all_and_limit(place_pair_db) -> None:
    now = datetime(2026, 2, 10, 8, 0, tzinfo=UTC)

    start_place = Place(name="Gym", geometry=_point(-122.431, 37.765), created_at=now)
    end_place = Place(name="Store", geometry=_point(-122.420, 37.775), created_at=now)
    await start_place.insert()
    await end_place.insert()

    linked_route = RecurringRoute(
        route_key="rk-gym-store",
        route_signature="sig-gym-store",
        auto_name="Gym → Store",
        start_label="Gym",
        end_label="Store",
    )
    await linked_route.insert()

    await Trip(
        transactionId="pp2-forward-1",
        imei="imei-2",
        startTime=now - timedelta(days=1),
        endTime=now - timedelta(days=1) + timedelta(minutes=10),
        duration=600,
        distance=4.5,
        gps=_line([[-122.431, 37.765], [-122.427, 37.769], [-122.420, 37.775]]),
        startGeoPoint=_point(-122.431, 37.765),
        destinationGeoPoint=_point(-122.420, 37.775),
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
        recurringRouteId=linked_route.id,
    ).insert()

    await Trip(
        transactionId="pp2-forward-2",
        imei="imei-2",
        startTime=now - timedelta(days=2),
        endTime=now - timedelta(days=2) + timedelta(minutes=11),
        duration=660,
        distance=4.7,
        gps=_line([[-122.431, 37.765], [-122.426, 37.770], [-122.420, 37.775]]),
        startGeoPoint=_point(-122.431, 37.765),
        destinationGeoPoint=_point(-122.420, 37.775),
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
        recurringRouteId=linked_route.id,
    ).insert()

    await Trip(
        transactionId="pp2-reverse-1",
        imei="imei-2",
        startTime=now - timedelta(days=3),
        endTime=now - timedelta(days=3) + timedelta(minutes=9),
        duration=540,
        distance=4.4,
        gps=_line([[-122.420, 37.775], [-122.426, 37.770], [-122.431, 37.765]]),
        startGeoPoint=_point(-122.420, 37.775),
        destinationGeoPoint=_point(-122.431, 37.765),
        startPlaceId=str(end_place.id),
        destinationPlaceId=str(start_place.id),
    ).insert()

    await Trip(
        transactionId="pp2-forward-old",
        imei="imei-2",
        startTime=now - timedelta(days=200),
        endTime=now - timedelta(days=200) + timedelta(minutes=12),
        duration=720,
        distance=4.8,
        gps=_line([[-122.431, 37.765], [-122.425, 37.771], [-122.420, 37.775]]),
        startGeoPoint=_point(-122.431, 37.765),
        destinationGeoPoint=_point(-122.420, 37.775),
        startPlaceId=str(start_place.id),
        destinationPlaceId=str(end_place.id),
    ).insert()

    client = TestClient(_build_app())
    resp = client.get(
        "/api/recurring_routes/place_pair_analysis",
        params={
            "start_place_id": str(start_place.id),
            "end_place_id": str(end_place.id),
            "include_reverse": "true",
            "timeframe": "all",
            "limit": 3,
        },
    )

    assert resp.status_code == 200
    body = resp.json()

    assert body["include_reverse"] is True
    assert body["timeframe"] == "all"
    assert body["query"]["matched"] == 4
    assert body["query"]["include_reverse"] is True
    assert body["query"]["sample_limit"] == 3
    assert body["query"]["timeframe"] == "all"
    assert len(body["sampleTrips"]) == 3

    directions = {trip["direction"] for trip in body["sampleTrips"]}
    assert "reverse" in directions

    # Grouping prefers recurringRouteId when present, with fallback for unlinked trips.
    variants = body["variants"]
    assert any(v.get("route_id") == str(linked_route.id) for v in variants)
    assert any(v.get("route_id") is None for v in variants)
    assert body["summary"]["trip_count"] == 4
    assert body["summary"]["variant_count"] == len(variants)


@pytest.mark.asyncio
async def test_place_pair_analysis_missing_and_invalid_place_ids(place_pair_db) -> None:
    now = datetime(2026, 2, 10, 8, 0, tzinfo=UTC)
    start_place = Place(name="A", geometry=_point(-122.401, 37.79), created_at=now)
    end_place = Place(name="B", geometry=_point(-122.394, 37.781), created_at=now)
    await start_place.insert()
    await end_place.insert()

    client = TestClient(_build_app())

    missing_resp = client.get(
        "/api/recurring_routes/place_pair_analysis",
        params={"start_place_id": str(start_place.id)},
    )
    assert missing_resp.status_code == 422

    invalid_resp = client.get(
        "/api/recurring_routes/place_pair_analysis",
        params={
            "start_place_id": "not-a-valid-id",
            "end_place_id": str(end_place.id),
        },
    )
    assert invalid_resp.status_code == 400
    assert invalid_resp.json()["detail"] == "Invalid place id"

    not_found_resp = client.get(
        "/api/recurring_routes/place_pair_analysis",
        params={
            "start_place_id": str(start_place.id),
            "end_place_id": "67abf33e95b37f2dbf37f2db",
        },
    )
    assert not_found_resp.status_code == 404
