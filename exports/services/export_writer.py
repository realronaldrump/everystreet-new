from __future__ import annotations

import contextlib
import csv
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import gpxpy
import gpxpy.gpx

from exports.serializers import normalize_value

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable
    from pathlib import Path


async def write_json_array(
    path: Path,
    cursor: AsyncIterator[Any],
    serializer: Callable[[Any], dict[str, Any]],
    progress: Callable[[int], Any] | None = None,
) -> int:
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        handle.write("[")
        first = True
        async for item in cursor:
            record = serializer(item)
            if not first:
                handle.write(",")
            handle.write(
                json.dumps(record, separators=(",", ":"), ensure_ascii=True),
            )
            first = False
            count += 1
            if progress:
                await progress(1)
        handle.write("]")
    return count


def _serialize_csv_value(value: Any) -> Any:
    normalized = normalize_value(value)
    if isinstance(normalized, (dict, list)):
        return json.dumps(normalized, separators=(",", ":"), ensure_ascii=True)
    return normalized


async def write_csv(
    path: Path,
    cursor: AsyncIterator[Any],
    fieldnames: list[str],
    serializer: Callable[[Any], dict[str, Any]],
    progress: Callable[[int], Any] | None = None,
) -> int:
    count = 0
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        async for item in cursor:
            record = serializer(item)
            row = {
                field: _serialize_csv_value(record.get(field)) for field in fieldnames
            }
            writer.writerow(row)
            count += 1
            if progress:
                await progress(1)
    return count


async def write_geojson_features(
    path: Path,
    features: AsyncIterator[dict[str, Any]],
    progress: Callable[[int], Any] | None = None,
) -> int:
    count = 0
    with path.open("w", encoding="utf-8") as handle:
        handle.write('{"type":"FeatureCollection","features":[')
        first = True
        async for feature in features:
            if not first:
                handle.write(",")
            handle.write(
                json.dumps(feature, separators=(",", ":"), ensure_ascii=True),
            )
            first = False
            count += 1
            if progress:
                await progress(1)
        handle.write("]}")
    return count


async def write_gpx_tracks(
    path: Path,
    cursor: AsyncIterator[Any],
    serializer: Callable[[Any], dict[str, Any]],
    progress: Callable[[int], Any] | None = None,
) -> int:
    track_count = 0
    gpx = gpxpy.gpx.GPX()
    gpx.creator = "EveryStreet"

    async for item in cursor:
        track_data = serializer(item)
        coords = track_data.get("coordinates") or []
        if not isinstance(coords, list):
            coords = []

        segment = gpxpy.gpx.GPXTrackSegment()
        timestamps = track_data.get("timestamps") or []
        for idx, coord in enumerate(coords):
            if not isinstance(coord, (list, tuple)) or len(coord) < 2:
                continue
            try:
                lon = float(coord[0])
                lat = float(coord[1])
            except (TypeError, ValueError):
                continue
            point = gpxpy.gpx.GPXTrackPoint(lat, lon)
            if idx < len(timestamps) and timestamps[idx] is not None:
                with contextlib.suppress(TypeError, ValueError, OSError):
                    point.time = datetime.fromtimestamp(
                        int(timestamps[idx]),
                        tz=UTC,
                    )
            segment.points.append(point)

        if segment.points:
            track = gpxpy.gpx.GPXTrack()
            name = track_data.get("name")
            if name:
                track.name = str(name)
            description = track_data.get("description")
            if description:
                track.description = str(description)
            track.segments.append(segment)
            gpx.tracks.append(track)
            track_count += 1

        if progress:
            await progress(1)

    path.write_text(gpx.to_xml(), encoding="utf-8")
    return track_count
