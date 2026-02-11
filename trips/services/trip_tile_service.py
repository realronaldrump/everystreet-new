"""Trip vector tile builder service.

This service generates gzipped Mapbox Vector Tiles (MVT) for trip geometries.

Design goals:
- Fast overview rendering via tiles (only load what's in view)
- No loss of *authoritative* accuracy: exact geometry is still fetched by id
  for selection/inspection elsewhere in the app.
"""

from __future__ import annotations

import contextlib
import gzip
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import mapbox_vector_tile
import pyproj
from shapely.geometry import box, shape
from shapely.ops import transform as shapely_transform

from core.redis_cache import cache_get, cache_incr, cache_set
from core.tiles import (
    DEFAULT_BUFFER,
    DEFAULT_EXTENT,
    buffer_meters,
    tile_bounds_3857,
    tile_bounds_wgs84,
)
from db.models import Trip
from db.query import build_calendar_date_expr, parse_query_date
from trips.models import TripTileProjection

logger = logging.getLogger(__name__)

EXTENT: Final[int] = DEFAULT_EXTENT
BUFFER: Final[int] = DEFAULT_BUFFER

MAX_FEATURES_PER_TILE: Final[int] = 10000
MAX_VERTICES_PER_FEATURE: Final[int] = 2000

TRIP_TILES_VERSION_KEY: Final[str] = "trip_tiles_version"

# Small in-process cache to avoid a Redis hit per tile.
_version_cache_value: str | None = None
_version_cache_checked_at: float | None = None
_VERSION_CACHE_TTL_SEC: Final[int] = 5

# Cache value packing for Redis:
# - Old cached values were raw gzipped MVT bytes (starting with 0x1f 0x8b).
# - New values include a tiny header so we can preserve metadata (e.g. truncation)
#   across cache hits without extra Redis round trips.
_CACHE_MAGIC: Final[bytes] = b"ES"
_CACHE_FORMAT_VERSION: Final[int] = 1
_CACHE_FLAG_TRUNCATED: Final[int] = 1 << 0


@dataclass(frozen=True)
class TileResult:
    gzipped_mvt: bytes
    ttl_sec: int
    cache_key: str
    from_cache: bool
    truncated: bool


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _build_viewport_polygon_wgs84(z: int, x: int, y: int) -> dict[str, Any]:
    west, south, east, north = tile_bounds_wgs84(z, x, y)
    # Expand by tile buffer ratio to pick up edge features and avoid seams.
    ratio = float(BUFFER) / float(EXTENT)
    dx = (east - west) * ratio
    dy = (north - south) * ratio

    west = _clamp(west - dx, -180.0, 180.0)
    east = _clamp(east + dx, -180.0, 180.0)
    south = _clamp(south - dy, -90.0, 90.0)
    north = _clamp(north + dy, -90.0, 90.0)

    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ],
        ],
    }


def _downsample_coords(coords: list[list[float]], max_points: int) -> list[list[float]]:
    if len(coords) <= max_points:
        return coords
    if max_points < 2:
        return coords[:1]

    stride = math.ceil((len(coords) - 1) / float(max_points - 1))
    if stride <= 1:
        return coords
    sampled = coords[0::stride]
    if sampled[-1] != coords[-1]:
        sampled.append(coords[-1])
    return sampled


def _count_vertices(geom) -> int:
    try:
        gtype = geom.geom_type
    except Exception:
        return 0
    if gtype == "LineString":
        return len(getattr(geom, "coords", []) or [])
    if gtype == "MultiLineString":
        return sum(len(ls.coords) for ls in geom.geoms)
    return 0


