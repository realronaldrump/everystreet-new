from __future__ import annotations

from pathlib import Path

import networkx as nx
import pytest

import street_coverage.preprocessing as preprocess_module
from core.osmnx_graphml import load_graphml_robust
from routing import constants as routing_constants
from street_coverage import ingestion as coverage_ingestion
from street_coverage.preprocessing import preprocess_streets
from street_coverage.public_road_filter import (
    GRAPH_ROAD_FILTER_SIGNATURE_KEY,
    get_public_road_filter_signature,
)


def _make_location(location_id: str = "test-area") -> dict:
    return {
        "_id": location_id,
        "id": location_id,
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


@pytest.mark.asyncio
async def test_preprocess_and_ingestion_applies_public_road_filter_xml(
    tmp_path: Path,
) -> None:
    fixture_path = Path("tests/fixtures/sample.osm")
    assert fixture_path.exists()

    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)

    original_graph_dir = routing_constants.GRAPH_STORAGE_DIR
    routing_constants.GRAPH_STORAGE_DIR = graph_dir
    preprocess_module.GRAPH_STORAGE_DIR = graph_dir

    try:
        location = _make_location()

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setenv("OSM_DATA_PATH", str(fixture_path))
            monkeypatch.setenv("COVERAGE_GRAPH_MAX_MB", "0")
            monkeypatch.setenv("COVERAGE_PUBLIC_ROAD_FILTER_MODE", "balanced")
            monkeypatch.setenv("COVERAGE_TRACK_POLICY", "conditional")
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
                "area_version": 1,
            },
        )()

        ways, filter_stats = await coverage_ingestion._load_osm_streets_from_graph(
            area_stub,
            None,
        )

        names = {str(way["tags"].get("name") or "") for way in ways}
        assert "Driveable Way" in names
        assert "Public Track" in names
        assert "Destination Access Road" in names
        assert "Conditional Access Road" in names

        assert "Footpath" not in names
        assert "Parking Aisle" not in names
        assert "Private Road" not in names
        assert "Unverified Track" not in names
        assert "Service Alley" not in names
        assert "Delivery Only Road" not in names
        assert "Road Area Polygon" not in names

        graph_filter_stats = filter_stats.get("graph_build_filter_stats") or {}
        assert int(graph_filter_stats.get("excluded_count", 0)) >= 6
        assert (
            graph_filter_stats.get("excluded_by_reason", {}).get(
                "exclude_service_subtype",
                0,
            )
            >= 2
        )
        assert int(graph_filter_stats.get("ambiguous_included_count", 0)) >= 2
    finally:
        routing_constants.GRAPH_STORAGE_DIR = original_graph_dir
        preprocess_module.GRAPH_STORAGE_DIR = original_graph_dir


