"""
Coverage event system.

This module provides a simple event emission and handling system for triggering coverage
updates when trips complete.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)

# Event handlers registry
_handlers: dict[str, list[Callable[..., Coroutine[Any, Any, None]]]] = {}


def on_event(event_type: str):
    """
    Decorator to register an async event handler.

    Usage:
        @on_event("trip_completed")
        async def handle_trip(trip_id: str, **kwargs):
            ...
    """

    def decorator(func: Callable[..., Coroutine[Any, Any, None]]):
        if event_type not in _handlers:
            _handlers[event_type] = []
        _handlers[event_type].append(func)
        logger.debug(f"Registered handler {func.__name__} for event {event_type}")
        return func

    return decorator


async def emit(event_type: str, **kwargs) -> None:
    """
    Emit an event to all registered handlers.

    Handlers are executed concurrently. Failures in one handler don't affect other
    handlers.
    """
    handlers = _handlers.get(event_type, [])

    if not handlers:
        logger.debug(f"No handlers registered for event {event_type}")
        return

    logger.info(f"Emitting event {event_type} to {len(handlers)} handlers")

    async def run_handler(handler):
        try:
            await handler(**kwargs)
        except Exception as e:
            logger.exception(f"Handler {handler.__name__} failed for {event_type}: {e}")

    await asyncio.gather(*[run_handler(h) for h in handlers])


# =============================================================================
# Standard Event Types
# =============================================================================


class CoverageEvents:
    """Standard coverage event type constants."""

    TRIP_COMPLETED = "trip_completed"
    TRIP_UPLOADED = "trip_uploaded"
    AREA_CREATED = "area_created"
    AREA_DELETED = "area_deleted"
    COVERAGE_UPDATED = "coverage_updated"
    INGESTION_COMPLETED = "ingestion_completed"
    INGESTION_FAILED = "ingestion_failed"


# =============================================================================
# Event Emission Helpers
# =============================================================================


async def emit_trip_completed(
    trip_id: PydanticObjectId | str,
    trip_data: dict[str, Any] | None = None,
) -> None:
    """
    Emit a trip_completed event.

    Called when a live tracking trip ends or a trip is uploaded. This triggers coverage
    updates for all relevant areas.
    """
    await emit(
        CoverageEvents.TRIP_COMPLETED,
        trip_id=trip_id,
        trip_data=trip_data,
        timestamp=datetime.now(UTC),
    )


async def emit_trip_uploaded(
    trip_id: PydanticObjectId | str,
    trip_data: dict[str, Any] | None = None,
) -> None:
    """
    Emit a trip_uploaded event.

    Called when a trip is uploaded via GPX/file import.
    """
    await emit(
        CoverageEvents.TRIP_UPLOADED,
        trip_id=trip_id,
        trip_data=trip_data,
        timestamp=datetime.now(UTC),
    )


async def emit_area_created(
    area_id: PydanticObjectId | str,
    display_name: str,
) -> None:
    """
    Emit an area_created event.

    Triggers the ingestion pipeline to fetch OSM data and build streets.
    """
    await emit(
        CoverageEvents.AREA_CREATED,
        area_id=area_id,
        display_name=display_name,
        timestamp=datetime.now(UTC),
    )


async def emit_coverage_updated(
    area_id: PydanticObjectId | str,
    segments_updated: int,
) -> None:
    """
    Emit a coverage_updated event.

    Fired after coverage state has been updated for an area.
    """
    await emit(
        CoverageEvents.COVERAGE_UPDATED,
        area_id=area_id,
        segments_updated=segments_updated,
        timestamp=datetime.now(UTC),
    )


# =============================================================================
# Handler Registration (loaded at module import)
# =============================================================================


def register_handlers():
    """
    Register all coverage event handlers.

    This is called during application startup to ensure handlers are connected before
    events are emitted.
    """
    # Import worker to register its handlers

    logger.info("Coverage event handlers registered")


def clear_handlers():
    """Clear all registered handlers (for testing)."""
    _handlers.clear()
