"""Memory Atlas helpers for trip photo anchoring and postcard generation."""

from __future__ import annotations

import json
import logging
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from core.date_utils import parse_timestamp
from db.models import Trip
from google_photos.services.client import GooglePhotosClient

logger = logging.getLogger(__name__)

GENERATED_ROOT = Path("static/generated/memory_atlas")
THUMBNAIL_DIR = GENERATED_ROOT / "thumbnails"
POSTCARD_DIR = GENERATED_ROOT / "postcards"

_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_THUMB_SIZE = 640


def _ensure_generated_dirs() -> None:
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    POSTCARD_DIR.mkdir(parents=True, exist_ok=True)


def _safe_identifier(value: str) -> str:
    cleaned = _FILENAME_SAFE_RE.sub("_", str(value or "").strip())
    return cleaned.strip("_") or "item"


def _trip_value(trip: Any, key: str, default: Any = None) -> Any:
    if isinstance(trip, dict):
        return trip.get(key, default)
    return getattr(trip, key, default)


def storage_path_to_url(path: str | None) -> str | None:
    if not path:
        return None
    normalized = Path(path).as_posix()
    if normalized.startswith("static/"):
        return f"/{normalized}"
    if normalized.startswith("/static/"):
        return normalized
    return None


def delete_generated_file(path: str | None) -> None:
    if not path:
        return
    try:
        resolved = Path(path).resolve()
    except Exception:
        return
    root = GENERATED_ROOT.resolve()
    if root not in resolved.parents:
        return
    try:
        if resolved.exists() and resolved.is_file():
            resolved.unlink()
    except Exception:
        logger.warning("Unable to delete generated file: %s", resolved)


def _parse_geometry(raw: Any) -> dict[str, Any] | None:
    value = raw
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, dict):
        return None
    if value.get("type") == "Feature":
        value = value.get("geometry")
    if not isinstance(value, dict):
        return None
    if value.get("type") not in {"LineString", "Point"}:
        return None
    if "coordinates" not in value:
        return None
    return value


def extract_trip_coordinates(trip: Trip | dict[str, Any]) -> list[list[float]]:
    if isinstance(trip, Trip):
        candidates = [trip.matchedGps, trip.gps]
    else:
        candidates = [trip.get("matchedGps"), trip.get("gps"), trip.get("geometry")]

    for candidate in candidates:
        parsed = _parse_geometry(candidate)
        if not parsed:
            continue
        if parsed["type"] == "LineString":
            coords = parsed.get("coordinates") or []
            if isinstance(coords, list) and len(coords) >= 2:
                valid = [
                    [float(c[0]), float(c[1])]
                    for c in coords
                    if isinstance(c, list) and len(c) >= 2
                ]
                if len(valid) >= 2:
                    return valid
        if parsed["type"] == "Point":
            point = parsed.get("coordinates") or []
            if isinstance(point, list) and len(point) >= 2:
                lon, lat = float(point[0]), float(point[1])
                return [[lon, lat], [lon, lat]]
    return []


def _distance(a: list[float], b: list[float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _haversine_meters(
    lon1: float,
    lat1: float,
    lon2: float,
    lat2: float,
) -> float:
    radius = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(1e-12, 1.0 - a)))
    return radius * c


def nearest_distance_to_coords_meters(
    coords: list[list[float]],
    lon: float,
    lat: float,
) -> float | None:
    if len(coords) < 1:
        return None
    nearest = float("inf")
    for point in coords:
        if len(point) < 2:
            continue
        point_lon = float(point[0])
        point_lat = float(point[1])
        dist = _haversine_meters(lon, lat, point_lon, point_lat)
        nearest = min(nearest, dist)
    if nearest == float("inf"):
        return None
    return nearest


def _cumulative_lengths(coords: list[list[float]]) -> tuple[list[float], float]:
    lengths = [0.0]
    total = 0.0
    for i in range(1, len(coords)):
        total += _distance(coords[i - 1], coords[i])
        lengths.append(total)
    return lengths, total


def interpolate_trip_coordinate(
    coords: list[list[float]],
    fraction: float,
) -> tuple[float, float] | None:
    if len(coords) < 2:
        return None
    bounded = max(0.0, min(1.0, fraction))
    cumulative, total_length = _cumulative_lengths(coords)
    if total_length <= 0:
        first = coords[0]
        return first[0], first[1]

    target = total_length * bounded
    for idx in range(1, len(cumulative)):
        if cumulative[idx] < target:
            continue
        seg_start = cumulative[idx - 1]
        seg_len = cumulative[idx] - seg_start
        if seg_len <= 0:
            lon, lat = coords[idx]
            return lon, lat
        ratio = (target - seg_start) / seg_len
        start = coords[idx - 1]
        end = coords[idx]
        lon = start[0] + (end[0] - start[0]) * ratio
        lat = start[1] + (end[1] - start[1]) * ratio
        return lon, lat

    last = coords[-1]
    return last[0], last[1]


