"""Static map preview generation for visit places."""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite
from typing import Any, Literal
from urllib.parse import quote

import httpx

from config import require_mapbox_token
from db.models import Place, PlacePreviewImage, PlacePreviewThemeImage

logger = logging.getLogger(__name__)

MAPBOX_STATIC_BASE_URL = "https://api.mapbox.com/styles/v1/mapbox/{style_id}/static"
PREVIEW_THEME_STYLES = {
    "dark": "dark-v11",
    "light": "light-v11",
}
DEFAULT_PREVIEW_THEME = "dark"
PREVIEW_WIDTH = 640
PREVIEW_HEIGHT = 360
PREVIEW_PIXEL_RATIO = "@2x"
MIN_BOUND_SPAN = 0.0025
BOUND_PADDING_RATIO = 0.18
MAX_MERCATOR_LAT = 85.0511
STATIC_MAP_TIMEOUT_SECONDS = 20.0

PreviewTheme = Literal["dark", "light"]
PreviewStatus = Literal["generated", "skipped", "failed"]
SUPPORTED_PREVIEW_THEMES: tuple[PreviewTheme, ...] = ("dark", "light")


@dataclass(slots=True)
class PreviewGenerationResult:
    """Result for one preview generation attempt."""

    status: PreviewStatus
    error: str | None = None


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, int | float) and isfinite(float(value))


def _collect_coordinates(geometry: Any) -> list[tuple[float, float]]:
    if not isinstance(geometry, dict):
        return []

    geometry_type = geometry.get("type")
    if geometry_type == "Feature":
        return _collect_coordinates(geometry.get("geometry"))
    if geometry_type == "FeatureCollection":
        features = geometry.get("features")
        if not isinstance(features, list):
            return []
        coords: list[tuple[float, float]] = []
        for feature in features:
            coords.extend(_collect_coordinates(feature))
        return coords
    if geometry_type == "GeometryCollection":
        geometries = geometry.get("geometries")
        if not isinstance(geometries, list):
            return []
        coords = []
        for item in geometries:
            coords.extend(_collect_coordinates(item))
        return coords

    coordinates = geometry.get("coordinates")

    def walk(value: Any) -> list[tuple[float, float]]:
        if (
            isinstance(value, list)
            and len(value) >= 2
            and _is_finite_number(value[0])
            and _is_finite_number(value[1])
        ):
            return [(float(value[0]), float(value[1]))]
        if isinstance(value, list):
            coords: list[tuple[float, float]] = []
            for item in value:
                coords.extend(walk(item))
            return coords
        return []

    return walk(coordinates)


