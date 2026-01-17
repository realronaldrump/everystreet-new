from __future__ import annotations

import csv
import json
from typing import TYPE_CHECKING, Any

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