@pytest.mark.asyncio
async def test_preprocess_filters_mocked_pbf_network(tmp_path: Path) -> None:
    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)
    pbf_path = tmp_path / "sample.osm.pbf"
    pbf_path.write_bytes(b"pbf")

    original_graph_dir = routing_constants.GRAPH_STORAGE_DIR
    routing_constants.GRAPH_STORAGE_DIR = graph_dir
    preprocess_module.GRAPH_STORAGE_DIR = graph_dir

    try:
        def fake_graph_from_pbf(_path: Path) -> nx.MultiDiGraph:
            graph = nx.MultiDiGraph()
            graph.add_node(1, x=-97.1460, y=31.5490)
            graph.add_node(2, x=-97.1455, y=31.5490)
            graph.add_node(3, x=-97.1460, y=31.5492)
            graph.add_node(4, x=-97.1455, y=31.5492)
            graph.add_node(5, x=-97.1460, y=31.5494)
            graph.add_node(6, x=-97.1455, y=31.5494)
            graph.add_node(7, x=-97.1460, y=31.5496)
            graph.add_node(8, x=-97.1455, y=31.5496)

            graph.add_edge(
                1,
                2,
                key=0,
                highway="residential",
                name="Public Road",
                osmid=101,
            )
            graph.add_edge(
                3,
                4,
                key=0,
                highway="service",
                service="parking_aisle",
                name="Parking Aisle",
                osmid=102,
            )
            graph.add_edge(
                5,
                6,
                key=0,
                highway="residential",
                access="private",
                name="Private Road",
                osmid=103,
            )
            graph.add_edge(
                7,
                8,
                key=0,
                highway="track",
                motor_vehicle="yes",
                name="Public Track",
                osmid=104,
            )
            return graph

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setenv("OSM_DATA_PATH", str(pbf_path))
            monkeypatch.setenv("COVERAGE_GRAPH_MAX_MB", "0")
            monkeypatch.setattr(preprocess_module, "_graph_from_pbf", fake_graph_from_pbf)

            location = _make_location("pbf-area")
            await preprocess_streets(location)

            area_stub = type(
                "AreaStub",
                (),
                {
                    "id": "pbf-area",
                    "display_name": "PBF Test Area",
                    "boundary": location["boundary"],
                    "bounding_box": None,
                    "area_version": 1,
                },
            )()
            ways, _stats = await coverage_ingestion._load_osm_streets_from_graph(
                area_stub,
                None,
            )

        names = {str(way["tags"].get("name") or "") for way in ways}
        assert "Public Road" in names
        assert "Public Track" in names
        assert "Parking Aisle" not in names
        assert "Private Road" not in names
    finally:
        routing_constants.GRAPH_STORAGE_DIR = original_graph_dir
        preprocess_module.GRAPH_STORAGE_DIR = original_graph_dir


@pytest.mark.asyncio
async def test_graph_rebuilds_when_filter_signature_changes(tmp_path: Path) -> None:
    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)

    original_graph_dir = routing_constants.GRAPH_STORAGE_DIR
    routing_constants.GRAPH_STORAGE_DIR = graph_dir
    preprocess_module.GRAPH_STORAGE_DIR = graph_dir

    try:
        stale_graph_path = graph_dir / "sig-area.graphml"
        stale_graph = nx.MultiDiGraph()
        stale_graph.add_node(1, x=-97.1460, y=31.5490)
        stale_graph.add_node(2, x=-97.1455, y=31.5490)
        stale_graph.add_edge(1, 2, key=0, highway="residential", osmid=10)
        stale_graph.graph[GRAPH_ROAD_FILTER_SIGNATURE_KEY] = "stale-signature"
        nx.write_graphml(stale_graph, stale_graph_path)

        called = {"value": False}

        async def fake_preprocess_streets(location: dict, task_id: str | None = None):
            _ = location
            _ = task_id
            called["value"] = True
            graph = nx.MultiDiGraph()
            graph.add_node(1, x=-97.1460, y=31.5490)
            graph.add_node(2, x=-97.1455, y=31.5490)
            graph.add_edge(1, 2, key=0, highway="residential", osmid=99)
            graph.graph[GRAPH_ROAD_FILTER_SIGNATURE_KEY] = (
                get_public_road_filter_signature()
            )
            nx.write_graphml(graph, stale_graph_path)
            return graph, stale_graph_path

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setattr(
                preprocess_module,
                "preprocess_streets",
                fake_preprocess_streets,
            )

            area_stub = type(
                "AreaStub",
                (),
                {
                    "id": "sig-area",
                    "display_name": "Signature Test Area",
                    "boundary": _make_location("sig-area")["boundary"],
                    "bounding_box": None,
                    "area_version": 1,
                },
            )()
            graph_path = await coverage_ingestion._ensure_area_graph(area_stub, None)

        assert graph_path == stale_graph_path
        assert called["value"] is True

        rebuilt = load_graphml_robust(stale_graph_path)
        assert rebuilt.graph.get(
            GRAPH_ROAD_FILTER_SIGNATURE_KEY,
        ) == get_public_road_filter_signature()
    finally:
        routing_constants.GRAPH_STORAGE_DIR = original_graph_dir
        preprocess_module.GRAPH_STORAGE_DIR = original_graph_dir
