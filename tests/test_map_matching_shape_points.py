from unittest.mock import AsyncMock, patch

import pytest

from trips.services.matching import MapMatchingService


def test_build_shape_points_sets_break_and_via_types() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1], [-1.2, 1.2]]

    shape = MapMatchingService._build_shape_points(coords, None)

    assert shape[0]["type"] == "break"
    assert shape[1]["type"] == "via"
    assert shape[2]["type"] == "break"


# --- _find_overlap_trim tests ---


def test_find_overlap_trim_proximity_still_works() -> None:
    """Phase 1 proximity matching should still work as before."""
    existing = [[0.0, 0.0], [1.0, 1.0]]
    # New chunk starts with a point very close to the tail of existing
    new_chunk = [
        [1.0 + 0.0005, 1.0 + 0.0005],  # within tolerance
        [1.1, 1.1],
        [1.2, 1.2],
    ]
    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)
    assert trim == 1  # first point is within tolerance, so trim it


def test_find_overlap_trim_uses_closest_fallback() -> None:
    """When no point is within strict tolerance, fallback to closest point."""
    existing = [[0.0, 0.0], [1.0, 1.0]]
    # New chunk: no point within 0.001° but the first is closest and within ~1km
    tol = MapMatchingService._OVERLAP_TRIM_TOL_DEG
    new_chunk = [
        [1.0 + tol * 5, 1.0 + tol * 5],  # outside strict, but within 10x
        [1.5, 1.5],
        [2.0, 2.0],
    ]
    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)
    # Fallback should pick the closest point (index 0) and trim it
    assert trim == 1


def test_find_overlap_trim_no_fallback_when_too_far() -> None:
    """When closest point is beyond the relaxed threshold, trim nothing."""
    existing = [[0.0, 0.0], [1.0, 1.0]]
    # All points are very far from the tail
    new_chunk = [
        [5.0, 5.0],
        [6.0, 6.0],
    ]
    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)
    assert trim == 0


# --- _merge_close_segments tests ---


def test_merge_close_segments_joins_nearby() -> None:
    """Segments with a small gap should be merged into one."""
    threshold = MapMatchingService._MAX_MATCHED_JUMP_DEG
    segments = [
        [[0.0, 0.0], [1.0, 1.0]],
        [[1.0 + threshold, 1.0 + threshold], [2.0, 2.0]],  # within 2x threshold
    ]
    result = MapMatchingService._merge_close_segments(segments)
    assert len(result) == 1
    assert len(result[0]) == 4


def test_merge_close_segments_keeps_distant() -> None:
    """Segments with a large gap should remain separate."""
    threshold = MapMatchingService._MAX_MATCHED_JUMP_DEG
    segments = [
        [[0.0, 0.0], [1.0, 1.0]],
        [[1.0 + threshold * 3, 1.0 + threshold * 3], [5.0, 5.0]],  # beyond 2x
    ]
    result = MapMatchingService._merge_close_segments(segments)
    assert len(result) == 2


def test_merge_close_segments_single_segment_passthrough() -> None:
    """A single segment should be returned as-is."""
    segments = [[[0.0, 0.0], [1.0, 1.0]]]
    result = MapMatchingService._merge_close_segments(segments)
    assert len(result) == 1


# --- _retry_failed_chunk tests ---


@pytest.mark.asyncio
async def test_retry_failed_chunk_recovers_halves() -> None:
    """When the full chunk fails but halves succeed, recovered coords are returned."""
    svc = MapMatchingService()
    # 20 coordinates
    coords = [[float(i) * 0.001, float(i) * 0.001] for i in range(20)]

    call_count = 0

    async def mock_chunk(c, ts):
        nonlocal call_count
        call_count += 1
        if len(c) >= 20:
            return {"code": "Error", "message": "too big"}
        # Sub-chunks succeed
        return {
            "code": "Ok",
            "matchings": [{"geometry": {"coordinates": c}}],
        }

    with patch.object(svc, "_map_match_chunk", side_effect=mock_chunk):
        result = await svc._retry_failed_chunk(coords, None)

    assert len(result) > 0
    assert call_count >= 2  # at least two sub-chunk calls


@pytest.mark.asyncio
async def test_retry_failed_chunk_gives_up_small_input() -> None:
    """Input with fewer than 10 points should return empty immediately."""
    svc = MapMatchingService()
    coords = [[0.0, 0.0], [1.0, 1.0]]
    result = await svc._retry_failed_chunk(coords, None)
    assert result == []
