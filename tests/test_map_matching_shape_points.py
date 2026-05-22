from unittest.mock import AsyncMock, patch

import pytest

from trips.services.matching import MapMatchingService


def test_build_shape_points_sets_break_and_via_types() -> None:
    coords = [[-1.0, 1.0], [-1.1, 1.1], [-1.2, 1.2]]

    shape = MapMatchingService._build_shape_points(coords, None)

    assert shape[0]["type"] == "break"
    assert shape[1]["type"] == "via"
    assert shape[2]["type"] == "break"


def test_match_quality_rejects_tiny_match_for_long_trip() -> None:
    raw = [[-97.0, 32.0], [-97.5, 32.0]]
    matched = {
        "type": "LineString",
        "coordinates": [[-97.0, 32.0], [-97.001, 32.001]],
    }

    error = MapMatchingService.validate_matched_geometry_quality(raw, matched)

    assert error is not None
    assert error.startswith("low-quality-match:too-short")


def test_match_quality_accepts_plausible_match() -> None:
    raw = [[-97.0, 32.0], [-97.5, 32.0]]
    matched = {
        "type": "LineString",
        "coordinates": [[-97.0001, 32.0001], [-97.5001, 32.0001]],
    }

    assert MapMatchingService.validate_matched_geometry_quality(raw, matched) is None


def test_match_quality_rejects_discontinuous_match_for_continuous_raw_gps() -> None:
    raw = [[-97.0 + (i * 0.001), 32.0] for i in range(12)]
    matched = {
        "type": "MultiLineString",
        "coordinates": [
            [[-97.0, 32.0], [-96.996, 32.0]],
            [[-96.993, 32.0], [-96.989, 32.0]],
        ],
    }

    error = MapMatchingService.validate_matched_geometry_quality(raw, matched)

    assert error == "low-quality-match:discontinuous:0.18mi"


class _RouterStub:
    async def trace_attributes(self, *_args, **_kwargs):
        return {
            "geometry": {
                "type": "LineString",
                "coordinates": [[-97.0, 32.0], [-97.001, 32.001]],
            }
        }


class _PartialThenSegmentRouterStub:
    def __init__(self) -> None:
        self.calls = 0

    async def trace_attributes(self, shape, *_args, **_kwargs):
        self.calls += 1
        coords = [[point["lon"], point["lat"]] for point in shape]
        if len(coords) >= 20:
            coords = coords[:2]
        return {
            "geometry": {
                "type": "LineString",
                "coordinates": coords,
            }
        }


@pytest.mark.asyncio
async def test_map_match_coordinates_rejects_low_quality_success_response() -> None:
    coords = [[-97.0, 32.0], [-97.5, 32.0]]
    service = MapMatchingService()

    with patch("trips.services.matching.get_router", return_value=_RouterStub()):
        result = await service.map_match_coordinates(coords)

    assert result["code"] == "Error"
    assert result["message"].startswith("low-quality-match:too-short")


@pytest.mark.asyncio
async def test_map_match_coordinates_recovers_low_quality_match_by_splitting() -> None:
    coords = [[-97.0 + (i * 0.001), 32.0] for i in range(20)]
    router = _PartialThenSegmentRouterStub()
    service = MapMatchingService(router=router)

    result = await service.map_match_coordinates(coords)

    assert result["code"] == "Ok"
    matched = result["matchings"][0]["geometry"]
    assert matched["type"] == "LineString"
    assert matched["coordinates"][0] == coords[0]
    assert matched["coordinates"][-1] == coords[-1]
    assert router.calls >= 3


@pytest.mark.asyncio
async def test_map_matching_service_reuses_router_for_batch() -> None:
    coords = [[-97.0, 32.0], [-97.001, 32.001]]
    service = MapMatchingService()

    with patch(
        "trips.services.matching.get_router",
        new=AsyncMock(return_value=_RouterStub()),
    ) as get_router_mock:
        first = await service.map_match_coordinates(coords)
        second = await service.map_match_coordinates(coords)

    assert first["code"] == "Ok"
    assert second["code"] == "Ok"
    assert get_router_mock.await_count == 1


# --- _find_overlap_trim tests ---


def test_find_overlap_trim_proximity_still_works() -> None:
    """Phase 1 proximity matching should still work as before."""
    existing = [[0.0, 0.0], [1.0, 1.0]]
    # New chunk starts with a point very close to the tail of existing
    new_chunk = [
        [1.0 + 0.0005, 1.0 + 0.0005],  # within tolerance
        [1.0 + 0.0006, 1.0 + 0.0006],
        [1.2, 1.2],
    ]
    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)
    assert trim == 1  # first point is within tolerance and leaves no jump


def test_find_overlap_trim_does_not_use_relaxed_closest_fallback() -> None:
    """Nearby but non-overlapping streets should not be stitched together."""
    existing = [[0.0, 0.0], [1.0, 1.0]]
    tol = MapMatchingService._OVERLAP_TRIM_TOL_DEG
    new_chunk = [
        [1.0 + tol * 5, 1.0 + tol * 5],
        [1.5, 1.5],
        [2.0, 2.0],
    ]
    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)
    assert trim == 0


def test_find_overlap_trim_rejects_trim_that_would_leave_connector_jump() -> None:
    existing = [[0.0, 0.0], [1.0, 1.0]]
    new_chunk = [
        [0.9, 0.9],
        [1.0005, 1.0005],
        [1.004, 1.004],
    ]

    trim = MapMatchingService._find_overlap_trim(existing, new_chunk)

    assert trim == 0


def test_find_overlap_trim_no_fallback_when_too_far() -> None:
    """Distant incoming points should remain separate segments."""
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


def test_append_matched_segments_keeps_distant_recovery_gaps_separate() -> None:
    segments: list[list[list[float]]] = []

    MapMatchingService._append_matched_segments(
        segments,
        [[[0.0, 0.0], [0.001, 0.001]]],
    )
    MapMatchingService._append_matched_segments(
        segments,
        [[[1.0, 1.0], [1.001, 1.001]]],
    )

    assert segments == [
        [[0.0, 0.0], [0.001, 0.001]],
        [[1.0, 1.0], [1.001, 1.001]],
    ]


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
            "matchings": [{"geometry": {"type": "LineString", "coordinates": c}}],
        }

    with patch.object(svc, "_map_match_chunk", side_effect=mock_chunk):
        result = await svc._retry_failed_chunk(coords, None)

    assert len(result) > 0
    assert all(len(segment) >= 2 for segment in result)
    assert call_count >= 2  # at least two sub-chunk calls


@pytest.mark.asyncio
async def test_retry_failed_chunk_gives_up_small_input() -> None:
    """Input with fewer than 10 points should return empty immediately."""
    svc = MapMatchingService()
    coords = [[0.0, 0.0], [1.0, 1.0]]
    result = await svc._retry_failed_chunk(coords, None)
    assert result == []
