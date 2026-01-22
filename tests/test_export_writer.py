import csv
import json

import pytest
import gpxpy

from exports.services.export_writer import (
    write_csv,
    write_gpx_tracks,
    write_geojson_features,
    write_json_array,
)


async def _async_iter(items):
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_write_json_array(tmp_path) -> None:
    items = [{"id": 1}, {"id": 2}]
    path = tmp_path / "items.json"

    count = await write_json_array(path, _async_iter(items), lambda item: item)

    assert count == 2
    assert json.loads(path.read_text()) == items


@pytest.mark.asyncio
async def test_write_csv(tmp_path) -> None:
    items = [{"id": 1, "payload": {"a": 1}}, {"id": 2, "payload": {"b": 2}}]
    path = tmp_path / "items.csv"

    count = await write_csv(
        path,
        _async_iter(items),
        fieldnames=["id", "payload"],
        serializer=lambda item: item,
    )

    assert count == 2
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert rows[0]["id"] == "1"
    assert json.loads(rows[0]["payload"]) == {"a": 1}


@pytest.mark.asyncio
async def test_write_geojson_features(tmp_path) -> None:
    features = [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 1]}},
    ]
    path = tmp_path / "items.geojson"

    count = await write_geojson_features(path, _async_iter(features))

    assert count == 2
    payload = json.loads(path.read_text())
    assert payload["type"] == "FeatureCollection"
    assert len(payload["features"]) == 2


@pytest.mark.asyncio
async def test_write_gpx_tracks(tmp_path) -> None:
    items = [
        {
            "coordinates": [[-122.0, 47.0], [-122.1, 47.1]],
            "name": "Trip 1",
            "description": "start: 2024-01-01T00:00:00Z",
        },
        {
            "coordinates": [],
            "name": "Empty Trip",
        },
    ]
    path = tmp_path / "trips.gpx"

    count = await write_gpx_tracks(
        path,
        _async_iter(items),
        serializer=lambda item: item,
    )

    assert count == 1
    gpx = gpxpy.parse(path.read_text())
    assert len(gpx.tracks) == 1
    assert gpx.tracks[0].name == "Trip 1"
