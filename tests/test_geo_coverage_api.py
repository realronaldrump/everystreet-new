from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from geo_coverage.api import router as geo_coverage_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(geo_coverage_router)
    return app


def test_geo_coverage_topology_city_requires_state_fips() -> None:
    client = TestClient(_create_app())
    response = client.get("/api/geo-coverage/topology", params={"level": "city"})

    assert response.status_code == 400
    assert "stateFips is required" in response.json()["detail"]


def test_geo_coverage_summary_delegates_to_service() -> None:
    expected = {
        "success": True,
        "levels": {
            "county": {"visited": 1, "total": 10, "percent": 10.0, "stopped": 0},
            "state": {"visited": 1, "total": 50, "percent": 2.0},
            "city": {"visited": 1, "total": 100, "percent": 1.0},
        },
        "states": [],
    }

    with patch(
        "geo_coverage.api.GeoCoverageService.get_summary",
        new=AsyncMock(return_value=expected),
    ):
        client = TestClient(_create_app())
        response = client.get("/api/geo-coverage/summary")

    assert response.status_code == 200
    assert response.json() == expected


def test_geo_coverage_cities_forwards_query_params() -> None:
    payload = {
        "success": True,
        "stateFips": "48",
        "cities": [],
        "pagination": {"page": 2, "pageSize": 50, "total": 0, "totalPages": 0},
    }

    mock_list = AsyncMock(return_value=payload)

    with patch(
        "geo_coverage.api.GeoCoverageService.list_cities",
        new=mock_list,
    ):
        client = TestClient(_create_app())
        response = client.get(
            "/api/geo-coverage/cities",
            params={
                "stateFips": "48",
                "status": "visited",
                "q": "Aust",
                "sort": "last-visit-desc",
                "page": 2,
                "pageSize": 50,
            },
        )

    assert response.status_code == 200
    assert response.json() == payload

    mock_list.assert_awaited_once_with(
        state_fips="48",
        status_filter="visited",
        q="Aust",
        sort="last-visit-desc",
        page=2,
        page_size=50,
    )
