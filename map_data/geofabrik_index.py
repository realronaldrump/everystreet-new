"""Helpers for working with the Geofabrik extract index."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from shapely.geometry import shape

from config import DEFAULT_GEOFABRIK_MIRROR, get_geofabrik_mirror, get_osm_extracts_path

if TYPE_CHECKING:
    from collections.abc import Iterable

logger = logging.getLogger(__name__)

DEFAULT_INDEX_URL = f"{DEFAULT_GEOFABRIK_MIRROR}/index-v1.json"
INDEX_CACHE_SUBDIR = "geofabrik"
INDEX_CACHE_FILENAME = "index-v1.json"
INDEX_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
INDEX_CHUNK_SIZE = 2 * 1024 * 1024


def _index_cache_path(extracts_path: str) -> str:
    return str(Path(extracts_path) / INDEX_CACHE_SUBDIR / INDEX_CACHE_FILENAME)


def _index_url() -> str:
    mirror = get_geofabrik_mirror().rstrip("/")
    if mirror.endswith("download.geofabrik.de"):
        return f"{mirror}/index-v1.json"
    return DEFAULT_INDEX_URL


def _needs_refresh(path: str, max_age_seconds: int) -> bool:
    cache_path = Path(path)
    if not cache_path.exists():
        return True
    age = time.time() - cache_path.stat().st_mtime
    return age > max_age_seconds


async def _download_index(cache_path: str, url: str) -> None:
    cache_file = Path(cache_path)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    temp_path = cache_file.with_name(f"{cache_file.name}.tmp")

    async with (
        httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=30.0),
            follow_redirects=True,
        ) as client,
        client.stream("GET", url) as response,
    ):
        response.raise_for_status()
        handle = await asyncio.to_thread(open, temp_path, "wb")
        try:
            async for chunk in response.aiter_bytes(INDEX_CHUNK_SIZE):
                await asyncio.to_thread(handle.write, chunk)
        finally:
            await asyncio.to_thread(handle.close)

    await asyncio.to_thread(os.replace, temp_path, cache_file)


async def load_geofabrik_index(
    *,
    cache_path: str | None = None,
    max_age_seconds: int = INDEX_MAX_AGE_SECONDS,
) -> dict[str, Any] | None:
    if cache_path is None:
        cache_path = _index_cache_path(get_osm_extracts_path())

    url = _index_url()
    try:
        if _needs_refresh(cache_path, max_age_seconds):
            await _download_index(cache_path, url)

        def _read_index(path: str) -> dict[str, Any]:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)

        return await asyncio.to_thread(_read_index, cache_path)
    except Exception as exc:
        logger.warning("Unable to load Geofabrik index: %s", exc)
        return None


def _iter_features(index_data: dict[str, Any] | None) -> Iterable[dict[str, Any]]:
    if not index_data:
        return []
    return index_data.get("features") or []


def _feature_id(feature: dict[str, Any]) -> str | None:
    props = feature.get("properties") or {}
    return props.get("id") or feature.get("id")


def find_smallest_covering_extract(
    index_data: dict[str, Any] | None,
    *,
    path_prefix: str,
    coverage_geometry: Any,
) -> str | None:
    if not index_data or coverage_geometry is None:
        return None

    best_id = None
    best_area = None

    for feature in _iter_features(index_data):
        feature_id = _feature_id(feature)
        if not feature_id or not feature_id.startswith(path_prefix):
            continue
        urls = (feature.get("properties") or {}).get("urls") or {}
        if "pbf" not in urls:
            continue
        geometry = feature.get("geometry")
        if not geometry:
            continue
        try:
            candidate = shape(geometry)
        except Exception:
            continue
        if not candidate.covers(coverage_geometry):
            continue
        area = candidate.area
        if best_area is None or area < best_area:
            best_area = area
            best_id = feature_id

    return best_id
