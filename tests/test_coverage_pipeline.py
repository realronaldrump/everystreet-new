from __future__ import annotations
from pathlib import Path

import pytest

from preprocess_streets import preprocess_streets
from routes import constants as routes_constants
from street_coverage import ingestion as coverage_ingestion
from street_coverage.models import CoverageArea


@pytest.mark.asyncio
async def test_preprocess_and_ingestion_uses_driveable_graph(tmp_path: Path) -> None:
    fixture_path = Path("tests/fixtures/sample.osm")
    assert fixture_path.exists()

    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)

    original_graph_dir = routes_constants.GRAPH_STORAGE_DIR
    routes_constants.GRAPH_STORAGE_DIR = graph_dir

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
                    ]
                ],
            },
        }

        from beanie import PydanticObjectId

        area = CoverageArea(
            id=PydanticObjectId(),
            display_name="Test Area",
            boundary=location["boundary"],
            bounding_box=[-97.147, 31.548, -97.144, 31.551],
            status="ready",
            area_version=1,
        )
        location["_id"] = str(area.id)

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setenv("OSM_DATA_PATH", str(fixture_path))
            await preprocess_streets(location)

        graph_path = graph_dir / f"{area.id}.graphml"
        assert graph_path.exists()

        ways = await coverage_ingestion._load_osm_streets_from_graph(area, None)
        assert any(way["tags"]["highway"] == "residential" for way in ways)
        assert all(way["tags"]["highway"] != "footway" for way in ways)
    finally:
        routes_constants.GRAPH_STORAGE_DIR = original_graph_dir
