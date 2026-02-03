from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from street_coverage.api import router as coverage_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(coverage_router)
    return app


def test_validate_area_returns_candidates() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Waco, Texas, USA",
            "osm_id": 123,
            "osm_type": "relation",
            "type": "city",
            "class": "place",
            "address": {"city": "Waco", "state": "Texas"},
            "importance": 0.8,
            "boundingbox": ["31.4", "31.6", "-97.3", "-97.1"],
        }
    ]

    with patch(
        "street_coverage.api.areas.NominatimClient.search_raw",
        new=AsyncMock(return_value=search_results),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Waco, TX", "area_type": "city", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["display_name"] == "Waco, Texas, USA"
    assert data["candidates"][0]["type_match"] is True
    assert data["candidates"][0]["bounding_box"] == [-97.3, 31.4, -97.1, 31.6]


def test_validate_area_returns_404_on_no_match() -> None:
    app = _create_app()

    with patch(
        "street_coverage.api.areas.NominatimClient.search_raw",
        new=AsyncMock(return_value=[]),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Nowhere", "area_type": "city"},
        )

    assert response.status_code == 404


def test_resolve_area_returns_boundary() -> None:
    app = _create_app()
    lookup_results = [
        {
            "display_name": "Waco, Texas, USA",
            "osm_id": 123,
            "osm_type": "relation",
            "type": "city",
            "class": "place",
            "address": {"city": "Waco", "state": "Texas"},
            "geojson": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [-97.3, 31.4],
                        [-97.1, 31.4],
                        [-97.1, 31.6],
                        [-97.3, 31.6],
                        [-97.3, 31.4],
                    ]
                ],
            },
            "boundingbox": ["31.4", "31.6", "-97.3", "-97.1"],
        }
    ]

    with patch(
        "street_coverage.api.areas.NominatimClient.lookup_raw",
        new=AsyncMock(return_value=lookup_results),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/resolve",
            json={"osm_id": 123, "osm_type": "relation"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidate"]["display_name"] == "Waco, Texas, USA"
    assert data["candidate"]["boundary"]["type"] == "Polygon"
    assert data["candidate"]["bounding_box"] == [-97.3, 31.4, -97.1, 31.6]


def test_resolve_area_rejects_invalid_geometry() -> None:
    app = _create_app()
    lookup_results = [
        {
            "display_name": "Invalid Area",
            "osm_id": 456,
            "osm_type": "relation",
            "geojson": {"type": "Point", "coordinates": [-97.1, 31.5]},
        }
    ]

    with patch(
        "street_coverage.api.areas.NominatimClient.lookup_raw",
        new=AsyncMock(return_value=lookup_results),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/resolve",
            json={"osm_id": 456, "osm_type": "relation"},
        )

    assert response.status_code == 400


def test_add_area_fails_fast_on_invalid_location() -> None:
    app = _create_app()

    with patch(
        "street_coverage.api.areas._fetch_boundary",
        new=AsyncMock(side_effect=ValueError("Location not found: Nowhere")),
    ), patch("street_coverage.api.areas.create_area", new=AsyncMock()) as create_area:
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas",
            json={"display_name": "Nowhere", "area_type": "city"},
        )

    assert response.status_code == 404
    assert create_area.call_count == 0
