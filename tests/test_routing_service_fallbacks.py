from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import networkx as nx
import pytest
from bson import ObjectId
from shapely.geometry import LineString

import core.osmnx_graphml as osmnx_graphml_module
import routing.graph_connectivity as graph_connectivity_module
import street_coverage.preprocessing as preprocessing_module
from routing import service


class _AsyncIter:
    def __init__(self, items) -> None:
        self._items = list(items)

    def __aiter__(self):
        async def _gen():
            for item in self._items:
                yield item

        return _gen()


class _DummyJobHandle:
    def __init__(self) -> None:
        self.updates: list[dict] = []
        self.completed_message: str | None = None
        self.failures: list[tuple[str, str | None]] = []

    async def update(self, **kwargs) -> None:
        self.updates.append(dict(kwargs))

    async def complete(self, message: str) -> None:
        self.completed_message = message

    async def fail(self, error: str, message: str | None = None) -> None:
        self.failures.append((error, message))


def _build_graph() -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    graph.graph["crs"] = "epsg:4326"
    graph.add_node(1, x=0.0, y=0.0)
    graph.add_node(2, x=1.0, y=0.0)
    graph.add_edge(
        1,
        2,
        key=0,
        osmid=100,
        length=100.0,
        geometry=LineString([(0.0, 0.0), (1.0, 0.0)]),
    )
    return graph


def _build_area_and_streets():
    area_id = ObjectId()
    area = SimpleNamespace(
        id=area_id,
        display_name="Fallback Test Area",
        boundary={
            "type": "Polygon",
            "coordinates": [
                [[-1.0, -1.0], [2.0, -1.0], [2.0, 2.0], [-1.0, 2.0], [-1.0, -1.0]],
            ],
        },
        bounding_box=[-1.0, -1.0, 2.0, 2.0],
        area_version=1,
    )
    streets = [
        SimpleNamespace(
            id=ObjectId(),
            segment_id=f"{area_id}-1-0",
            geometry={"type": "LineString", "coordinates": [[0.0, 0.0], [1.0, 0.0]]},
            length_miles=0.1,
            street_name="A Street",
            osm_id=9001,
        ),
        SimpleNamespace(
            id=ObjectId(),
            segment_id=f"{area_id}-1-1",
            geometry={"type": "LineString", "coordinates": [[0.0, 0.1], [1.0, 0.1]]},
            length_miles=0.1,
            street_name="B Street",
            osm_id=9002,
        ),
    ]
    return area, streets


def _install_common_mocks(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    *,
    spatial_distance: float,
    trace_distance: float,
    trace_returns_geometry: bool,
    max_trace_segments: int | None = None,
) -> tuple[_DummyJobHandle, ObjectId]:
    graph = _build_graph()
    area, streets = _build_area_and_streets()
    job_handle = _DummyJobHandle()

    graph_dir = tmp_path / "graphs"
    graph_dir.mkdir(parents=True, exist_ok=True)
    graph_path = graph_dir / f"{area.id}.graphml"
    graph_path.write_text("graph", encoding="utf-8")

    monkeypatch.setattr(service, "GRAPH_STORAGE_DIR", graph_dir)
    monkeypatch.setattr(service, "find_job", AsyncMock(return_value=None))
    monkeypatch.setattr(service, "create_job", AsyncMock(return_value=job_handle))
    monkeypatch.setattr(service.CoverageArea, "get", AsyncMock(return_value=area))
    monkeypatch.setattr(service.CoverageState, "find", lambda *_a, **_k: _AsyncIter([]))

    class _QueryField:
        def __eq__(self, _other):
            return self

    class _StreetModel:
        area_id = _QueryField()
        area_version = _QueryField()

        @staticmethod
        def find(*_args, **_kwargs):
            return _AsyncIter(streets)

    monkeypatch.setattr(service, "Street", _StreetModel)

    monkeypatch.setattr(osmnx_graphml_module, "load_graphml_robust", lambda _p: graph)
    monkeypatch.setattr(
        service,
        "prepare_spatial_matching_graph",
        lambda g: (g, lambda x, y: (float(x), float(y))),
    )
    monkeypatch.setattr(service, "try_match_osmid", lambda *_a, **_k: None)
    monkeypatch.setattr(service, "graph_units_to_feet", lambda _g, d: float(d))

    class _DistanceApi:
        def nearest_edges(self, _graph, X, Y, *, return_dist: bool = False):
            if isinstance(X, list):
                edges = [(1, 2, 0)] * len(X)
                dists = [spatial_distance] * len(X)
                return (edges, dists) if return_dist else edges
            edge = (1, 2, 0)
            return (edge, trace_distance) if return_dist else edge

        def nearest_nodes(self, _graph, _x, _y) -> int:
            return 1

    monkeypatch.setattr(
        service,
        "_get_osmnx",
        lambda: SimpleNamespace(distance=_DistanceApi()),
    )

    class _TraceClient:
        async def trace_route(self, _shape, costing: str = "auto"):
            if not trace_returns_geometry:
                return {}
            _ = costing
            return {
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[0.0, 0.0], [0.5, 0.0], [1.0, 0.0]],
                },
            }

    monkeypatch.setattr(
        graph_connectivity_module,
        "get_api_semaphore",
        lambda _loop: asyncio.Semaphore(100),
    )
    monkeypatch.setattr(
        graph_connectivity_module,
        "get_valhalla_client",
        AsyncMock(return_value=_TraceClient()),
    )

    async def _fake_preprocess(_location, _task_id=None):
        return graph, graph_path

    monkeypatch.setattr(preprocessing_module, "preprocess_streets", _fake_preprocess)

    def _fake_solver(_graph, required_reqs, _start_node_id, req_segment_counts=None):
        _ = req_segment_counts
        return (
            [[0.0, 0.0], [1.0, 0.0]],
            {
                "total_distance": 120.0,
                "required_distance": 100.0,
                "required_distance_completed": 100.0,
                "deadhead_distance": 20.0,
                "deadhead_percentage": 16.67,
                "required_reqs": max(1, len(required_reqs)),
                "completed_reqs": len(required_reqs),
                "skipped_disconnected": 0,
                "iterations": 1,
            },
            None,
        )

    class _GapStats:
        bridge_distance_m = 0.0

    async def _fake_fill_route_gaps(route_coords, **_kwargs):
        return route_coords, _GapStats()

    monkeypatch.setattr(service, "solve_greedy_route", _fake_solver)
    monkeypatch.setattr(service, "fill_route_gaps", _fake_fill_route_gaps)
    monkeypatch.setattr(
        service,
        "validate_route",
        lambda *_a, **_k: ([], [], {"coverage_ratio": 1.0, "max_gap_m": 0.0}),
    )

    if max_trace_segments is not None:
        monkeypatch.setattr(
            service,
            "VALHALLA_TRACE_FALLBACK_MAX_SEGMENTS",
            max_trace_segments,
        )

    return job_handle, area.id


