from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from street_coverage.api import router as coverage_router


def _create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(coverage_router)
    return app


def _mock_geocoder(
    *,
    search_results: list[dict] | None = None,
    lookup_results: list[dict] | None = None,
) -> AsyncMock:
    geocoder = AsyncMock()
    geocoder.search_raw = AsyncMock(return_value=search_results or [])
    geocoder.lookup_raw = AsyncMock(return_value=lookup_results or [])
    return geocoder


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
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
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


def test_validate_area_accepts_string_provider_id() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Waco, TX, USA",
            "osm_id": "ChIJs9KSYYBfaIYRj5AOiZNQ0a4",
            "osm_type": "google_place",
            "type": "locality",
            "class": "place",
            "address": {"city": "Waco", "state": "Texas"},
            "importance": 0.8,
            "boundingbox": ["31.4", "31.6", "-97.3", "-97.1"],
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Waco, TX", "area_type": "city", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["osm_id"] == "ChIJs9KSYYBfaIYRj5AOiZNQ0a4"
    assert data["candidates"][0]["osm_type"] == "google_place"


def test_validate_area_city_family_matches_boundary_administrative() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Waco, McLennan County, Texas, USA",
            "osm_id": 901,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "city",
            "class": "boundary",
            "address": {"city": "Waco", "county": "McLennan County", "state": "Texas"},
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Waco", "area_type": "city", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["type_match"] is True


def test_validate_area_county_family_matches_address_county() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "McLennan County, Texas, USA",
            "osm_id": 902,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "county",
            "class": "boundary",
            "address": {"county": "McLennan County", "state": "Texas"},
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "McLennan County", "area_type": "county", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["type_match"] is True


def test_validate_area_state_family_matches_address_state() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Texas, USA",
            "osm_id": 903,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "state",
            "class": "boundary",
            "address": {"state": "Texas"},
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Texas", "area_type": "state", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["type_match"] is True


def test_validate_area_city_family_rejects_state_level_result() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Texas, USA",
            "osm_id": 904,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "state",
            "class": "boundary",
            "address": {"state": "Texas"},
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Texas", "area_type": "city", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidates"][0]["type_match"] is False


def test_validate_area_sets_note_when_all_candidates_mismatch() -> None:
    app = _create_app()
    search_results = [
        {
            "display_name": "Texas, USA",
            "osm_id": 905,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "state",
            "class": "boundary",
            "address": {"state": "Texas"},
        },
        {
            "display_name": "McLennan County, Texas, USA",
            "osm_id": 906,
            "osm_type": "relation",
            "type": "administrative",
            "addresstype": "county",
            "class": "boundary",
            "address": {"county": "McLennan County", "state": "Texas"},
        },
    ]
    geocoder = _mock_geocoder(search_results=search_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/validate",
            json={"location": "Texas", "area_type": "city", "limit": 5},
        )

    assert response.status_code == 200
    data = response.json()
    assert all(candidate["type_match"] is False for candidate in data["candidates"])
    assert data["note"] is not None
    assert "No matches for the selected area type." in data["note"]


def test_validate_area_returns_404_on_no_match() -> None:
    app = _create_app()
    geocoder = _mock_geocoder(search_results=[])

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
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
                    ],
                ],
            },
            "boundingbox": ["31.4", "31.6", "-97.3", "-97.1"],
        },
    ]
    geocoder = _mock_geocoder(lookup_results=lookup_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
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


def test_resolve_area_returns_string_provider_id() -> None:
    app = _create_app()
    lookup_results = [
        {
            "display_name": "Waco, TX, USA",
            "osm_id": "ChIJs9KSYYBfaIYRj5AOiZNQ0a4",
            "osm_type": "google_place",
            "type": "locality",
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
                    ],
                ],
            },
            "boundingbox": ["31.4", "31.6", "-97.3", "-97.1"],
        },
    ]
    geocoder = _mock_geocoder(lookup_results=lookup_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/resolve",
            json={"osm_id": "ChIJs9KSYYBfaIYRj5AOiZNQ0a4", "osm_type": "google_place"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidate"]["osm_id"] == "ChIJs9KSYYBfaIYRj5AOiZNQ0a4"
    assert data["candidate"]["osm_type"] == "google_place"


def test_resolve_area_rejects_invalid_geometry() -> None:
    app = _create_app()
    lookup_results = [
        {
            "display_name": "Invalid Area",
            "osm_id": 456,
            "osm_type": "relation",
            "geojson": {"type": "Point", "coordinates": [-97.1, 31.5]},
        },
    ]
    geocoder = _mock_geocoder(lookup_results=lookup_results)

    with patch(
        "street_coverage.api.areas.get_geocoder",
        new=AsyncMock(return_value=geocoder),
    ), patch(
        "street_coverage.api.areas._fetch_boundary",
        new=AsyncMock(side_effect=ValueError("No boundary polygon for: Invalid Area")),
    ), patch(
        "street_coverage.ingestion._try_overpass_boundary",
        new=AsyncMock(return_value=None),
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/resolve",
            json={"osm_id": 456, "osm_type": "relation"},
        )

    assert response.status_code == 400
    # With bounding-box fallback the Point is discarded and treated as missing
    assert "No boundary polygon" in response.json()["detail"]


def test_resolve_area_falls_back_when_lookup_returns_point() -> None:
    app = _create_app()
    lookup_results = [
        {
            "display_name": "Corpus Christi, 78404, United States",
            "osm_id": 789,
            "osm_type": "node",
            "type": "postcode",
            "class": "place",
            "address": {"city": "Corpus Christi", "state": "Texas"},
            "geojson": {"type": "Point", "coordinates": [-97.401, 27.76]},
            "boundingbox": ["27.76", "27.76", "-97.401", "-97.401"],
        },
    ]
    geocoder = _mock_geocoder(lookup_results=lookup_results)
    fallback_boundary = {
        "type": "Polygon",
        "coordinates": [
            [
                [-97.6, 27.7],
                [-97.2, 27.7],
                [-97.2, 27.9],
                [-97.6, 27.9],
                [-97.6, 27.7],
            ],
        ],
    }

    with (
        patch(
            "street_coverage.api.areas.get_geocoder",
            new=AsyncMock(return_value=geocoder),
        ),
        patch(
            "street_coverage.api.areas._fetch_boundary",
            new=AsyncMock(return_value=fallback_boundary),
        ) as fetch_boundary,
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas/resolve",
            json={"osm_id": 789, "osm_type": "node"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["candidate"]["boundary"] == fallback_boundary
    assert data["candidate"]["bounding_box"] == [-97.6, 27.7, -97.2, 27.9]
    fetch_boundary.assert_awaited_once_with("Corpus Christi, 78404, United States")


def test_add_area_fails_fast_on_invalid_location() -> None:
    app = _create_app()

    with (
        patch(
            "street_coverage.api.areas._fetch_boundary",
            new=AsyncMock(side_effect=ValueError("Location not found: Nowhere")),
        ),
        patch("street_coverage.api.areas.create_area", new=AsyncMock()) as create_area,
    ):
        client = TestClient(app)
        response = client.post(
            "/api/coverage/areas",
            json={"display_name": "Nowhere", "area_type": "city"},
        )

    assert response.status_code == 404
    assert create_area.call_count == 0
