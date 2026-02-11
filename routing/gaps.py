import logging
from dataclasses import dataclass
from typing import Any

from core.spatial import GeometryService

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GapFillStats:
    gaps_found: int = 0
    gaps_filled: int = 0
    gaps_unfilled: int = 0
    max_gap_ft_before: float = 0.0
    bridge_distance_m: float = 0.0
    bridge_duration_s: float = 0.0


async def fill_route_gaps(
    route_coords: list[list[float]],
    max_gap_ft: float = 1000.0,
    progress_callback: Any | None = None,
) -> tuple[list[list[float]], GapFillStats]:
    """
    Fill gaps in a route with actual driving routes from Valhalla.

    This is a simple post-processing step that finds any gaps larger than
    max_gap_ft and fetches real driving routes to fill them.

    Args:
        route_coords: List of [lon, lat] coordinates
        max_gap_ft: Threshold gap size in feet to trigger filling
        progress_callback: Optional async callback(stage, pct, message)

    Returns:
        (route coordinates with gaps filled, gap fill stats)
    """
    if len(route_coords) < 2:
        return route_coords, GapFillStats()

    from routing.graph_connectivity import fetch_bridge_route

    gaps_to_fill: list[tuple[int, float]] = []  # (index, gap_ft)
    max_gap_before = 0.0

    # Find gaps
    for i in range(1, len(route_coords)):
        prev = route_coords[i - 1]
        cur = route_coords[i]
        if len(prev) < 2 or len(cur) < 2:
            continue

        d_miles = GeometryService.haversine_distance(
            prev[0],
            prev[1],
            cur[0],
            cur[1],
            unit="miles",
        )
        d_ft = d_miles * 5280.0
        max_gap_before = max(max_gap_before, d_ft)

        if d_ft > max_gap_ft:
            gaps_to_fill.append((i, d_ft))

    if not gaps_to_fill:
        logger.info("No gaps > %.0f ft found in route", max_gap_ft)
        return route_coords, GapFillStats(max_gap_ft_before=max_gap_before)

    logger.info("Found %d gaps to fill in route", len(gaps_to_fill))

    # Fetch bridge routes concurrently (Valhalla calls are rate-limited internally).
    import asyncio

    results: dict[int, Any] = {}

    async def _fetch_one(gap_idx: int, gap_ft: float) -> tuple[int, float, Any]:
        prev = route_coords[gap_idx - 1]
        cur = route_coords[gap_idx]
        from_xy = (prev[0], prev[1])
        to_xy = (cur[0], cur[1])
        bridge = await fetch_bridge_route(from_xy, to_xy)
        return gap_idx, gap_ft, bridge

    tasks = [
        asyncio.create_task(_fetch_one(gap_idx, gap_ft))
        for (gap_idx, gap_ft) in gaps_to_fill
    ]

    for completed, fut in enumerate(asyncio.as_completed(tasks), start=1):
        gap_idx, gap_ft, bridge = await fut
        results[gap_idx] = bridge
        if progress_callback:
            pct = int(completed / max(1, len(gaps_to_fill)) * 100)
            await progress_callback(
                "filling_gaps",
                pct,
                f"Filling gap {completed}/{len(gaps_to_fill)} ({gap_ft / 5280:.2f} mi)",
            )

    # Rebuild coordinates with inserts.
    filled_coords: list[list[float]] = []
    gaps_filled = 0
    bridge_distance_m = 0.0
    bridge_duration_s = 0.0

    for i, pt in enumerate(route_coords):
        filled_coords.append(pt)
        gap_idx = i + 1
        if gap_idx >= len(route_coords):
            continue
        bridge = results.get(gap_idx)
        if not bridge or not getattr(bridge, "coordinates", None):
            continue
        coords = bridge.coordinates
        if len(coords) < 2:
            continue
        insert_coords = coords[1:-1] if len(coords) > 2 else []
        if insert_coords:
            filled_coords.extend(insert_coords)
        gaps_filled += 1
        bridge_distance_m += float(getattr(bridge, "distance_m", 0.0) or 0.0)
        bridge_duration_s += float(getattr(bridge, "duration_s", 0.0) or 0.0)
        logger.debug(
            "Filled gap at index %d with %d coordinates",
            gap_idx,
            len(insert_coords),
        )

    gaps_unfilled = len(gaps_to_fill) - gaps_filled
    if gaps_unfilled:
        logger.warning(
            "Filled %d/%d route gaps; %d remain unfilled",
            gaps_filled,
            len(gaps_to_fill),
            gaps_unfilled,
        )
    else:
        logger.info("Filled %d/%d gaps in route", gaps_filled, len(gaps_to_fill))

    return (
        filled_coords,
        GapFillStats(
            gaps_found=len(gaps_to_fill),
            gaps_filled=gaps_filled,
            gaps_unfilled=gaps_unfilled,
            max_gap_ft_before=max_gap_before,
            bridge_distance_m=bridge_distance_m,
            bridge_duration_s=bridge_duration_s,
        ),
    )
