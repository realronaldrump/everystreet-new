from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from shapely.geometry import LineString, shape

from search.api import router as search_router
from search.services.search_service import SearchService


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(search_router)
    return app


def test_street_geometry_returns_line_feature() -> None:
    app = _create_app()
    lookup_results = [
        {
            "geojson": {
                "type": "LineString",
                "coordinates": [[-97.2, 31.4], [-97.1, 31.5]],
            },
        },
    ]

    with patch.object(
        SearchService._nominatim_client,
        "lookup_raw",
        new=AsyncMock(return_value=lookup_results),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/search/street-geometry",
            params={"osm_id": 123, "osm_type": "way"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["available"] is True
    assert data["clipped"] is False
    assert data["feature"]["geometry"]["type"] == "LineString"
    assert data["feature"]["properties"]["osm_id"] == 123
    assert data["feature"]["properties"]["osm_type"] == "way"


def test_street_geometry_clips_to_selected_area() -> None:
    app = _create_app()
    lookup_results = [
        {
            "geojson": {
                "type": "LineString",
                "coordinates": [[-2.0, 0.0], [2.0, 0.0]],
            },
        },
    ]
    area_boundary = {
        "type": "Polygon",
        "coordinates": [
            [
                [-1.0, -1.0],
                [1.0, -1.0],
                [1.0, 1.0],
                [-1.0, 1.0],
                [-1.0, -1.0],
            ],
        ],
    }

    with (
        patch.object(
            SearchService._nominatim_client,
            "lookup_raw",
            new=AsyncMock(return_value=lookup_results),
        ),
        patch(
            "search.services.search_service.CoverageArea.get",
            new=AsyncMock(return_value=SimpleNamespace(boundary=area_boundary)),
        ),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/search/street-geometry",
            params={
                "osm_id": 456,
                "osm_type": "way",
                "location_id": "507f1f77bcf86cd799439011",
                "clip_to_area": "true",
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["available"] is True
    assert data["clipped"] is True
    clipped_geometry = shape(data["feature"]["geometry"])
    assert clipped_geometry.equals_exact(
        LineString([(-1.0, 0.0), (1.0, 0.0)]),
        1e-9,
    )


def test_street_geometry_returns_unavailable_for_point_geometry() -> None:
    app = _create_app()
    lookup_results = [{"geojson": {"type": "Point", "coordinates": [-97.1, 31.5]}}]

    with patch.object(
        SearchService._nominatim_client,
        "lookup_raw",
        new=AsyncMock(return_value=lookup_results),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/search/street-geometry",
            params={"osm_id": 789, "osm_type": "node"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data == {"feature": None, "available": False, "clipped": False}


def test_street_geometry_returns_unavailable_when_lookup_fails() -> None:
    app = _create_app()

    with patch.object(
        SearchService._nominatim_client,
        "lookup_raw",
        new=AsyncMock(side_effect=RuntimeError("boom")),
    ):
        client = TestClient(app)
        response = client.get(
            "/api/search/street-geometry",
            params={"osm_id": 999, "osm_type": "way"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data == {"feature": None, "available": False, "clipped": False}
