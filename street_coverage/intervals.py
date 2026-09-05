"""Length-preserving unions of normalized positions along a street."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

POSITION_EPSILON = 1e-9


def union_intervals(
    intervals: Iterable[Sequence[float]], *, tolerance: float = POSITION_EPSILON
) -> list[list[float]]:
    ordered = []
    for interval in intervals:
        if len(interval) != 2:
            raise ValueError("A coverage interval requires two positions")
        start, end = map(float, interval)
        if not (math.isfinite(start) and math.isfinite(end)) or start > end:
            raise ValueError("Coverage positions must be finite and ordered")
        if start < -POSITION_EPSILON or end > 1 + POSITION_EPSILON:
            raise ValueError("Coverage positions must be between zero and one")
        start, end = max(0.0, start), min(1.0, end)
        if start < tolerance:
            start = 0.0
        if 1 - end < tolerance:
            end = 1.0
        if end > start:
            ordered.append([start, end])
    ordered.sort()
    result: list[list[float]] = []
    for start, end in ordered:
        if result and start <= result[-1][1] + tolerance:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return result


def covered_fraction(intervals: Iterable[Sequence[float]]) -> float:
    return min(1.0, math.fsum(end - start for start, end in union_intervals(intervals)))


def missing_intervals(intervals: Iterable[Sequence[float]]) -> list[list[float]]:
    result = []
    position = 0.0
    for start, end in union_intervals(intervals):
        if start > position:
            result.append([position, start])
        position = end
    if position < 1:
        result.append([position, 1.0])
    return result


def intersect_intervals(left, right):
    return union_intervals(
        [max(a, c), min(b, d)]
        for a, b in left
        for c, d in right
        if min(b, d) > max(a, c)
    )


def interval_discoveries(timeline, effective):
    """First supported timestamp for each disjoint covered portion."""
    seen = []
    discoveries = []
    for when, intervals in sorted(timeline, key=lambda item: item[0]):
        accepted = intersect_intervals(intervals, effective)
        for start, end in intersect_intervals(accepted, missing_intervals(seen)):
            discoveries.append({"start": start, "end": end, "first_driven_at": when})
        seen = union_intervals([*seen, *accepted])
    return discoveries