def nearest_fraction_for_coordinate(
    coords: list[list[float]],
    lon: float,
    lat: float,
) -> float | None:
    if len(coords) < 2:
        return None
    cumulative, total_length = _cumulative_lengths(coords)
    if total_length <= 0:
        return 0.0

    target_idx = 0
    target_dist = float("inf")
    for idx, point in enumerate(coords):
        dist = _distance(point, [lon, lat])
        if dist < target_dist:
            target_dist = dist
            target_idx = idx
    return max(0.0, min(1.0, cumulative[target_idx] / total_length))


def _trip_time_bounds(trip: Any) -> tuple[datetime | None, datetime | None]:
    return parse_timestamp(_trip_value(trip, "startTime")), parse_timestamp(
        _trip_value(trip, "endTime"),
    )


def select_best_trip_for_moment(
    *,
    trips: list[Trip],
    coordinates_by_trip_id: dict[str, list[list[float]]],
    capture_time: datetime | None,
    lat: float | None,
    lon: float | None,
    max_time_gap_seconds: int = 3 * 60 * 60,
    max_location_distance_meters: float = 1_500.0,
) -> dict[str, Any]:
    """
    Pick the best trip candidate for a photo moment.

    Strategy:
    1) If capture time is within a trip time window, prioritize that trip.
    2) Otherwise, use the nearest trip boundary within a configurable time gap.
    3) If no usable timestamp match exists, fall back to route proximity.
    """

    if not trips:
        return {
            "trip": None,
            "strategy": "no_trips",
            "confidence": 0.0,
            "time_delta_seconds": None,
            "distance_meters": None,
        }

    candidates: list[dict[str, Any]] = []
    has_location = lat is not None and lon is not None
    for trip in trips:
        trip_key = str(getattr(trip, "id", ""))
        coords = coordinates_by_trip_id.get(trip_key) or []
        distance_meters = (
            nearest_distance_to_coords_meters(coords, float(lon), float(lat))
            if has_location
            else None
        )

        start_time, end_time = _trip_time_bounds(trip)
        in_time_window = False
        time_delta_seconds: float | None = None
        if capture_time and start_time and end_time:
            if start_time <= capture_time <= end_time:
                in_time_window = True
                time_delta_seconds = 0.0
            else:
                time_delta_seconds = min(
                    abs((capture_time - start_time).total_seconds()),
                    abs((capture_time - end_time).total_seconds()),
                )

        candidates.append(
            {
                "trip": trip,
                "coords": coords,
                "distance_meters": distance_meters,
                "in_time_window": in_time_window,
                "time_delta_seconds": time_delta_seconds,
            },
        )

    window_matches = [entry for entry in candidates if entry["in_time_window"]]
    if window_matches:
        if has_location:
            with_location = [
                entry
                for entry in window_matches
                if entry["distance_meters"] is not None
            ]
            if with_location:
                best = min(with_location, key=lambda entry: float(entry["distance_meters"]))
                distance = float(best["distance_meters"])
                confidence = 0.95 if distance <= 300 else 0.88
                return {
                    "trip": best["trip"],
                    "strategy": "time_window_location",
                    "confidence": confidence,
                    "time_delta_seconds": 0.0,
                    "distance_meters": distance,
                }

        best = min(
            window_matches,
            key=lambda entry: (
                parse_timestamp(_trip_value(entry["trip"], "startTime"))
                or datetime.max.replace(tzinfo=UTC),
            ),
        )
        return {
            "trip": best["trip"],
            "strategy": "time_window",
            "confidence": 0.84,
            "time_delta_seconds": 0.0,
            "distance_meters": best["distance_meters"],
        }

    if capture_time:
        near_time = [
            entry
            for entry in candidates
            if entry["time_delta_seconds"] is not None
            and float(entry["time_delta_seconds"]) <= max_time_gap_seconds
        ]
        if near_time:
            best = min(
                near_time,
                key=lambda entry: (
                    float(entry["time_delta_seconds"]),
                    float(entry["distance_meters"])
                    if entry["distance_meters"] is not None
                    else float("inf"),
                ),
            )
            delta = float(best["time_delta_seconds"])
            normalized_gap = max(0.0, min(1.0, 1.0 - (delta / max_time_gap_seconds)))
            confidence = 0.45 + (normalized_gap * 0.28)
            return {
                "trip": best["trip"],
                "strategy": "nearest_trip_time",
                "confidence": confidence,
                "time_delta_seconds": delta,
                "distance_meters": best["distance_meters"],
            }

    if has_location:
        geo_candidates = [
            entry for entry in candidates if entry["distance_meters"] is not None
        ]
        if geo_candidates:
            best = min(geo_candidates, key=lambda entry: float(entry["distance_meters"]))
            distance = float(best["distance_meters"])
            if distance <= max_location_distance_meters:
                proximity = max(0.0, min(1.0, 1.0 - (distance / max_location_distance_meters)))
                confidence = 0.38 + (proximity * 0.32)
                return {
                    "trip": best["trip"],
                    "strategy": "nearest_route_location",
                    "confidence": confidence,
                    "time_delta_seconds": None,
                    "distance_meters": distance,
                }

    return {
        "trip": None,
        "strategy": "no_match",
        "confidence": 0.0,
        "time_delta_seconds": None,
        "distance_meters": None,
    }


