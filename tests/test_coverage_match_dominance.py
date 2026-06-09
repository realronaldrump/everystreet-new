"""
Regression tests for the parallel-road dominance filter in
``AreaSegmentIndex.find_matching_segments``.
"""

from __future__ import annotations

import pytest
from db_helpers import init_mock_beanie
from shapely.geometry import LineString, MultiLineString, mapping

from core.coverage import AreaSegmentIndex
from db.models import CoverageArea, Street


@pytest.fixture
async def matching_db():
    return await init_mock_beanie(CoverageArea, Street)


async def _make_area_with_segments(
    segments: list[dict],
) -> tuple[CoverageArea, AreaSegmentIndex]:
    area = CoverageArea(
        display_name="Match Dominance Area",
        status="ready",
        health="healthy",
        bounding_box=[-98.0, 30.0, -96.0, 32.0],
        total_length_miles=1.0,
        driveable_length_miles=1.0,
        total_segments=len(segments),
    )
    await area.insert()

    for seq, seg in enumerate(segments):
        await Street(
            segment_id=f"{area.id}-{area.area_version}-{seq}",
            area_id=area.id,
            area_version=area.area_version,
            geometry=mapping(seg["line"]),
            street_name=seg.get("name", f"Segment {seq}"),
            length_miles=seg.get("length_miles", 0.05),
        ).insert()

    index = AreaSegmentIndex(area.id, area.area_version)
    await index.build()
    return area, index


@pytest.mark.asyncio
async def test_parallel_road_within_buffer_is_dominated(matching_db) -> None:
    """A parallel road within the buffer is dropped when the driven road is closer."""
    _ = matching_db

    # Two roughly parallel road segments running roughly E-W.
    # Driven road is at lat 30.0; parallel road is ~6 m to the south.
    # 0.00005 deg is roughly 5.5 m at this lat.
    driven = LineString([(-97.001, 30.0), (-96.999, 30.0)])
    parallel = LineString([(-97.001, 29.99995), (-96.999, 29.99995)])

    area, index = await _make_area_with_segments(
        [
            {"line": driven, "name": "Main"},
            {"line": parallel, "name": "Mary"},
        ],
    )

    # Trip drives along Main St.
    trip = LineString([(-97.001, 30.0), (-96.999, 30.0)])

    matched = index.find_matching_segments(trip)
    matched_segs = await Street.find(
        {"segment_id": {"$in": matched}, "area_id": area.id},
    ).to_list()
    matched_names = {s.street_name for s in matched_segs}

    assert "Main" in matched_names, "driven road should be matched"
    assert "Mary" not in matched_names, (
        "parallel road within buffer should be dominated and dropped"
    )


@pytest.mark.asyncio
async def test_two_distinct_parallels_in_different_trip_legs_both_kept(
    matching_db,
) -> None:
    """When the trip drives both parallel roads on separate legs, both match.

    Trip-to-linestring code splits raw GPS into a MultiLineString when GPS
    gaps appear; this test simulates that with two separate sub-lines, one
    on each parallel road.
    """
    _ = matching_db

    # Two parallel E-W road segments, ~220 m apart (well outside any buffer).
    north = LineString([(-97.001, 30.0), (-96.999, 30.0)])
    south = LineString([(-97.001, 29.998), (-96.999, 29.998)])

    area, index = await _make_area_with_segments(
        [
            {"line": north, "name": "North"},
            {"line": south, "name": "South"},
        ],
    )

    # MultiLineString trip: leg 1 on North, leg 2 on South.
    trip = MultiLineString(
        [
            [(-97.001, 30.0), (-96.999, 30.0)],
            [(-97.001, 29.998), (-96.999, 29.998)],
        ],
    )

    matched = index.find_matching_segments(trip)
    matched_segs = await Street.find(
        {"segment_id": {"$in": matched}, "area_id": area.id},
    ).to_list()
    matched_names = {s.street_name for s in matched_segs}

    assert "North" in matched_names, "first leg should match North"
    assert "South" in matched_names, "second leg should match South"
