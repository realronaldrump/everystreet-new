from __future__ import annotations

import pytest
from shapely.geometry import LineString, MultiLineString
from shapely.strtree import STRtree

from street_coverage.intervals import (
    continuity_tolerance,
    covered_fraction,
    interval_discoveries,
    union_intervals,
)
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


def test_corner_cut_turn_credits_both_roads_through_the_junction():
    # The trace leaves the east road 5 m early and reaches the north road
    # along a chord, as map-matched and raw traces do at a turn.
    result = match(
        {
            "east": LineString([(0, 0), (100, 0)]),
            "north": LineString([(100, 0), (100, 100)]),
        },
        LineString([(0, 0), (95, 0), (100, 10), (100, 100)]),
    )
    assert covered_fraction(result["east"]["intervals"]) == 1
    assert covered_fraction(result["north"]["intervals"]) == 1


def test_ramp_split_credits_only_the_road_the_trip_continued_on():
    # A ramp leaves the motorway at a shallow angle: for its first stretch the
    # two are too close to tell apart, so neither wins that shared stretch.
    points = [(100, 0), (108, 0.2), (116, 0.7), (130, 2), (150, 4.5), (200, 15)]
    ramp = LineString(points)
    result = match(
        {
            "approach": LineString([(0, 0), (100, 0)]),
            "motorway": LineString([(100, 0), (300, 0)]),
            "ramp": ramp,
        },
        LineString([(0, 0), *points]),
    )
    assert covered_fraction(result["ramp"]["intervals"]) == 1
    assert "motorway" not in result


def test_junction_credit_needs_a_real_drive_and_a_pass_through_the_junction():
    # Stopping 15 m short of the end never reaches the far junction.
    short = match(
        {"road": LineString([(0, 0), (100, 0)])},
        LineString([(0, 0), (85, 0), (85, 40)]),
    )
    assert covered_fraction(short["road"]["intervals"]) == pytest.approx(0.85)
    # A side road that leaves the junction at a shallow angle is not driven
    # just because the trip passed its junction and its far end is nearby.
    side = match(
        {
            "main": LineString([(0, 0), (100, 0)]),
            "main-2": LineString([(100, 0), (200, 0)]),
            "side": LineString([(100, 0), (119, 6.5)]),
        },
        LineString([(0, 0), (200, 0)]),
    )
    assert "side" not in side


def test_a_graze_past_a_junction_is_not_a_drive():
    result = match(
        {
            "main": LineString([(0, 0), (100, 0)]),
            "next": LineString([(100, 0), (119, 0)]),
        },
        LineString([(0, 0), (100.02, 0)]),
    )
    assert set(result) == {"main"}


def test_sub_meter_holes_between_evidence_are_joined():
    tolerance = continuity_tolerance(120)
    assert union_intervals([[0, 0.5], [0.5 + 0.9 / 120, 1]], tolerance=tolerance) == [
        [0.0, 1.0]
    ]
    assert union_intervals([[0, 0.5], [0.5 + 2 / 120, 1]], tolerance=tolerance) == [
        [0.0, 0.5],
        [0.5 + 2 / 120, 1.0],
    ]


def test_discoveries_attribute_a_closed_hole_to_the_drive_that_closed_it():
    tolerance = continuity_tolerance(100)
    effective = union_intervals([[0, 0.5], [0.505, 1]], tolerance=tolerance)
    discoveries = interval_discoveries(
        [(1, [[0, 0.5]]), (2, [[0.505, 1]])], effective, tolerance=tolerance
    )
    assert effective == [[0.0, 1.0]]
    assert discoveries == [
        {"start": 0.0, "end": 0.5, "first_driven_at": 1},
        {"start": 0.5, "end": 1.0, "first_driven_at": 2},
    ]