def compute_moment_anchor(
    *,
    trip: Any,
    coordinates: list[list[float]],
    lat: float | None,
    lon: float | None,
    capture_time: datetime | None,
    fallback_fraction: float,
) -> dict[str, Any]:
    if lat is not None and lon is not None:
        fraction = nearest_fraction_for_coordinate(coordinates, lon, lat)
        return {
            "lat": lat,
            "lon": lon,
            "anchor_strategy": "exif_gps",
            "anchor_confidence": 0.95 if fraction is not None else 0.85,
            "anchor_fraction": fraction,
        }

    start_time, end_time = _trip_time_bounds(trip)
    if capture_time and start_time and end_time and end_time > start_time:
        total_seconds = (end_time - start_time).total_seconds()
        elapsed = (capture_time - start_time).total_seconds()
        if 0 <= elapsed <= total_seconds:
            fraction = elapsed / total_seconds if total_seconds else 0.0
            point = interpolate_trip_coordinate(coordinates, fraction)
            if point:
                lon_val, lat_val = point
                return {
                    "lat": lat_val,
                    "lon": lon_val,
                    "anchor_strategy": "timestamp_interp",
                    "anchor_confidence": 0.68,
                    "anchor_fraction": max(0.0, min(1.0, fraction)),
                }

    point = interpolate_trip_coordinate(coordinates, fallback_fraction)
    if point:
        lon_val, lat_val = point
        return {
            "lat": lat_val,
            "lon": lon_val,
            "anchor_strategy": "sequence_fallback",
            "anchor_confidence": 0.35,
            "anchor_fraction": max(0.0, min(1.0, fallback_fraction)),
        }

    return {
        "lat": None,
        "lon": None,
        "anchor_strategy": "manual_review",
        "anchor_confidence": 0.1,
        "anchor_fraction": None,
    }


def _thumbnail_extension(mime_type: str | None) -> str:
    mapping = {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/heic": ".heic",
    }
    return mapping.get((mime_type or "").lower(), ".jpg")


async def download_moment_thumbnail(
    *,
    session,
    trip_transaction_id: str,
    media_item_id: str,
    mime_type: str | None,
    base_url: str | None,
) -> str | None:
    if not base_url or not (mime_type or "").startswith("image/"):
        return None

    _ensure_generated_dirs()
    extension = _thumbnail_extension(mime_type)
    filename = (
        f"{_safe_identifier(trip_transaction_id)}_"
        f"{_safe_identifier(media_item_id)}{extension}"
    )
    output_path = THUMBNAIL_DIR / filename

    data = await GooglePhotosClient.download_thumbnail(
        session,
        base_url,
        width=_MAX_THUMB_SIZE,
        height=_MAX_THUMB_SIZE,
    )
    output_path.write_bytes(data)
    return output_path.as_posix()


def _draw_route_preview(
    draw,
    *,
    coords: list[list[float]],
    anchors: list[tuple[float, float]],
    bounds: tuple[int, int, int, int],
) -> None:
    x0, y0, x1, y1 = bounds
    draw.rectangle(bounds, fill=(245, 243, 237), outline=(203, 197, 184), width=2)
    if len(coords) < 2:
        return

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    if max_lon - min_lon < 1e-9:
        max_lon += 1e-9
    if max_lat - min_lat < 1e-9:
        max_lat += 1e-9

    def project(lon: float, lat: float) -> tuple[float, float]:
        x = x0 + ((lon - min_lon) / (max_lon - min_lon)) * (x1 - x0)
        y = y1 - ((lat - min_lat) / (max_lat - min_lat)) * (y1 - y0)
        return x, y

    points = [project(lon, lat) for lon, lat in coords]
    draw.line(points, fill=(72, 119, 164), width=5, joint="curve")
    start_x, start_y = points[0]
    end_x, end_y = points[-1]
    draw.ellipse((start_x - 7, start_y - 7, start_x + 7, start_y + 7), fill=(36, 170, 102))
    draw.ellipse((end_x - 7, end_y - 7, end_x + 7, end_y + 7), fill=(196, 80, 80))

    for lon, lat in anchors:
        px, py = project(lon, lat)
        draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=(44, 44, 54))


