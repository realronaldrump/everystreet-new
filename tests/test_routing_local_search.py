from __future__ import annotations

import time

import networkx as nx

from routing.local_search import (
    _DistanceCache,
    _orientation_pass,
    _precompute_service_lengths,
    _relocation_pass,
    _sequence_total_cost_fast,
    _two_opt_pass,
    improve_route_2opt,
)
from routing.types import EdgeRef, ReqId


def _line_graph(node_positions: dict[int, float]) -> nx.MultiDiGraph:
    graph = nx.MultiDiGraph()
    for node, position in node_positions.items():
        graph.add_node(node, x=-105.0 + position * 0.001, y=40.0)
    for source, source_position in node_positions.items():
        for target, target_position in node_positions.items():
            if source != target:
                graph.add_edge(
                    source,
                    target,
                    key=0,
                    length=abs(target_position - source_position),
                )
    return graph


def _one_way_requirements(
    edges: list[EdgeRef],
) -> tuple[dict[ReqId, list[EdgeRef]], list[tuple[ReqId, EdgeRef]]]:
    required: dict[ReqId, list[EdgeRef]] = {}
    sequence: list[tuple[ReqId, EdgeRef]] = []
    for edge in edges:
        rid: ReqId = frozenset({edge})
        required[rid] = [edge]
        sequence.append((rid, edge))
    return required, sequence


def test_two_opt_improves_bad_order_and_preserves_requirements() -> None:
    graph = _line_graph({node: float(node) for node in range(8)})
    required, sequence = _one_way_requirements(
        [(0, 1, 0), (6, 7, 0), (2, 3, 0), (4, 5, 0)]
    )
    cache = _DistanceCache(graph)
    service_lengths = _precompute_service_lengths(graph, sequence)
    original_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    improvements = _two_opt_pass(
        sequence,
        service_lengths,
        0,
        cache,
        time.monotonic() + 1.0,
    )
    improved_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    assert improvements > 0
    assert original_cost is not None
    assert improved_cost is not None
    assert improved_cost < original_cost
    assert {rid for rid, _edge in sequence} == set(required)


def test_disconnected_route_is_searched_and_reports_teleports() -> None:
    graph = nx.MultiDiGraph()
    for node, x, y in (
        (0, -105.0, 40.0),
        (1, -104.999, 40.0),
        (2, -104.998, 40.0),
        (10, -104.0, 41.0),
        (11, -103.999, 41.0),
        (12, -103.998, 41.0),
    ):
        graph.add_node(node, x=x, y=y)
    for source, target in ((0, 1), (1, 2), (1, 0), (2, 1)):
        graph.add_edge(source, target, key=0, length=10.0)
    for source, target in ((10, 11), (11, 12), (11, 10), (12, 11)):
        graph.add_edge(source, target, key=0, length=10.0)

    required, sequence = _one_way_requirements(
        [(0, 1, 0), (10, 11, 0), (1, 2, 0), (11, 12, 0)]
    )
    _coords, stats, improved = improve_route_2opt(
        graph,
        sequence,
        required,
        start_node=0,
        time_budget_s=1.0,
    )

    assert stats["teleports"] >= 1.0
    assert {rid for rid, _edge in improved} == set(required)
    assert len(improved) == len(sequence)


def test_orientation_pass_flips_two_way_service_edge() -> None:
    graph = _line_graph({node: float(node) for node in range(7)})
    first: EdgeRef = (0, 1, 0)
    forward: EdgeRef = (4, 2, 0)
    reverse: EdgeRef = (2, 4, 0)
    last: EdgeRef = (5, 6, 0)
    first_rid: ReqId = frozenset({first})
    reversible_rid: ReqId = frozenset({forward, reverse})
    last_rid: ReqId = frozenset({last})
    required = {
        first_rid: [first],
        reversible_rid: [forward, reverse],
        last_rid: [last],
    }
    sequence = [
        (first_rid, first),
        (reversible_rid, forward),
        (last_rid, last),
    ]
    cache = _DistanceCache(graph)
    service_lengths = _precompute_service_lengths(graph, sequence)
    original_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    improvements = _orientation_pass(
        sequence,
        service_lengths,
        required,
        graph,
        0,
        cache,
        time.monotonic() + 1.0,
    )
    improved_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    assert improvements == 1
    assert sequence[1] == (reversible_rid, reverse)
    assert original_cost is not None
    assert improved_cost is not None
    assert improved_cost < original_cost


def test_or_opt_relocates_straggler_without_reversing_it() -> None:
    graph = _line_graph({node: float(node) for node in range(8)})
    _required, sequence = _one_way_requirements(
        [(0, 1, 0), (6, 7, 0), (2, 3, 0), (4, 5, 0)]
    )
    cache = _DistanceCache(graph)
    service_lengths = _precompute_service_lengths(graph, sequence)
    original_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    improvements = _relocation_pass(
        sequence,
        service_lengths,
        0,
        cache,
        time.monotonic() + 1.0,
    )
    improved_cost = _sequence_total_cost_fast(sequence, service_lengths, 0, cache)

    assert improvements > 0
    assert [edge for _rid, edge in sequence] == [
        (0, 1, 0),
        (2, 3, 0),
        (4, 5, 0),
        (6, 7, 0),
    ]
    assert original_cost is not None
    assert improved_cost is not None
    assert improved_cost < original_cost