def _normalize_for_hash(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _normalize_for_hash(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, list | tuple):
        return [_normalize_for_hash(item) for item in value]
    if isinstance(value, float):
        return round(value, 7)
    return value


def geometry_hash(geometry: dict[str, Any] | None) -> str | None:
    """Return a stable hash for a GeoJSON geometry."""
    if not isinstance(geometry, dict):
        return None

    encoded = json.dumps(
        _normalize_for_hash(geometry),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def normalize_preview_theme(theme: str | None) -> PreviewTheme:
    """Return a supported preview theme."""
    return "light" if theme == "light" else DEFAULT_PREVIEW_THEME


def _clamp_lng(value: float) -> float:
    return max(-180.0, min(180.0, value))


def _clamp_lat(value: float) -> float:
    return max(-MAX_MERCATOR_LAT, min(MAX_MERCATOR_LAT, value))


def preview_bounds(geometry: dict[str, Any] | None) -> list[float] | None:
    """Return padded Mapbox bbox bounds as [minLng, minLat, maxLng, maxLat]."""
    coords = _collect_coordinates(geometry)
    if not coords:
        return None

    lng_values = [lng for lng, _lat in coords]
    lat_values = [lat for _lng, lat in coords]
    min_lng = min(lng_values)
    max_lng = max(lng_values)
    min_lat = min(lat_values)
    max_lat = max(lat_values)

    lng_span = max_lng - min_lng
    lat_span = max_lat - min_lat
    if not isfinite(lng_span) or not isfinite(lat_span):
        return None

    if lng_span < MIN_BOUND_SPAN:
        delta = (MIN_BOUND_SPAN - lng_span) / 2
        min_lng -= delta
        max_lng += delta
    if lat_span < MIN_BOUND_SPAN:
        delta = (MIN_BOUND_SPAN - lat_span) / 2
        min_lat -= delta
        max_lat += delta

    lng_pad = (max_lng - min_lng) * BOUND_PADDING_RATIO
    lat_pad = (max_lat - min_lat) * BOUND_PADDING_RATIO
    min_lng -= lng_pad
    max_lng += lng_pad
    min_lat -= lat_pad
    max_lat += lat_pad

    target_ratio = PREVIEW_WIDTH / PREVIEW_HEIGHT
    lng_span = max_lng - min_lng
    lat_span = max_lat - min_lat
    if lat_span > 0 and lng_span / lat_span < target_ratio:
        expanded_lng_span = lat_span * target_ratio
        delta = (expanded_lng_span - lng_span) / 2
        min_lng -= delta
        max_lng += delta
    elif lng_span > 0 and lng_span / max(lat_span, MIN_BOUND_SPAN) > target_ratio:
        expanded_lat_span = lng_span / target_ratio
        delta = (expanded_lat_span - lat_span) / 2
        min_lat -= delta
        max_lat += delta

    return [
        round(_clamp_lng(min_lng), 7),
        round(_clamp_lat(min_lat), 7),
        round(_clamp_lng(max_lng), 7),
        round(_clamp_lat(max_lat), 7),
    ]


def _build_static_map_url(bounds: list[float], theme: str | None = None) -> str:
    normalized_theme = normalize_preview_theme(theme)
    style_id = PREVIEW_THEME_STYLES[normalized_theme]
    bbox = ",".join(f"{value:.7f}".rstrip("0").rstrip(".") for value in bounds)
    bbox_path = quote(f"[{bbox}]", safe=",")
    token = quote(require_mapbox_token(), safe="")
    return (
        f"{MAPBOX_STATIC_BASE_URL.format(style_id=style_id)}/{bbox_path}/"
        f"{PREVIEW_WIDTH}x{PREVIEW_HEIGHT}{PREVIEW_PIXEL_RATIO}"
        f"?access_token={token}"
    )


class PlacePreviewService:
    """Generate and read cached static map previews for custom places."""

    @staticmethod
    def geometry_hash(geometry: dict[str, Any] | None) -> str | None:
        return geometry_hash(geometry)

    @staticmethod
    def preview_bounds(geometry: dict[str, Any] | None) -> list[float] | None:
        return preview_bounds(geometry)

    @staticmethod
    def normalize_theme(theme: str | None) -> PreviewTheme:
        return normalize_preview_theme(theme)

    @staticmethod
    def preview_themes() -> tuple[PreviewTheme, ...]:
        return SUPPORTED_PREVIEW_THEMES

    @staticmethod
    def preview_image_url(
        place_id: str,
        geometry_hash_value: str,
        theme: str | None = None,
    ) -> str:
        normalized_theme = normalize_preview_theme(theme)
        return (
            f"/api/places/{quote(str(place_id), safe='')}/preview.png"
            f"?theme={quote(normalized_theme, safe='')}"
            f"&v={quote(geometry_hash_value, safe='')}"
        )

    @staticmethod
    def get_theme_image(
        preview: PlacePreviewImage | None,
        theme: str | None,
    ) -> PlacePreviewThemeImage | None:
        if preview is None:
            return None
        return preview.images.get(normalize_preview_theme(theme))

    @staticmethod
    async def fetch_static_map_image(
        bounds: list[float],
        theme: str | None = None,
    ) -> tuple[bytes, str]:
        """Fetch a static map image from Mapbox for the supplied bbox."""
        url = _build_static_map_url(bounds, theme)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(STATIC_MAP_TIMEOUT_SECONDS)
        ) as client:
            response = await client.get(url)
        response.raise_for_status()

        content_type = response.headers.get("content-type", "image/png").split(";")[0]
        if not content_type.startswith("image/"):
            msg = f"Unexpected Mapbox static image content type: {content_type}"
            raise RuntimeError(msg)
        return response.content, content_type

    @staticmethod
    async def get_preview(place_id: str) -> PlacePreviewImage | None:
        return await PlacePreviewImage.find_one(PlacePreviewImage.place_id == place_id)

    @staticmethod
    async def get_previews_for_places(
        place_ids: list[str],
    ) -> dict[str, PlacePreviewImage]:
        if not place_ids:
            return {}
        previews = await PlacePreviewImage.find(
            {"place_id": {"$in": list(dict.fromkeys(place_ids))}}
        ).to_list()
        return {preview.place_id: preview for preview in previews}

    @staticmethod
    async def delete_preview(place_id: str) -> None:
        preview = await PlacePreviewService.get_preview(place_id)
        if preview is not None:
            await preview.delete()

    @staticmethod
    async def generate_or_refresh_preview(
        place: Place,
        *,
        force: bool = False,
        themes: tuple[PreviewTheme, ...] = SUPPORTED_PREVIEW_THEMES,
    ) -> PreviewGenerationResult:
        place_id = str(place.id)
        hash_value = geometry_hash(place.geometry)
        bounds = preview_bounds(place.geometry)
        if not hash_value or not bounds:
            return PreviewGenerationResult(
                status="failed",
                error="Place geometry cannot produce preview bounds",
            )

        requested_themes = tuple(
            dict.fromkeys(normalize_preview_theme(t) for t in themes)
        )
        existing = await PlacePreviewService.get_preview(place_id)
        if (
            existing is not None
            and existing.geometry_hash == hash_value
            and existing.bounds == bounds
            and all(existing.images.get(theme) for theme in requested_themes)
            and not force
        ):
            return PreviewGenerationResult(status="skipped")

        images = (
            dict(existing.images)
            if existing is not None
            and existing.geometry_hash == hash_value
            and existing.bounds == bounds
            else {}
        )
        now = datetime.now(UTC)
        for theme in requested_themes:
            if theme in images and not force:
                continue
            (
                image_bytes,
                content_type,
            ) = await PlacePreviewService.fetch_static_map_image(
                bounds,
                theme,
            )
            images[theme] = PlacePreviewThemeImage(
                content_type=content_type,
                image_bytes=image_bytes,
                generated_at=now,
            )

        if existing is None:
            preview = PlacePreviewImage(
                place_id=place_id,
                geometry_hash=hash_value,
                bounds=bounds,
                images=images,
            )
            await preview.insert()
        else:
            existing.geometry_hash = hash_value
            existing.bounds = bounds
            existing.images = images
            await existing.save()

        return PreviewGenerationResult(status="generated")


async def generate_preview_best_effort(place: Place) -> None:
    """Generate a preview without failing the caller's place mutation."""
    try:
        await PlacePreviewService.generate_or_refresh_preview(place)
    except Exception:
        logger.exception("Failed to generate preview for place %s", place.id)