def _cap_vertices(geom, max_vertices: int):
    """Cap vertices on LineString / MultiLineString by downsampling.

    This is a last-resort safety cap. For normal data, simplification should
    reduce vertices sufficiently without noticeable visual change.
    """
    if max_vertices <= 0:
        return geom
    gtype = getattr(geom, "geom_type", None)
    if gtype == "LineString":
        coords = [[float(x), float(y)] for (x, y) in list(geom.coords)]
        coords = _downsample_coords(coords, max_vertices)
        from shapely.geometry import LineString

        return LineString(coords) if len(coords) >= 2 else geom
    if gtype == "MultiLineString":
        from shapely.geometry import LineString, MultiLineString

        parts = []
        remaining = max_vertices
        for part in geom.geoms:
            if remaining <= 2:
                break
            coords = [[float(x), float(y)] for (x, y) in list(part.coords)]
            per_part = max(2, math.floor(remaining / max(1, len(geom.geoms))))
            coords = _downsample_coords(coords, per_part)
            if len(coords) >= 2:
                parts.append(LineString(coords))
                remaining -= len(coords)
        return MultiLineString(parts) if parts else geom
    return geom


def _build_cache_key(
    *,
    layer: str,
    z: int,
    x: int,
    y: int,
    start_date: str,
    end_date: str,
    imei: str | None,
    use_matched: bool,
    version: str,
) -> str:
    imei_part = imei or "-"
    matched_part = "1" if use_matched else "0"
    # Keep key small and deterministic.
    return (
        f"tile:{layer}:v{version}:{matched_part}:{z}:{x}:{y}:"
        f"{start_date}:{end_date}:{imei_part}"
    )


async def _get_tiles_version() -> str:
    global _version_cache_value, _version_cache_checked_at
    now = datetime.now(UTC).timestamp()
    if (
        _version_cache_value is not None
        and _version_cache_checked_at is not None
        and (now - _version_cache_checked_at) <= _VERSION_CACHE_TTL_SEC
    ):
        return _version_cache_value

    # We store version as an integer string. If Redis is unavailable, fall back.
    try:
        value = await cache_get(TRIP_TILES_VERSION_KEY)
        if isinstance(value, bytes | bytearray) and value:
            decoded = value.decode("utf-8", errors="ignore").strip()
            if decoded:
                _version_cache_value = decoded
                _version_cache_checked_at = now
                return decoded
    except Exception:
        pass

    _version_cache_value = "1"
    _version_cache_checked_at = now
    return "1"


async def get_trip_tiles_version() -> str:
    """Public accessor used by HTTP endpoints to expose tile cache version."""
    return await _get_tiles_version()


async def bump_trip_tiles_version() -> int | None:
    """Increment the trip tiles version in Redis to invalidate cached tiles."""
    global _version_cache_value, _version_cache_checked_at
    value = await cache_incr(TRIP_TILES_VERSION_KEY)
    if value is not None:
        # Update in-process cache immediately for this worker.
        _version_cache_value = str(value)
        _version_cache_checked_at = datetime.now(UTC).timestamp()
    return value


def _pack_cached_tile(*, gzipped_mvt: bytes, truncated: bool) -> bytes:
    flags = _CACHE_FLAG_TRUNCATED if truncated else 0
    return _CACHE_MAGIC + bytes([_CACHE_FORMAT_VERSION, flags]) + bytes(gzipped_mvt)


def _unpack_cached_tile(value: bytes) -> tuple[bytes, bool]:
    # Back-compat: raw gzipped payload.
    if value.startswith(b"\x1f\x8b"):
        return value, False
    if (
        len(value) >= 4
        and value[0:2] == _CACHE_MAGIC
        and value[2] == _CACHE_FORMAT_VERSION
    ):
        flags = int(value[3])
        truncated = bool(flags & _CACHE_FLAG_TRUNCATED)
        payload = value[4:]
        return payload, truncated
    # Unknown format; fail open.
    return value, False


def _is_historic_end_date(end_date: str) -> bool:
    end_dt = parse_query_date(end_date, end_of_day=True)
    if end_dt is None:
        return False
    today = datetime.now(UTC).date()
    return end_dt.date() < today


def _tile_ttl_sec(end_date: str) -> int:
    return 30 * 24 * 60 * 60 if _is_historic_end_date(end_date) else 120


