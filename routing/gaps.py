import logging
from typing import Any

from core.spatial import GeometryService

logger = logging.getLogger(__name__)


async def fill_route_gaps(
    route_coords: list[list[float]],
    max_gap_ft: float = 1000.0,
    progress_callback: Any | None = None,
) -> list[list[float]]:
    """
    Fill gaps in a route with actual driving routes from Valhalla.

    This is a simple post-processing step that finds any gaps larger than
    max_gap_ft and fetches real driving routes to fill them.

    Args:
        route_coords: List of [lon, lat] coordinates
        max_gap_ft: Threshold gap size in feet to trigger filling
        progress_callback: Optional async callback(stage, pct, message)

    Returns:
        Route coordinates with gaps filled
    """
    if len(route_coords) < 2:
        return route_coords

    from routing.graph_connectivity import fetch_bridge_route

    gaps_to_fill: list[tuple[int, float]] = []  # (index, gap_ft)

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

        if d_ft > max_gap_ft:
            gaps_to_fill.append((i, d_ft))

    if not gaps_to_fill:
        logger.info("No gaps > %.0f ft found in route", max_gap_ft)
        return route_coords

    logger.info("Found %d gaps to fill in route", len(gaps_to_fill))

    # Fill gaps (process in reverse order to preserve indices)
    filled_coords = list(route_coords)
    gaps_filled = 0

    for idx, (gap_idx, gap_ft) in enumerate(reversed(gaps_to_fill)):
        if progress_callback:
            pct = int((idx + 1) / len(gaps_to_fill) * 100)
            await progress_callback(
                "filling_gaps",
                pct,
                f"Filling gap {idx + 1}/{len(gaps_to_fill)} ({gap_ft / 5280:.2f} mi)",
            )

        prev = filled_coords[gap_idx - 1]
        cur = filled_coords[gap_idx]

        from_xy = (prev[0], prev[1])
        to_xy = (cur[0], cur[1])

        # Fetch route from Valhalla
        bridge_coords = await fetch_bridge_route(from_xy, to_xy)

        if bridge_coords and len(bridge_coords) >= 2:
            # Insert the bridge coordinates (excluding first/last which are the gap endpoints)
            # to avoid duplicating points
            insert_coords = bridge_coords[1:-1] if len(bridge_coords) > 2 else []
            if insert_coords:
                filled_coords = (
                    filled_coords[:gap_idx] + insert_coords + filled_coords[gap_idx:]
                )
            gaps_filled += 1
            logger.debug(
                "Filled gap at index %d with %d coordinates",
                gap_idx,
                len(insert_coords),
            )
        else:
            logger.warning(
                "Could not fill gap at index %d (%.2f mi) - Valhalla returned no route",
                gap_idx,
                gap_ft / 5280,
            )

    logger.info("Filled %d/%d gaps in route", gaps_filled, len(gaps_to_fill))
    return filled_coords
