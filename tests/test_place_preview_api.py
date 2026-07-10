from datetime import UTC, datetime

import pytest
from db_helpers import init_mock_beanie
from fastapi import FastAPI
from fastapi.testclient import TestClient

from db.models import Place, PlacePreviewImage, PlacePreviewThemeImage
from visits.api import places as places_api
from visits.services.place_preview_service import PlacePreviewService


@pytest.fixture
async def place_preview_api_db():
    return await init_mock_beanie(Place, PlacePreviewImage)


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(places_api.router)
    return app


def _polygon(offset: float = 0.0) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [-97.744 + offset, 30.267],
                [-97.742 + offset, 30.267],
                [-97.742 + offset, 30.269],
                [-97.744 + offset, 30.269],
                [-97.744 + offset, 30.267],
            ],
        ],
    }


@pytest.mark.asyncio
async def test_get_place_preview_image_returns_cached_png(
    place_preview_api_db,
) -> None:
    del place_preview_api_db
    place = Place(name="Coffee Shop", geometry=_polygon(), created_at=datetime.now(UTC))
    await place.insert()
    hash_value = PlacePreviewService.geometry_hash(place.geometry)
    bounds = PlacePreviewService.preview_bounds(place.geometry)
    assert hash_value is not None
    assert bounds is not None

    await PlacePreviewImage(
        place_id=str(place.id),
        geometry_hash=hash_value,
        bounds=bounds,
        images={
            "dark": PlacePreviewThemeImage(
                content_type="image/png",
                image_bytes=b"\x89PNG\r\ndark-preview",
                generated_at=datetime.now(UTC),
            ),
            "light": PlacePreviewThemeImage(
                content_type="image/png",
                image_bytes=b"\x89PNG\r\nlight-preview",
                generated_at=datetime.now(UTC),
            ),
        },
    ).insert()

    client = TestClient(_build_app())
    response = client.get(f"/api/places/{place.id}/preview.png?v={hash_value}")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.content == b"\x89PNG\r\ndark-preview"

    light_response = client.get(
        f"/api/places/{place.id}/preview.png?theme=light&v={hash_value}"
    )
    assert light_response.status_code == 200
    assert light_response.content == b"\x89PNG\r\nlight-preview"


@pytest.mark.asyncio
async def test_get_place_preview_image_returns_404_for_stale_hash(
    place_preview_api_db,
) -> None:
    del place_preview_api_db
    place = Place(name="Coffee Shop", geometry=_polygon(), created_at=datetime.now(UTC))
    await place.insert()
    hash_value = PlacePreviewService.geometry_hash(place.geometry)
    bounds = PlacePreviewService.preview_bounds(place.geometry)
    assert hash_value is not None
    assert bounds is not None

    await PlacePreviewImage(
        place_id=str(place.id),
        geometry_hash=hash_value,
        bounds=bounds,
        images={
            "dark": PlacePreviewThemeImage(
                content_type="image/png",
                image_bytes=b"\x89PNG\r\npreview",
                generated_at=datetime.now(UTC),
            ),
        },
    ).insert()

    client = TestClient(_build_app())
    response = client.get(f"/api/places/{place.id}/preview.png?v=stale")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_place_preview_image_returns_404_when_missing(
    place_preview_api_db,
) -> None:
    del place_preview_api_db
    client = TestClient(_build_app())

    response = client.get("/api/places/missing-preview/preview.png?v=abc")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_backfill_place_previews_counts_generated_skipped_and_failed(
    monkeypatch: pytest.MonkeyPatch,
    place_preview_api_db,
) -> None:
    del place_preview_api_db
    generated_place = Place(
        name="Generated",
        geometry=_polygon(),
        created_at=datetime.now(UTC),
    )
    skipped_place = Place(
        name="Skipped",
        geometry=_polygon(0.01),
        created_at=datetime.now(UTC),
    )
    failed_place = Place(
        name="Failed",
        geometry={"type": "Polygon", "coordinates": []},
        created_at=datetime.now(UTC),
    )
    await generated_place.insert()
    await skipped_place.insert()
    await failed_place.insert()

    skipped_hash = PlacePreviewService.geometry_hash(skipped_place.geometry)
    skipped_bounds = PlacePreviewService.preview_bounds(skipped_place.geometry)
    assert skipped_hash is not None
    assert skipped_bounds is not None
    await PlacePreviewImage(
        place_id=str(skipped_place.id),
        geometry_hash=skipped_hash,
        bounds=skipped_bounds,
        images={
            "dark": PlacePreviewThemeImage(
                content_type="image/png",
                image_bytes=b"already-current-dark",
                generated_at=datetime.now(UTC),
            ),
            "light": PlacePreviewThemeImage(
                content_type="image/png",
                image_bytes=b"already-current-light",
                generated_at=datetime.now(UTC),
            ),
        },
    ).insert()

    async def fake_fetch_static_map_image(
        _bounds: list[float],
        theme: str | None = None,
    ) -> tuple[bytes, str]:
        normalized_theme = PlacePreviewService.normalize_theme(theme)
        return f"generated-{normalized_theme}-preview".encode(), "image/png"

    monkeypatch.setattr(
        PlacePreviewService,
        "fetch_static_map_image",
        staticmethod(fake_fetch_static_map_image),
    )

    client = TestClient(_build_app())
    response = client.post("/api/places/previews/backfill")

    assert response.status_code == 200
    assert response.json() == {
        "processed": 3,
        "generated": 1,
        "skipped": 1,
        "failed": 1,
    }

    generated_preview = await PlacePreviewService.get_preview(str(generated_place.id))
    assert generated_preview is not None
    assert bytes(generated_preview.images["dark"].image_bytes) == (
        b"generated-dark-preview"
    )
    assert bytes(generated_preview.images["light"].image_bytes) == (
        b"generated-light-preview"
    )