def _build_trip_query(
    *,
    z: int,
    x: int,
    y: int,
    start_date: str,
    end_date: str,
    imei: str | None,
    use_matched: bool,
) -> dict[str, Any]:
    query: dict[str, Any] = {}

    # Calendar-date correctness (timezone-aware) like build_query_from_request().
    date_expr = build_calendar_date_expr(start_date, end_date, date_field="startTime")
    if date_expr:
        query["$expr"] = date_expr

    # Coarse UTC pruning for indexes. Expand to avoid false negatives.
    start_dt = parse_query_date(start_date, end_of_day=False)
    end_dt = parse_query_date(end_date, end_of_day=True)
    if start_dt and end_dt:
        query["startTime"] = {
            "$gte": start_dt - timedelta(days=2),
            "$lte": end_dt + timedelta(days=2),
        }

    query["invalid"] = {"$ne": True}
    if imei:
        query["imei"] = imei

    viewport_polygon = _build_viewport_polygon_wgs84(z, x, y)
    geom_field = "matchedGps" if use_matched else "gps"
    query[geom_field] = {"$geoIntersects": {"$geometry": viewport_polygon}}
    if use_matched:
        # Ensure we don't emit "matched" tiles from raw-only trips.
        query["matchedGps"] = {
            "$ne": None,
            "$geoIntersects": {"$geometry": viewport_polygon},
        }

    return query


def _build_transformer_4326_to_3857() -> pyproj.Transformer:
    return pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)


