from datetime import UTC, datetime

import pytest
from db_helpers import init_mock_beanie

from db.models import Place, PlacePreviewImage
from visits.services.place_preview_service import (
    PREVIEW_HEIGHT,
    PREVIEW_WIDTH,
    PlacePreviewService,
    geometry_hash,
    preview_bounds,
)
from visits.services.place_service import PlaceService


@pytest.fixture
async def place_preview_db():
    return await init_mock_beanie(Place, PlacePreviewImage)


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


def test_geometry_hash_is_stable_for_key_order_and_float_noise() -> None:
    geometry_a = {
        "type": "Polygon",
        "coordinates": [
            [
                [-97.7440000001, 30.2670000001],
                [-97.742, 30.267],
                [-97.742, 30.269],
                [-97.7440000001, 30.269],
                [-97.7440000001, 30.2670000001],
            ],
        ],
    }
    geometry_b = {
        "coordinates": [
            [
                [-97.744, 30.267],
                [-97.742, 30.267],
                [-97.742, 30.269],
                [-97.744, 30.269],
                [-97.744, 30.267],
            ],
        ],
        "type": "Polygon",
    }

    assert geometry_hash(geometry_a) == geometry_hash(geometry_b)


def test_preview_bounds_pad_and_match_preview_aspect_ratio() -> None:
    bounds = preview_bounds(_polygon())

    assert bounds is not None
    min_lng, min_lat, max_lng, max_lat = bounds
    assert min_lng < -97.744
    assert max_lng > -97.742
    assert min_lat < 30.267
    assert max_lat > 30.269
    assert ((max_lng - min_lng) / (max_lat - min_lat)) == pytest.approx(
        PREVIEW_WIDTH / PREVIEW_HEIGHT,
        rel=0.01,
    )


@pytest.mark.asyncio
async def test_generate_preview_creates_skips_and_forces_regeneration(
    monkeypatch: pytest.MonkeyPatch,
    place_preview_db,
) -> None:
    del place_preview_db
    calls: list[list[float]] = []

    async def fake_fetch_static_map_image(bounds: list[float]) -> tuple[bytes, str]:
        calls.append(bounds)
        return f"preview-{len(calls)}".encode(), "image/png"

    monkeypatch.setattr(
        PlacePreviewService,
        "fetch_static_map_image",
        staticmethod(fake_fetch_static_map_image),
    )

    place = Place(
        name="Coffee Shop",
        geometry=_polygon(),
        created_at=datetime.now(UTC),
    )
    await place.insert()

    first = await PlacePreviewService.generate_or_refresh_preview(place)
    assert first.status == "generated"
    assert len(calls) == 1

    preview = await PlacePreviewService.get_preview(str(place.id))
    assert preview is not None
    assert bytes(preview.image_bytes) == b"preview-1"
    assert preview.geometry_hash == geometry_hash(place.geometry)

    second = await PlacePreviewService.generate_or_refresh_preview(place)
    assert second.status == "skipped"
    assert len(calls) == 1

    third = await PlacePreviewService.generate_or_refresh_preview(place, force=True)
    assert third.status == "generated"
    assert len(calls) == 2

    refreshed = await PlacePreviewService.get_preview(str(place.id))
    assert refreshed is not None
    assert bytes(refreshed.image_bytes) == b"preview-2"


@pytest.mark.asyncio
async def test_place_create_succeeds_when_preview_generation_fails(
    monkeypatch: pytest.MonkeyPatch,
    place_preview_db,
) -> None:
    del place_preview_db

    async def failing_fetch_static_map_image(_bounds: list[float]) -> tuple[bytes, str]:
        raise RuntimeError("map provider unavailable")

    monkeypatch.setattr(
        PlacePreviewService,
        "fetch_static_map_image",
        staticmethod(failing_fetch_static_map_image),
    )

    response = await PlaceService.create_place("Coffee Shop", _polygon())

    assert response.name == "Coffee Shop"
    assert response.previewImageUrl is None
    assert await Place.get(response.id) is not None
    assert await PlacePreviewService.get_preview(response.id) is None