@pytest.mark.asyncio
async def test_spatial_fallback_maps_when_osm_phase_misses(
    monkeypatch,
    tmp_path,
) -> None:
    job_handle, area_id = _install_common_mocks(
        monkeypatch,
        tmp_path,
        spatial_distance=10.0,
        trace_distance=10.0,
        trace_returns_geometry=True,
    )

    result = await service._generate_optimal_route_with_progress_impl(
        str(area_id),
        task_id="fallback-spatial",
    )

    assert result["status"] == "success"
    assert result["mapped_segments"] > 0
    assert result["valhalla_trace_attempted"] == 0
    assert result["valhalla_trace_matched"] == 0
    assert job_handle.completed_message == "Route generation complete!"


@pytest.mark.asyncio
async def test_valhalla_trace_fallback_maps_when_spatial_too_far(
    monkeypatch,
    tmp_path,
) -> None:
    _, area_id = _install_common_mocks(
        monkeypatch,
        tmp_path,
        spatial_distance=5000.0,
        trace_distance=10.0,
        trace_returns_geometry=True,
    )

    result = await service._generate_optimal_route_with_progress_impl(
        str(area_id),
        task_id="fallback-trace",
    )

    assert result["status"] == "success"
    assert result["mapped_segments"] > 0
    assert result["valhalla_trace_attempted"] > 0
    assert result["valhalla_trace_matched"] > 0


@pytest.mark.asyncio
async def test_zero_matches_raises_after_retry_with_summary(
    monkeypatch,
    tmp_path,
) -> None:
    job_handle, area_id = _install_common_mocks(
        monkeypatch,
        tmp_path,
        spatial_distance=5000.0,
        trace_distance=5000.0,
        trace_returns_geometry=False,
        max_trace_segments=0,
    )

    with pytest.raises(ValueError) as exc_info:
        await service._generate_optimal_route_with_progress_impl(
            str(area_id),
            task_id="fallback-fail",
        )

    message = str(exc_info.value)
    assert "Could not map any segments to street network." in message
    assert "loaded_segments=" in message
    assert "unmatched_segments=" in message
    assert "graph_nodes=" in message
    assert "graph_edges=" in message
    retry_messages = [
        update.get("message", "")
        for update in job_handle.updates
        if update.get("stage") == "loading_graph"
    ]
    assert any("retrying once" in msg.lower() for msg in retry_messages)


@pytest.mark.asyncio
async def test_mapping_progress_metrics_include_default_and_fallback_aliases(
    monkeypatch,
    tmp_path,
) -> None:
    job_handle, area_id = _install_common_mocks(
        monkeypatch,
        tmp_path,
        spatial_distance=10.0,
        trace_distance=10.0,
        trace_returns_geometry=True,
    )

    await service._generate_optimal_route_with_progress_impl(
        str(area_id),
        task_id="fallback-metrics",
    )

    mapping_updates = [
        update
        for update in job_handle.updates
        if update.get("stage") == "mapping_segments"
        and isinstance(update.get("metrics"), dict)
    ]
    assert mapping_updates

    required_keys = {
        "total_segments",
        "processed_segments",
        "osm_matched",
        "mapped_segments",
        "unmatched_segments",
        "default_total",
        "default_matched",
        "fallback_total",
        "fallback_matched",
    }
    for update in mapping_updates:
        assert required_keys.issubset(update["metrics"].keys())
