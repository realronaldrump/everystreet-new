from __future__ import annotations

import pytest
from shapely.geometry import LineString, MultiLineString
from shapely.strtree import STRtree

from street_coverage.intervals import covered_fraction, union_intervals
from street_coverage.matching import match_projected_intervals


def match(roads, trace, tolerance=9.144):
    ids = list(roads)
    geometries = list(roads.values())
    return match_projected_intervals(
        ids, geometries, STRtree(geometries), trace, tolerance
    )


def test_interval_union_is_idempotent_and_preserves_partial_visits():
    visits = [[0, 0.49], [0.51, 1], [0.2, 0.4], [0, 0.49]]
    assert union_intervals(visits) == [[0, 0.49], [0.51, 1]]
    assert covered_fraction(visits) == pytest.approx(0.98)
    assert covered_fraction([*visits, [0.49, 0.51]]) == 1


def test_interval_inputs_reject_nonfinite_and_invalid_bounds():
    with pytest.raises(ValueError):
        union_intervals([[0, float("nan")]])
    with pytest.raises(ValueError):
        union_intervals([[0.6, 0.5]])


def test_partial_trip_does_not_receive_whole_road_or_buffer_end_credit():
    result = match(
        {"road": LineString([(0, 0), (500, 0)])},
        LineString([(0, 0), (245, 0)]),
    )
    assert covered_fraction(result["road"]["intervals"]) == pytest.approx(0.49)


def test_local_direction_keeps_both_legs_of_a_turn():
    result = match(
        {
            "east": LineString([(0, 0), (100, 0)]),
            "north": LineString([(100, 0), (100, 300)]),
        },
        LineString([(0, 0), (100, 0), (100, 300)]),
    )
    assert set(result) == {"east", "north"}
    assert all(covered_fraction(row["intervals"]) == 1 for row in result.values())


def test_crossing_and_short_spur_do_not_count_as_traversal():
    result = match(
        {
            "through": LineString([(0, 0), (100, 0)]),
            "crossing": LineString([(50, -4), (50, 4)]),
            "spur": LineString([(75, 0), (75, 3)]),
        },
        LineString([(0, 0), (100, 0)]),
    )
    assert set(result) == {"through"}


def test_parallel_dominance_only_competes_over_shared_trace_interval():
    result = match(
        {
            "first": LineString([(0, 0), (100, 0)]),
            "second": LineString([(100, 5), (200, 5)]),
            "parallel": LineString([(0, 6), (100, 6)]),
        },
        LineString([(0, 0), (200, 0)]),
    )
    assert set(result) == {"first", "second"}


def test_reverse_driving_and_disconnected_visits_union_without_gap_credit():
    result = match(
        {"road": LineString([(0, 0), (500, 0)])},
        MultiLineString([[(245, 0), (0, 0)], [(500, 0), (255, 0)]]),
    )
    assert covered_fraction(result["road"]["intervals"]) == pytest.approx(0.98)


def test_exactly_ambiguous_parallel_evidence_is_not_invented():
    result = match(
        {
            "north": LineString([(0, 3), (100, 3)]),
            "south": LineString([(0, -3), (100, -3)]),
        },
        LineString([(0, 0), (100, 0)]),
    )
    assert result == {}


def test_closing_leg_of_loop_does_not_credit_the_rest_of_the_loop():
    road = LineString([(0, 0), (100, 0), (100, 100), (0, 100), (0, 0)])
    result = match({"loop": road}, LineString([(0, 100), (0, 0)]))
    assert covered_fraction(result["loop"]["intervals"]) == pytest.approx(0.25)
