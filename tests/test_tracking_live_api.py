from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from tracking.api import live as live_api
from tracking.api.live import router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


def test_active_trip_endpoint_returns_live_payload() -> None:
    app = _create_app()
    active_trip = {
        "transactionId": "tx-live-api-1",
        "status": "active",
        "imei": "imei-1",
        "distance": 1.2,
        "pointsRecorded": 3,
        "lastUpdate": datetime(2026, 2, 21, 12, 0, tzinfo=UTC),
        "coordinates": [
            {
                "timestamp": datetime(2026, 2, 21, 11, 58, tzinfo=UTC),
                "lat": 32.0,
                "lon": -97.0,
            },
        ],
    }

    with (
        patch.object(
            live_api.TrackingService,
            "get_active_trip",
            new=AsyncMock(return_value=active_trip),
        ),
        TestClient(app) as client,
    ):
        response = client.get("/api/active_trip")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["has_active_trip"] is True
    assert payload["trip"]["transactionId"] == "tx-live-api-1"
    assert isinstance(payload["trip"]["distance"], float)
    assert isinstance(payload["trip"]["coordinates"], list)


def test_active_trip_endpoint_returns_no_active_payload() -> None:
    app = _create_app()

    with (
        patch.object(
            live_api.TrackingService,
            "get_active_trip",
            new=AsyncMock(return_value=None),
        ),
        TestClient(app) as client,
    ):
        response = client.get("/api/active_trip")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "success"
    assert payload["has_active_trip"] is False
    assert payload["message"] == "No active trip"


def test_trip_updates_endpoint_returns_trip_snapshot() -> None:
    app = _create_app()

    with (
        patch.object(live_api.db_manager, "_connection_healthy", new=True),
        patch.object(
            live_api.TrackingService,
            "get_trip_updates",
            new=AsyncMock(
                return_value={
                    "status": "success",
                    "has_update": True,
                    "trip": {
                        "transactionId": "tx-live-api-2",
                        "status": "active",
                        "distance": 2.5,
                    },
                },
            ),
        ),
        TestClient(app) as client,
    ):
        response = client.get("/api/trip_updates")

    assert response.status_code == 200
    payload = response.json()
    assert payload["has_update"] is True
    assert payload["trip"]["transactionId"] == "tx-live-api-2"
    assert "server_time" in payload


def test_trip_updates_endpoint_returns_no_update_after_clear() -> None:
    app = _create_app()

    with (
        patch.object(live_api.db_manager, "_connection_healthy", new=True),
        patch.object(
            live_api.TrackingService,
            "get_trip_updates",
            new=AsyncMock(
                return_value={
                    "status": "success",
                    "has_update": False,
                    "message": "No active trip",
                },
            ),
        ),
        TestClient(app) as client,
    ):
        response = client.get("/api/trip_updates")

    assert response.status_code == 200
    payload = response.json()
    assert payload["has_update"] is False
    assert payload["message"] == "No active trip"
