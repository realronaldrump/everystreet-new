"""Route generation workflow helpers."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def apply_gap_bridge_stats(
    stats: dict[str, Any],
    *,
    bridge_distance_m: float,
) -> dict[str, Any]:
    """Fold gap bridge distance into route stats in one local calculation."""
    if bridge_distance_m <= 0:
        return stats

    updated = dict(stats)
    updated["gap_bridge_distance_m"] = bridge_distance_m
    updated["deadhead_distance"] = (
        float(updated.get("deadhead_distance", 0.0)) + bridge_distance_m
    )
    updated["total_distance"] = (
        float(updated.get("total_distance", 0.0)) + bridge_distance_m
    )
    total_m = float(updated.get("total_distance", 0.0))
    dead_m = float(updated.get("deadhead_distance", 0.0))
    updated["deadhead_percentage"] = (dead_m / total_m * 100.0) if total_m > 0 else 0.0
    req_all_m = float(updated.get("required_distance", 0.0))
    req_done_m = float(
        updated.get(
            "required_distance_completed",
            updated.get("service_distance", 0.0),
        ),
    )
    updated["deadhead_ratio_all"] = (total_m / req_all_m) if req_all_m > 0 else 0.0
    updated["deadhead_ratio_completed"] = (
        (total_m / req_done_m) if req_done_m > 0 else 0.0
    )
    return updated


def build_route_result(
    *,
    route_coords: list[list[float]],
    stats: dict[str, Any],
    mapped_segments: int,
    loaded_segment_count: int,
    eligible_segments: int,
    skipped_invalid_geometry: int,
    skipped_mapping_distance: int,
    valhalla_trace_attempted: int,
    valhalla_trace_matched: int,
    warnings: list[str],
    validation_details: dict[str, Any],
    location_name: str,
) -> dict[str, Any]:
    """Build the user-facing route result payload."""
    return {
        "status": "success",
        "coordinates": route_coords,
        "total_distance_m": stats["total_distance"],
        "required_distance_m": stats["required_distance"],
        "required_distance_completed_m": stats.get(
            "required_distance_completed",
            stats.get("service_distance", 0.0),
        ),
        "deadhead_distance_m": stats["deadhead_distance"],
        "deadhead_percentage": stats["deadhead_percentage"],
        "undriven_segments_loaded": loaded_segment_count,
        "segment_count": loaded_segment_count,
        "mapped_segments": mapped_segments,
        "eligible_segments": eligible_segments,
        "skipped_invalid_geometry_segments": skipped_invalid_geometry,
        "unmapped_segments": skipped_mapping_distance,
        "valhalla_trace_attempted": valhalla_trace_attempted,
        "valhalla_trace_matched": valhalla_trace_matched,
        "segment_coverage_ratio": validation_details.get("coverage_ratio", 1.0),
        "max_gap_m": validation_details.get("max_gap_m", 0.0),
        "max_gap_ft": validation_details.get("max_gap_ft", 0.0),
        "deadhead_ratio": validation_details.get("deadhead_ratio_completed", 0.0),
        "deadhead_ratio_all": validation_details.get("deadhead_ratio_all", 0.0),
        "deadhead_ratio_eval": validation_details.get("deadhead_ratio_eval", 0.0),
        "required_edge_count": int(stats["required_reqs"]),
        "completed_required_edge_count": int(stats.get("completed_reqs", 0.0)),
        "skipped_required_edge_count": int(stats.get("skipped_disconnected", 0.0)),
        "iterations": int(stats["iterations"]),
        "validation_warnings": warnings,
        "validation_details": validation_details,
        "generated_at": datetime.now(UTC).isoformat(),
        "location_name": location_name,
    }


__all__ = [
    "apply_gap_bridge_stats",
    "build_route_result",
]
