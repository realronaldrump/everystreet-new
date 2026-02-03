from __future__ import annotations

from pathlib import Path

import pytest

import street_coverage.preprocessing as preprocess_module
from routing import constants as routing_constants
from street_coverage import ingestion as coverage_ingestion
from street_coverage.preprocessing import preprocess_streets


@pytest.mark.asyncio
async def test_preprocess_and_ingestion_uses_driveable_graph(tmp_path: Path) -> None:
    fixture_path = Path("tests/fixtures/sample.osm")
    assert fixture_path.exists()

    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)

    original_graph_dir = routing_constants.GRAPH_STORAGE_DIR
    routing_constants.GRAPH_STORAGE_DIR = graph_dir
    preprocess_module.GRAPH_STORAGE_DIR = graph_dir

    try:
        location = {
            "_id": "test-area",
            "id": "test-area",
            "display_name": "Test Area",
            "boundary": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [-97.147, 31.548],
                        [-97.144, 31.548],
                        [-97.144, 31.551],
                        [-97.147, 31.551],
                        [-97.147, 31.548],
                    ],
                ],
            },
        }

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setenv("OSM_DATA_PATH", str(fixture_path))
            monkeypatch.setenv("COVERAGE_GRAPH_MAX_MB", "0")
            await preprocess_streets(location)

        graph_path = graph_dir / "test-area.graphml"
        assert graph_path.exists()

        area_stub = type(
            "AreaStub",
            (),
            {
                "id": "test-area",
                "display_name": "Test Area",
                "boundary": location["boundary"],
                "bounding_box": None,
            },
        )()

        ways = await coverage_ingestion._load_osm_streets_from_graph(area_stub, None)
        assert any(way["tags"]["highway"] == "residential" for way in ways)
        assert all(way["tags"]["highway"] != "footway" for way in ways)
    finally:
        routing_constants.GRAPH_STORAGE_DIR = original_graph_dir
        preprocess_module.GRAPH_STORAGE_DIR = original_graph_dir
