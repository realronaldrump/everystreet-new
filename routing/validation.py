from core.spatial import calculate_max_route_gap

from .constants import (
    DEADHEAD_RATIO_REQUIRED_DISTANCE_FLOOR_M,
    FEET_PER_METER,
    MAX_DEADHEAD_RATIO_ERROR,
    MAX_DEADHEAD_RATIO_WARN,
    MAX_ROUTE_GAP_FT,
    MAX_SKIPPED_REQ_COUNT_ERROR,
    MAX_SKIPPED_REQ_RATIO_ERROR,
    MIN_SEGMENT_COVERAGE_RATIO,
)
from .gaps import GapFillStats


def validate_route(
    route_coords: list[list[float]],
    stats: dict[str, float],
    mapped_segments: int,
    total_segments: int,
    *,
    eligible_segments: int | None = None,
    skipped_invalid_geometry: int = 0,
    skipped_mapping_distance: int = 0,
    gap_fill_stats: GapFillStats | None = None,
) -> tuple[list[str], list[str], dict[str, float]]:
    """Validate route connectivity and coverage; return (errors, warnings, details)."""
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, float] = {}

    if not route_coords or len(route_coords) < 2:
        errors.append("Route has insufficient coordinates.")

    denom = int(eligible_segments if eligible_segments is not None else total_segments)
    coverage_ratio = float(mapped_segments) / float(denom) if denom > 0 else 1.0
    details["coverage_ratio"] = coverage_ratio
    details["mapped_segments"] = float(mapped_segments)
    details["total_segments"] = float(total_segments)
    details["eligible_segments"] = float(denom)
    details["skipped_invalid_geometry"] = float(skipped_invalid_geometry)
    details["skipped_mapping_distance"] = float(skipped_mapping_distance)
    if denom > 0 and coverage_ratio < MIN_SEGMENT_COVERAGE_RATIO:
        errors.append(
            (
                f"Only {mapped_segments}/{denom} eligible undriven segments mapped to the routing graph "
                f"(skipped invalid geometry: {skipped_invalid_geometry}, rejected by distance: {skipped_mapping_distance})."
            ),
        )

    max_gap_ft = calculate_max_route_gap(route_coords)
    details["max_gap_ft"] = max_gap_ft
    details["max_gap_m"] = (
        float(max_gap_ft) / float(FEET_PER_METER) if max_gap_ft else 0.0
    )
    if max_gap_ft > MAX_ROUTE_GAP_FT:
        gap_miles = max_gap_ft / 5280.0
        gap_msg_extra = ""
        if gap_fill_stats and gap_fill_stats.gaps_unfilled:
            gap_msg_extra = f" ({gap_fill_stats.gaps_unfilled}/{gap_fill_stats.gaps_found} gaps could not be filled via Valhalla)"
        errors.append(
            f"Route contains a {max_gap_ft:.0f}ft ({gap_miles:.2f} miles) gap between points{gap_msg_extra}.",
        )

    required_distance = float(stats.get("required_distance", 0.0))
    required_distance_completed = float(
        stats.get("required_distance_completed", stats.get("service_distance", 0.0)),
    )
    total_distance = float(stats.get("total_distance", 0.0))
    if total_distance <= 0:
        errors.append("Route total distance is zero.")

    deadhead_distance = float(
        stats.get(
            "deadhead_distance",
            max(0.0, total_distance - required_distance_completed),
        ),
    )
    details["required_distance_m"] = required_distance
    details["required_distance_completed_m"] = required_distance_completed
    details["total_distance_m"] = total_distance
    details["deadhead_distance_m"] = deadhead_distance

    deadhead_ratio_all = (
        total_distance / required_distance if required_distance > 0 else 0.0
    )
    deadhead_ratio_completed = (
        total_distance / required_distance_completed
        if required_distance_completed > 0
        else 0.0
    )
    # Ratio threshold evaluation uses a floor so "tiny remaining work" does not hard-fail.
    deadhead_ratio_eval = (
        total_distance
        / max(required_distance_completed, DEADHEAD_RATIO_REQUIRED_DISTANCE_FLOOR_M)
        if total_distance > 0
        else 0.0
    )
    details["deadhead_ratio_all"] = deadhead_ratio_all
    details["deadhead_ratio_completed"] = deadhead_ratio_completed
    details["deadhead_ratio_eval"] = deadhead_ratio_eval

    if required_distance_completed <= 0:
        errors.append(
            "Route did not service any required edges (required distance completed is zero).",
        )
    elif required_distance_completed >= DEADHEAD_RATIO_REQUIRED_DISTANCE_FLOOR_M:
        if deadhead_ratio_eval > MAX_DEADHEAD_RATIO_ERROR:
            errors.append(
                f"Deadhead ratio {deadhead_ratio_completed:.2f} exceeds maximum threshold (evaluated with floor).",
            )
        elif deadhead_ratio_eval > MAX_DEADHEAD_RATIO_WARN:
            warnings.append(
                f"Deadhead ratio {deadhead_ratio_completed:.2f} is high; route may be inefficient.",
            )
    # Only warn when required work is tiny (ratio is noisy).
    elif deadhead_ratio_completed > MAX_DEADHEAD_RATIO_ERROR:
        warnings.append(
            f"Deadhead ratio {deadhead_ratio_completed:.2f} is high, but required work is small so the ratio is less meaningful.",
        )
    elif deadhead_ratio_completed > MAX_DEADHEAD_RATIO_WARN:
        warnings.append(
            f"Deadhead ratio {deadhead_ratio_completed:.2f} is high; route may be inefficient.",
        )

    # Solver-level coverage: skipped requirements imply incomplete route.
    required_reqs = int(stats.get("required_reqs", 0.0))
    skipped_reqs = int(stats.get("skipped_disconnected", 0.0))
    details["required_reqs"] = float(required_reqs)
    details["skipped_reqs"] = float(skipped_reqs)
    if required_reqs > 0 and skipped_reqs > 0:
        skipped_ratio = float(skipped_reqs) / float(required_reqs)
        details["skipped_req_ratio"] = skipped_ratio
        if (
            skipped_reqs >= MAX_SKIPPED_REQ_COUNT_ERROR
            or skipped_ratio > MAX_SKIPPED_REQ_RATIO_ERROR
        ):
            errors.append(
                f"Route skipped {skipped_reqs}/{required_reqs} required edges due to disconnected/unreachable network.",
            )
        else:
            warnings.append(
                f"Route skipped {skipped_reqs}/{required_reqs} required edges due to disconnected/unreachable network.",
            )

    if gap_fill_stats is not None:
        details["gaps_found"] = float(gap_fill_stats.gaps_found)
        details["gaps_filled"] = float(gap_fill_stats.gaps_filled)
        details["gaps_unfilled"] = float(gap_fill_stats.gaps_unfilled)
        details["gap_bridge_distance_m"] = float(gap_fill_stats.bridge_distance_m)
        details["gap_bridge_duration_s"] = float(gap_fill_stats.bridge_duration_s)

    return errors, warnings, details