def _coerce_linestring_geometry(
    geojson_geom: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(geojson_geom, dict):
        return None
    if geojson_geom.get("type") not in {"LineString", "MultiLineString"}:
        return None
    coords = geojson_geom.get("coordinates")
    if not isinstance(coords, list) or not coords:
        return None
    return geojson_geom


def _compute_simplify_tolerance_m(
    bounds_3857: tuple[float, float, float, float],
) -> float:
    minx, _miny, maxx, _maxy = bounds_3857
    tile_width_m = maxx - minx
    if tile_width_m <= 0:
        return 0.0
    # 4 tile units ~= 0.5px at 512px tiles (visually lossless for overview).
    return float((tile_width_m / float(EXTENT)) * 4.0)


def _encode_mvt(
    *,
    layer_name: str,
    features: list[dict[str, Any]],
    quantize_bounds_3857: tuple[float, float, float, float],
) -> bytes:
    # mapbox-vector-tile>=2 expects either a single layer dict with {"name","features"}
    # or a list of such dicts (multi-layer). We encode as a single-layer tile.
    return mapbox_vector_tile.encode(
        [{"name": layer_name, "features": features}],
        default_options={"extents": EXTENT, "quantize_bounds": quantize_bounds_3857},
    )


async def get_trip_tile(
    z: int,
    x: int,
    y: int,
    *,
    start_date: str,
    end_date: str,
    imei: str | None,
    use_matched: bool,
) -> TileResult:
    """Get a cached or freshly-built trip tile."""
    version = await _get_tiles_version()
    layer = "matchedTrips" if use_matched else "trips"
    cache_key = _build_cache_key(
        layer=layer,
        z=z,
        x=x,
        y=y,
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        use_matched=use_matched,
        version=version,
    )

    ttl_sec = _tile_ttl_sec(end_date)

    cached = await cache_get(cache_key)
    if cached:
        payload, truncated = _unpack_cached_tile(cached)
        return TileResult(
            gzipped_mvt=payload,
            ttl_sec=ttl_sec,
            cache_key=cache_key,
            from_cache=True,
            truncated=truncated,
        )

    result = await build_trip_tile(
        z,
        x,
        y,
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        use_matched=use_matched,
    )
    # Best-effort cache write.
    await cache_set(
        cache_key,
        _pack_cached_tile(gzipped_mvt=result.gzipped_mvt, truncated=result.truncated),
        ttl_sec,
    )
    return TileResult(
        gzipped_mvt=result.gzipped_mvt,
        ttl_sec=ttl_sec,
        cache_key=cache_key,
        from_cache=False,
        truncated=result.truncated,
    )


async def build_trip_tile(
    z: int,
    x: int,
    y: int,
    *,
    start_date: str,
    end_date: str,
    imei: str | None,
    use_matched: bool,
) -> TileResult:
    """Build a gzipped MVT tile for the requested z/x/y and filters."""
    bounds_3857 = tile_bounds_3857(z, x, y)
    buffer_m = buffer_meters(bounds_3857, extent=EXTENT, buffer=BUFFER)
    minx, miny, maxx, maxy = bounds_3857
    clip_box = box(minx - buffer_m, miny - buffer_m, maxx + buffer_m, maxy + buffer_m)
    tol_m = _compute_simplify_tolerance_m(bounds_3857)

    query = _build_trip_query(
        z=z,
        x=x,
        y=y,
        start_date=start_date,
        end_date=end_date,
        imei=imei,
        use_matched=use_matched,
    )

    geom_field = "matchedGps" if use_matched else "gps"
    transformer = _build_transformer_4326_to_3857()
    project_fn = transformer.transform

    features: list[dict[str, Any]] = []
    truncated = False
    count_seen = 0

    cursor = (
        Trip.find(query).project(TripTileProjection).limit(MAX_FEATURES_PER_TILE + 1)
    )
    async for trip in cursor:
        count_seen += 1
        if count_seen > MAX_FEATURES_PER_TILE:
            truncated = True
            break

        try:
            trip_dict = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)

            geojson_geom = trip_dict.get(geom_field) or trip_dict.get("gps")
            geojson_geom = _coerce_linestring_geometry(geojson_geom)
            if not geojson_geom:
                continue

            coords = geojson_geom.get("coordinates")
            if (
                geojson_geom.get("type") == "LineString"
                and isinstance(coords, list)
                and len(coords) > MAX_VERTICES_PER_FEATURE * 4
            ):
                geojson_geom = {
                    "type": "LineString",
                    "coordinates": _downsample_coords(
                        coords, MAX_VERTICES_PER_FEATURE * 4
                    ),
                }

            geom = shape(geojson_geom)
            if geom.is_empty:
                continue

            geom_3857 = shapely_transform(project_fn, geom)
            if geom_3857.is_empty:
                continue

            # Clip to buffered tile bounds.
            geom_3857 = geom_3857.intersection(clip_box)
            if geom_3857.is_empty:
                continue

            # Simplify in meters (WebMercator).
            if tol_m > 0:
                with contextlib.suppress(Exception):
                    geom_3857 = geom_3857.simplify(tol_m, preserve_topology=False)
                if geom_3857.is_empty:
                    continue

            if _count_vertices(geom_3857) > MAX_VERTICES_PER_FEATURE:
                geom_3857 = _cap_vertices(geom_3857, MAX_VERTICES_PER_FEATURE)

            start_time = trip_dict.get("startTime")
            end_time = trip_dict.get("endTime")
            start_ts = (
                int(start_time.timestamp())
                if isinstance(start_time, datetime)
                else None
            )
            end_ts = (
                int(end_time.timestamp()) if isinstance(end_time, datetime) else None
            )

            props = {
                "transactionId": trip_dict.get("transactionId"),
                "imei": trip_dict.get("imei"),
                "startTime": start_ts,
                "endTime": end_ts,
                "distance": trip_dict.get("distance"),
                "duration": trip_dict.get("duration"),
                "avgSpeed": trip_dict.get("avgSpeed"),
                "maxSpeed": trip_dict.get("maxSpeed"),
                "matchStatus": trip_dict.get("matchStatus"),
                "source": "matched" if use_matched else "raw",
            }

            features.append(
                {
                    "geometry": geom_3857,
                    "properties": {k: v for k, v in props.items() if v is not None},
                }
            )
        except Exception:
            logger.debug(
                "Failed to process trip for tile z=%s x=%s y=%s", z, x, y, exc_info=True
            )
            continue

    if truncated:
        logger.warning(
            "Trip tile truncated: z=%s x=%s y=%s (>%d features)",
            z,
            x,
            y,
            MAX_FEATURES_PER_TILE,
        )

    try:
        mvt = _encode_mvt(
            layer_name="trips", features=features, quantize_bounds_3857=bounds_3857
        )
    except Exception:
        logger.exception("Failed to encode MVT tile z=%s x=%s y=%s", z, x, y)
        mvt = b""

    gz = gzip.compress(mvt)
    return TileResult(
        gzipped_mvt=gz,
        ttl_sec=_tile_ttl_sec(end_date),
        cache_key="",
        from_cache=False,
        truncated=truncated,
    )
