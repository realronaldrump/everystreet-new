from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes.routing import router as routing_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(routing_router)
    return app


def test_route_endpoint_success() -> None:
    app = _create_app()

    with patch("routes.routing.ValhallaClient") as client_mock:
        instance = client_mock.return_value
        instance.route = AsyncMock(
            return_value={
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-97.0, 32.0], [-97.1, 32.1]],
                },
                "duration_seconds": 120,
                "distance_meters": 1500,
            },
        )

        client = TestClient(app)
        response = client.post(
            "/api/routing/route",
            json={"origin": [-97.0, 32.0], "destination": [-97.1, 32.1]},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["route"]["duration"] == 120
    assert payload["route"]["distance"] == 1500
    assert payload["route"]["geometry"]["type"] == "LineString"


def test_route_endpoint_handles_valhalla_failure() -> None:
    app = _create_app()

    with patch("routes.routing.ValhallaClient") as client_mock:
        instance = client_mock.return_value
        instance.route = AsyncMock(side_effect=RuntimeError("valhalla down"))

        client = TestClient(app)
        response = client.post(
            "/api/routing/route",
            json={"origin": [-97.0, 32.0], "destination": [-97.1, 32.1]},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "valhalla down"


def test_eta_endpoint_validates_waypoints_length() -> None:
    app = _create_app()
    client = TestClient(app)

    response = client.post("/api/routing/eta", json={"waypoints": [[-97.0, 32.0]]})

    assert response.status_code == 422
