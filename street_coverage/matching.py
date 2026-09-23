"""Local trace-to-road interval matching in a metric coordinate system.

Flat buffers select evidence without extending a trace past its endpoints.
Roads compete only where they overlap the same local trace interval. GEOS performs
candidate selection and intersection in vectorized batches; no whole-trip heading
or whole-road midpoint can discard an unrelated turn or neighboring segment.

Junctions need one more rule. A trace cuts corners when it turns, and where
two roads leave a junction almost together (a ramp and its motorway) neither
wins the shared stretch. Both leave the driven road short of its junction. When
a trip drove at least half of a road, passed through the junction at its end,
and went there directly, the short remainder inside that junction is credited.
Conversely, a pass along a neighbouring road can graze a side road for a few
centimetres at their shared junction; such slivers are not a drive.
"""

from __future__ import annotations

import math
from collections import defaultdict
from itertools import pairwise
from typing import Any

import numpy as np
import shapely
from shapely.geometry import LineString

from street_coverage.intervals import continuity_tolerance, union_intervals

MATCHING_VERSION = "coverage-intervals-v3"
MAX_LOCAL_ANGLE_DEGREES = 45
AMBIGUITY_METERS = 0.75
TRACE_BATCH_SIZE = 512
# Longest uncredited stretch at a road end that a junction can explain.
JUNCTION_REACH_METERS = 25.0
# A trip must have driven this much of a road (or half of a shorter one)
# before its junction remainder is credited.
JUNCTION_EVIDENCE_METERS = 3.0
# Evidence shorter than this (or than half of a shorter road) is a graze.
MIN_EVIDENCE_METERS = 1.0


def _road_positions(street, points, *, near_end=False):
    positions = [street.project(point) for point in points]
    # GEOS locates the closing coordinate of a ring at position zero. For a
    # piece on the final leg it denotes the end, not the entire opposite arc.
    if street.is_closed and (near_end or max(positions, default=0) > street.length / 2):
        positions = [street.length if value < 1e-8 else value for value in positions]
    return sorted(positions)


def match_projected_intervals(
    segment_ids: list[str],
    geometries: list,
    tree,
    trace,
    tolerance: float,
) -> dict[str, dict[str, Any]]:
    lines = list(trace.geoms) if trace.geom_type == "MultiLineString" else [trace]
    edges = [
        LineString([start, end])
        for line in lines
        for start, end in pairwise(line.coords)
        if start[:2] != end[:2]
    ]
    if not edges or not geometries:
        return {}
    roads = np.asarray(geometries, dtype=object)
    intervals: dict[str, list[list[float]]] = defaultdict(list)
    offsets: dict[str, float] = defaultdict(float)
    road_by_id: dict[str, Any] = {}
    cosine_limit = math.cos(math.radians(MAX_LOCAL_ANGLE_DEGREES))

    for batch_start in range(0, len(edges), TRACE_BATCH_SIZE):
        batch = edges[batch_start : batch_start + TRACE_BATCH_SIZE]
        buffers = shapely.buffer(
            np.asarray(batch, dtype=object), tolerance, cap_style="flat"
        )
        pairs = tree.query(buffers, predicate="intersects")
        if pairs.size == 0:
            continue
        cuts = shapely.intersection(roads[pairs[1]], buffers[pairs[0]])
        candidates: dict[int, list[tuple]] = defaultdict(list)
        for edge_index, road_index, cut in zip(pairs[0], pairs[1], cuts, strict=True):
            edge = batch[edge_index]
            ex, ey = np.subtract(edge.coords[-1][:2], edge.coords[0][:2])
            edge_length = edge.length
            street = roads[road_index]
            if street.length <= 0:
                continue
            for part in shapely.get_parts(cut):
                if part.geom_type != "LineString" or part.length <= 1e-8:
                    continue
                # Check each local piece: a curved street cannot use its distant
                # endpoints to borrow directional evidence from another road.
                for start, end in pairwise(part.coords):
                    dx, dy = np.subtract(end[:2], start[:2])
                    length = math.hypot(dx, dy)
                    if (
                        length <= 1e-8
                        or abs(ex * dx + ey * dy) < cosine_limit * edge_length * length
                    ):
                        continue
                    piece = LineString([start, end])
                    t0, t1 = sorted(
                        edge.project(shapely.Point(p)) for p in (start, end)
                    )
                    if t1 - t0 <= 1e-8:
                        continue
                    s0, s1 = _road_positions(
                        street, [shapely.Point(p) for p in (start, end)]
                    )
                    offset = piece.interpolate(0.5, normalized=True).distance(edge)
                    candidates[int(edge_index)].append(
                        (t0, t1, int(road_index), s0, s1, offset)
                    )

        for edge_index, choices in candidates.items():
            edge = batch[edge_index]
            boundaries = sorted({value for row in choices for value in row[:2]})
            for start, end in pairwise(boundaries):
                midpoint = (start + end) / 2
                overlapping = [row for row in choices if row[0] <= midpoint <= row[1]]
                if not overlapping:
                    continue
                # Several pieces of the same curved road are one candidate.
                by_road = {}
                for row in overlapping:
                    previous = by_road.get(row[2])
                    if previous is None or row[5] < previous[5]:
                        by_road[row[2]] = row
                ranked = sorted(
                    by_road.values(), key=lambda row: (row[5], segment_ids[row[2]])
                )
                best = ranked[0]
                if len(ranked) > 1 and ranked[1][5] - best[5] < AMBIGUITY_METERS:
                    # Equally plausible roads need better evidence; never award both.
                    continue
                street = roads[best[2]]
                low, high = _road_positions(
                    street,
                    [edge.interpolate(value) for value in (start, end)],
                    near_end=best[3] > street.length / 2,
                )
                low, high = max(best[3], low), min(best[4], high)
                if high <= low:
                    continue
                sid = segment_ids[best[2]]
                road_by_id[sid] = street
                intervals[sid].append(
                    [max(0.0, low / street.length), min(1.0, high / street.length)]
                )
                offsets[sid] = max(offsets[sid], best[5])

    result = {}
    for sid, parts in intervals.items():
        street = road_by_id[sid]
        merged = _extend_to_junctions(
            street,
            union_intervals(parts, tolerance=continuity_tolerance(street.length)),
            trace,
            tolerance,
        )
        covered = math.fsum(end - start for start, end in merged) * street.length
        if covered < min(MIN_EVIDENCE_METERS, street.length / 2):
            continue
        result[sid] = {"intervals": merged, "max_offset_meters": offsets[sid]}
    return result


def _extend_to_junctions(street, merged, trace, tolerance):
    """Credit a road's unmatched end when the trip drove through that junction."""
    if not merged:
        return merged
    length = street.length
    covered = math.fsum(end - start for start, end in merged) * length
    merged = [list(interval) for interval in merged]
    coords = street.coords
    for at_start in (True, False):
        position = merged[0][0] if at_start else merged[-1][1]
        gap = (position if at_start else 1.0 - position) * length
        if (
            gap <= 0
            or gap > JUNCTION_REACH_METERS
            or covered < max(gap, min(JUNCTION_EVIDENCE_METERS, length / 2))
        ):
            continue
        node = shapely.Point(coords[0] if at_start else coords[-1])
        if trace.distance(node) > tolerance:
            continue
        # The trace must go from the credited end to the junction directly,
        # not return to it later after a detour.
        anchor = street.interpolate(position, normalized=True)
        if abs(trace.project(anchor) - trace.project(node)) > gap + 2 * tolerance:
            continue
        if at_start:
            merged[0][0] = 0.0
        else:
            merged[-1][1] = 1.0
    return merged