def _load_thumbnail(path: str, *, size: tuple[int, int]):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None

    try:
        image = Image.open(path).convert("RGB")
    except Exception:
        return None
    return ImageOps.fit(image, size, method=Image.Resampling.LANCZOS)


def _build_svg_postcard(
    *,
    trip: Any,
    moments: list[dict[str, Any]],
) -> str:
    _ensure_generated_dirs()
    file_name = (
        f"{_safe_identifier(_trip_value(trip, 'transactionId') or 'trip')}_"
        f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.svg"
    )
    output_path = POSTCARD_DIR / file_name
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900">
<rect width="1400" height="900" fill="#f9f6ee"/>
<rect width="1400" height="126" fill="#354b67"/>
<text x="40" y="54" font-size="28" fill="#ffffff">EveryStreet Route Memory Atlas</text>
<text x="40" y="94" font-size="20" fill="#dbe7f5">Trip {_trip_value(trip, "transactionId")}</text>
<rect x="50" y="160" width="880" height="680" fill="#f5f3ed" stroke="#cbc5b8" stroke-width="2"/>
<text x="980" y="180" font-size="24" fill="#383840">Moments: {len(moments)}</text>
<text x="980" y="220" font-size="18" fill="#383840">Pillow not installed - SVG fallback</text>
</svg>"""
    output_path.write_text(svg, encoding="utf-8")
    return output_path.as_posix()


def build_postcard_image(
    *,
    trip: Any,
    moments: list[dict[str, Any]],
) -> str:
    """Render a postcard image and return the file storage path."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        logger.warning("Pillow is unavailable; generating SVG postcard fallback")
        return _build_svg_postcard(trip=trip, moments=moments)

    _ensure_generated_dirs()
    width, height = 1400, 900
    image = Image.new("RGB", (width, height), (249, 246, 238))
    draw = ImageDraw.Draw(image)

    draw.rectangle((0, 0, width, 126), fill=(53, 75, 103))
    draw.text((40, 28), "EveryStreet Route Memory Atlas", fill=(255, 255, 255))
    draw.text(
        (40, 64),
        f"Trip {_trip_value(trip, 'transactionId', '--')}",
        fill=(224, 234, 246),
    )

    trip_start = parse_timestamp(_trip_value(trip, "startTime"))
    trip_end = parse_timestamp(_trip_value(trip, "endTime"))
    duration_text = "--"
    if trip_start and trip_end:
        total_minutes = int((trip_end - trip_start).total_seconds() // 60)
        duration_text = f"{total_minutes} min"

    distance = _trip_value(trip, "distance")
    distance_text = (
        f"{float(distance):.2f} mi" if distance is not None else "--"
    )
    draw.text((980, 170), f"Distance: {distance_text}", fill=(56, 56, 64))
    draw.text((980, 210), f"Duration: {duration_text}", fill=(56, 56, 64))
    draw.text((980, 250), f"Moments: {len(moments)}", fill=(56, 56, 64))

    coords = extract_trip_coordinates(trip)
    anchors = [
        (float(moment["lon"]), float(moment["lat"]))
        for moment in moments
        if moment.get("lon") is not None and moment.get("lat") is not None
    ]
    _draw_route_preview(
        draw,
        coords=coords,
        anchors=anchors,
        bounds=(50, 160, 930, 840),
    )

    thumb_size = (190, 190)
    thumb_x = [980, 1185]
    thumb_y = [340, 545]
    slots = [(x, y) for y in thumb_y for x in thumb_x]

    for idx, slot in enumerate(slots):
        x, y = slot
        draw.rectangle((x, y, x + thumb_size[0], y + thumb_size[1]), fill=(232, 226, 216))
        if idx >= len(moments):
            draw.text((x + 20, y + 84), "No photo", fill=(130, 122, 112))
            continue

        thumb_path = moments[idx].get("thumbnail_path")
        thumb = _load_thumbnail(str(thumb_path), size=thumb_size) if thumb_path else None
        if thumb is None:
            draw.text((x + 22, y + 70), "Thumbnail", fill=(130, 122, 112))
            draw.text((x + 22, y + 92), "unavailable", fill=(130, 122, 112))
            continue
        image.paste(thumb, (x, y))

    file_name = (
        f"{_safe_identifier(_trip_value(trip, 'transactionId') or 'trip')}_"
        f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.png"
    )
    output_path = POSTCARD_DIR / file_name
    image.save(output_path, format="PNG")
    return output_path.as_posix()
