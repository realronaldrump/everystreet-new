from .constants import (MAX_DEADHEAD_RATIO_ERROR, MAX_DEADHEAD_RATIO_WARN,
                        MAX_ROUTE_GAP_FT, MIN_SEGMENT_COVERAGE_RATIO)
from .geometry import calculate_max_route_gap


def create_route_stats(
    total_dist: float,
    required_dist: float,
    deadhead_dist: float,
    required_reqs_count: int,
    skipped_count: int,
    iterations: int,
) -> dict[str, float]:
    """Create statistics dictionary for the route."""
    return {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist),
        "deadhead_distance": float(deadhead_dist),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "required_reqs": float(required_reqs_count),
        "completed_reqs": float(required_reqs_count - skipped_count),
        "skipped_disconnected": float(skipped_count),
        "iterations": float(iterations),
    }


def validate_route(
    route_coords: list[list[float]],
    stats: dict[str, float],
    mapped_segments: int,
    total_segments: int,
) -> tuple[list[str], list[str], dict[str, float]]:
    """Validate route connectivity and coverage; return (errors, warnings, details)."""
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, float] = {}

    if not route_coords or len(route_coords) < 2:
        errors.append("Route has insufficient coordinates.")

    coverage_ratio = (
        float(mapped_segments) / float(total_segments) if total_segments > 0 else 1.0
    )
    details["coverage_ratio"] = coverage_ratio
    if total_segments > 0 and coverage_ratio < MIN_SEGMENT_COVERAGE_RATIO:
        errors.append(
            f"Only {mapped_segments}/{total_segments} undriven segments mapped to the routing graph."
        )

    max_gap_ft = calculate_max_route_gap(route_coords)
    details["max_gap_ft"] = max_gap_ft
    if max_gap_ft > MAX_ROUTE_GAP_FT:
        gap_miles = max_gap_ft / 5280.0
        errors.append(
            f"Route contains a {max_gap_ft:.0f}ft ({gap_miles:.2f} miles) gap between points."
        )

    required_distance = float(stats.get("required_distance", 0.0))
    total_distance = float(stats.get("total_distance", 0.0))
    if total_distance <= 0:
        errors.append("Route total distance is zero.")

    deadhead_ratio = (
        total_distance / required_distance if required_distance > 0 else 0.0
    )
    details["deadhead_ratio"] = deadhead_ratio
    if deadhead_ratio > MAX_DEADHEAD_RATIO_ERROR:
        errors.append(f"Deadhead ratio {deadhead_ratio:.2f} exceeds maximum threshold.")
    elif deadhead_ratio > MAX_DEADHEAD_RATIO_WARN:
        warnings.append(
            f"Deadhead ratio {deadhead_ratio:.2f} is high; route may be inefficient."
        )

    return errors, warnings, details
