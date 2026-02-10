import gzip

import mapbox_vector_tile
import pytest
from shapely.geometry import LineString

from core.tiles import buffer_meters, tile_bounds_3857, tile_bounds_wgs84
from trips.services import trip_tile_service


def test_tile_bounds_are_sane() -> None:
    minx, miny, maxx, maxy = tile_bounds_3857(0, 0, 0)
    assert minx < maxx
    assert miny < maxy
    # WebMercator world bounds are around +/- 20037508m.
    assert minx < 0
    assert maxx > 0

    west, south, east, north = tile_bounds_wgs84(0, 0, 0)
    assert west < east
    assert south < north
    assert west <= -179
    assert east >= 179
    assert south <= -80
    assert north >= 80


def test_buffer_meters_positive() -> None:
    bounds = tile_bounds_3857(6, 10, 20)
    buf = buffer_meters(bounds, extent=4096, buffer=64)
    assert buf > 0


def test_encode_trip_tile_roundtrip_decode() -> None:
    # Build a simple WebMercator line inside a known tile.
    z, x, y = 14, 2620, 6330
    bounds = tile_bounds_3857(z, x, y)
    minx, miny, maxx, maxy = bounds

    line = LineString(
        [
            (minx + (maxx - minx) * 0.2, miny + (maxy - miny) * 0.2),
            (minx + (maxx - minx) * 0.8, miny + (maxy - miny) * 0.8),
        ],
    )

    mvt = trip_tile_service._encode_mvt(
        layer_name="trips",
        features=[
            {
                "geometry": line,
                "properties": {"transactionId": "t1", "distance": 1.23},
            }
        ],
        quantize_bounds_3857=bounds,
    )
    assert isinstance(mvt, (bytes, bytearray))
    assert len(mvt) > 0

    decoded = mapbox_vector_tile.decode(bytes(mvt))
    assert "trips" in decoded
    assert decoded["trips"]["features"]
    props = decoded["trips"]["features"][0]["properties"]
    assert props["transactionId"] == "t1"

    gz = gzip.compress(bytes(mvt))
    roundtrip = gzip.decompress(gz)
    assert roundtrip == bytes(mvt)


def test_cache_key_changes_with_filters() -> None:
    key1 = trip_tile_service._build_cache_key(
        layer="trips",
        z=10,
        x=1,
        y=2,
        start_date="2025-01-01",
        end_date="2025-01-02",
        imei=None,
        use_matched=False,
        version="1",
    )
    key2 = trip_tile_service._build_cache_key(
        layer="trips",
        z=10,
        x=1,
        y=2,
        start_date="2025-01-01",
        end_date="2025-01-03",
        imei=None,
        use_matched=False,
        version="1",
    )
    assert key1 != key2


def test_cached_tile_pack_unpack_preserves_truncated() -> None:
    gz = gzip.compress(b"dummy-mvt")
    packed = trip_tile_service._pack_cached_tile(gzipped_mvt=gz, truncated=True)
    payload, truncated = trip_tile_service._unpack_cached_tile(packed)
    assert payload == gz
    assert truncated is True


def test_cached_tile_unpack_back_compat_gzip_bytes() -> None:
    gz = gzip.compress(b"legacy")
    payload, truncated = trip_tile_service._unpack_cached_tile(gz)
    assert payload == gz
    assert truncated is False
