"""
Optimal route generation task.

This module provides the ARQ job for generating optimal completion
routes for coverage areas using the Rural Postman Problem (RPP)
algorithm.
"""

from __future__ import annotations

from typing import Any

import logging

from routes import generate_optimal_route_with_progress, save_optimal_route
from tasks.ops import run_task_with_history

logger = logging.getLogger(__name__)


async def _generate_optimal_route_logic(
    location_id: str,
    task_id: str,
    start_lon: float | None = None,
    start_lat: float | None = None,
) -> dict[str, Any]:
    """
    Generate optimal completion route for a coverage area.

    Uses the Rural Postman Problem algorithm to find the minimum-distance
    circuit that covers all undriven streets.

    Args:
        location_id: MongoDB ObjectId string for the coverage area
        start_lon: Optional starting longitude
        start_lat: Optional starting latitude

    Returns:
        Dict with route coordinates, distances, and stats
    """
    logger.info(
        "Starting optimal route generation for location %s (task: %s, start: %s, %s)",
        location_id,
        task_id,
        start_lon,
        start_lat,
    )

    start_coords = None
    if start_lon is not None and start_lat is not None:
        start_coords = (start_lon, start_lat)

    # Generate the route with progress tracking
    result = await generate_optimal_route_with_progress(
        location_id,
        task_id,
        start_coords,
    )

    # Save to database if successful
    if result.get("status") == "success":
        await save_optimal_route(location_id, result)
        logger.info(
            "Optimal route generated: %d segments, %.1f%% deadhead",
            result.get("segment_count", 0),
            result.get("deadhead_percentage", 0),
        )

    return result


async def generate_optimal_route(
    ctx: dict[str, Any],
    location_id: str,
    start_lon: float | None = None,
    start_lat: float | None = None,
    manual_run: bool = False,
):
    """ARQ job for generating optimal completion route."""
    if not ctx.get("job_id"):
        import uuid

        ctx["job_id"] = str(uuid.uuid4())
    job_id = ctx["job_id"]

    return await run_task_with_history(
        ctx,
        "generate_optimal_route",
        lambda: _generate_optimal_route_logic(
            location_id=location_id,
            task_id=job_id,
            start_lon=start_lon,
            start_lat=start_lat,
        ),
        manual_run=manual_run,
    )
