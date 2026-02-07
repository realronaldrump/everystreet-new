"""
Trip fetching tasks.

This module provides ARQ jobs for fetching trips from external sources:
- periodic_fetch_trips: Periodic automatic fetch of recent trips
- manual_fetch_trips_range: Manual fetch for a specific date range
- fetch_all_missing_trips: Bulk fetch to fill gaps in trip history
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from admin.services.admin_service import AdminService
from config import get_bouncie_config
from core.date_utils import parse_timestamp
from db.models import Trip
from tasks.ops import run_task_with_history
from trips.services.bouncie_fetcher import (
    fetch_bouncie_trip_by_transaction_id,
    fetch_bouncie_trips_in_range,
)
from trips.services.trip_history_import_service import (
    resolve_import_start_dt_from_db,
    run_import,
)

logger = logging.getLogger(__name__)


async def _periodic_fetch_trips_logic(
    start_time_iso: str | None = None,
    end_time_iso: str | None = None,
    trigger_source: str = "scheduled",
) -> dict[str, Any]:
    """
    Async logic for fetching periodic trips since the last stored trip.

    Can optionally accept specific start/end times for explicit range
    fetches.
    """

    # Get current Bouncie credentials from database or environment
    bouncie_config = await get_bouncie_config()
    logger.info(
        "Bouncie credentials: CLIENT_ID=%s, CLIENT_SECRET=%s, "
        "REDIRECT_URI=%s, AUTH_CODE=%s, AUTHORIZED_DEVICES count: %d",
        "set" if bouncie_config.get("client_id") else "NOT SET",
        "set" if bouncie_config.get("client_secret") else "NOT SET",
        "set" if bouncie_config.get("redirect_uri") else "NOT SET",
        "set" if bouncie_config.get("authorization_code") else "NOT SET",
        len(bouncie_config.get("authorized_devices", [])),
    )

    logger.info("Determining date range for fetching trips...")
    now_utc = datetime.now(UTC)

    # Use provided range if available (explicit range mode)
    if start_time_iso and end_time_iso:
        try:
            start_date_fetch = parse_timestamp(start_time_iso)
            end_date_fetch = parse_timestamp(end_time_iso)
        except Exception:
            logger.exception(
                "Failed to parse provided date range. Falling back to default logic.",
            )
            start_date_fetch = None
        else:
            if not start_date_fetch or not end_date_fetch:
                logger.warning(
                    "Invalid start or end time format. Falling back to default logic.",
                )
                start_date_fetch = None
            else:
                logger.info(
                    "Range Fetch (%s): Using provided range %s to %s",
                    trigger_source,
                    start_date_fetch.isoformat(),
                    end_date_fetch.isoformat(),
                )
    else:
        start_date_fetch = None

    # Fallback/Default Logic (Periodic Mode)
    if not start_date_fetch:
        try:
            logger.info("Looking for the most recent trip in the database (any source)")
            # Use Beanie to find latest trip
            latest_trip = await Trip.find().sort("-endTime").first_or_none()

            if latest_trip:
                latest_trip_id = latest_trip.transactionId or "unknown"
                # 'source' field is not explicitly in Trip model but extra fields allowed
                latest_trip_source = getattr(latest_trip, "source", "unknown")
                latest_trip_end = latest_trip.endTime

                logger.info(
                    "Found most recent trip: id=%s, source=%s, endTime=%s",
                    latest_trip_id,
                    latest_trip_source,
                    latest_trip_end,
                )

                if latest_trip_end:
                    start_date_fetch = latest_trip_end
                    logger.info(
                        "Using latest trip endTime as start_date_fetch: %s",
                        start_date_fetch.isoformat(),
                    )
                else:
                    logger.warning("Latest trip has no endTime, using fallback")
                    start_date_fetch = now_utc - timedelta(hours=48)
                    logger.info(
                        "Using fallback start date (48 hours ago): %s",
                        start_date_fetch.isoformat(),
                    )
            else:
                logger.warning("No trips found in database, using fallback date range")
                start_date_fetch = now_utc - timedelta(hours=48)
                logger.info(
                    "Using fallback start date (48 hours ago): %s",
                    start_date_fetch.isoformat(),
                )

        except Exception:
            logger.exception("Error finding latest trip")

        if not start_date_fetch:
            start_date_fetch = now_utc - timedelta(hours=48)
            logger.info(
                "Using fallback start date after error (48 hours ago): %s",
                start_date_fetch.isoformat(),
            )

    max_lookback = now_utc - timedelta(days=7)
    if start_date_fetch < max_lookback:
        old_start = start_date_fetch
        start_date_fetch = max_lookback
        logger.info(
            "Limited start date from %s to %s (7 day max)",
            old_start.isoformat(),
            start_date_fetch.isoformat(),
        )

    logger.info(
        "FINAL DATE RANGE: Fetching Bouncie trips from %s to %s",
        start_date_fetch.isoformat(),
        (end_date_fetch if "end_date_fetch" in locals() else now_utc).isoformat(),
    )

    map_match_on_fetch = False
    try:
        app_settings = await AdminService.get_persisted_app_settings()
        map_match_on_fetch = bool(
            app_settings.model_dump().get("mapMatchTripsOnFetch", False),
        )
    except Exception:
        logger.exception(
            "Failed to load map match preference; defaulting to disabled",
        )

    logger.info("Calling fetch_bouncie_trips_in_range...")
    try:
        fetched_trips = await fetch_bouncie_trips_in_range(
            start_date_fetch,
            end_date_fetch if "end_date_fetch" in locals() else now_utc,
            do_map_match=map_match_on_fetch,
        )
        logger.info(
            "fetch_bouncie_trips_in_range returned %d trips",
            len(fetched_trips),
        )

        if not fetched_trips:
            logger.info("No trips were fetched in the date range")
        else:
            logger.info("Fetched %d trips in the date range", len(fetched_trips))

    except Exception:
        logger.exception("Error in fetch_bouncie_trips_in_range")
        raise

    logger.info("Updating last_success_time in task config...")
    logger.info("Updating last_success_time in task config...")
    try:
        from db.models import TaskConfig

        # Update specific task config
        task_config = await TaskConfig.find_one(
            TaskConfig.task_id == "periodic_fetch_trips",
        )
        if not task_config:
            task_config = TaskConfig(task_id="periodic_fetch_trips")

        task_config.config["last_success_time"] = now_utc
        task_config.last_updated = now_utc

        await task_config.save()
        logger.info("Successfully updated last_success_time")

    except Exception:
        logger.exception("Error updating task config")

    try:
        trips_after_fetch = await Trip.find({"source": "bouncie"}).count()

        logger.info(
            "Total trips with source='bouncie' after fetch: %d",
            trips_after_fetch,
        )

        trips_recent = await Trip.find(
            {"source": "bouncie", "startTime": {"$gte": start_date_fetch}},
        ).count()

        logger.info(
            "Trips with source='bouncie' since %s: %d",
            start_date_fetch.isoformat(),
            trips_recent,
        )
    except Exception:
        logger.exception("Error counting trips in database")

    return {
        "status": "success",
        "message": f"Fetched {len(fetched_trips)} trips successfully",
        "trips_fetched": len(fetched_trips),
        "date_range": {
            "start": start_date_fetch.isoformat(),
            "end": now_utc.isoformat(),
        },
    }


async def periodic_fetch_trips(
    ctx: dict[str, Any],
    start_time_iso: str | None = None,
    end_time_iso: str | None = None,
    trigger_source: str = "scheduled",
    manual_run: bool = False,
):
    """
    ARQ job for fetching periodic trips.

    Accepts kwargs to support explicit range triggers with specific date
    ranges.
    """
    return await run_task_with_history(
        ctx,
        "periodic_fetch_trips",
        lambda: _periodic_fetch_trips_logic(
            start_time_iso=start_time_iso,
            end_time_iso=end_time_iso,
            trigger_source=trigger_source,
        ),
        manual_run=manual_run,
    )


async def _fetch_trip_by_transaction_id_logic(
    transaction_id: str,
    trigger_source: str = "manual",
) -> dict[str, Any]:
    """Fetch a single trip by transactionId."""
    if not transaction_id:
        msg = "transaction_id is required"
        raise ValueError(msg)

    logger.info(
        "Fetching trip by transactionId=%s (trigger_source=%s)",
        transaction_id,
        trigger_source,
    )

    map_match_on_fetch = False
    try:
        app_settings = await AdminService.get_persisted_app_settings()
        map_match_on_fetch = bool(
            app_settings.model_dump().get("mapMatchTripsOnFetch", False),
        )
    except Exception:
        logger.exception(
            "Failed to load map match preference; defaulting to disabled",
        )

    processed_ids = await fetch_bouncie_trip_by_transaction_id(
        transaction_id,
        do_map_match=map_match_on_fetch,
    )
    return {
        "status": "success",
        "message": f"Fetched trip {transaction_id}",
        "processed_ids": processed_ids,
    }


async def fetch_trip_by_transaction_id(
    ctx: dict[str, Any],
    transaction_id: str,
    trigger_source: str = "manual",
    manual_run: bool = False,
):
    """ARQ job for fetching a trip by transactionId."""
    return await run_task_with_history(
        ctx,
        "fetch_trip_by_transaction_id",
        lambda: _fetch_trip_by_transaction_id_logic(
            transaction_id=transaction_id,
            trigger_source=trigger_source,
        ),
        manual_run=manual_run,
    )


async def _manual_fetch_trips_range_logic(
    start_iso: str,
    end_iso: str,
    map_match: bool = False,
    manual_run: bool = False,
) -> dict[str, Any]:
    """Fetch trips for a user-specified date range."""

    def _parse_iso(dt_str: str) -> datetime:
        parsed = parse_timestamp(dt_str)
        if not parsed:
            msg = f"Invalid date value: {dt_str}"
            raise ValueError(msg)
        return parsed

    start_dt = _parse_iso(start_iso)
    end_dt = _parse_iso(end_iso)

    if end_dt <= start_dt:
        msg = "End date must be after start date"
        raise ValueError(msg)

    logger.info(
        "STARTING MANUAL FETCH TASK: %s to %s (map_match=%s, manual_run=%s)",
        start_dt.isoformat(),
        end_dt.isoformat(),
        map_match,
        manual_run,
    )

    logger.info(
        "Manual fetch requested from %s to %s (map_match=%s)",
        start_dt.isoformat(),
        end_dt.isoformat(),
        map_match,
    )

    fetched_trips = await fetch_bouncie_trips_in_range(
        start_dt,
        end_dt,
        do_map_match=map_match,
    )

    logger.info("Manual fetch completed: %d trips", len(fetched_trips))

    return {
        "status": "success",
        "trips_fetched": len(fetched_trips),
        "date_range": {
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat(),
        },
        "map_match": bool(map_match),
    }


async def manual_fetch_trips_range(
    ctx: dict[str, Any],
    start_iso: str,
    end_iso: str,
    map_match: bool = False,
    manual_run: bool = True,
):
    """ARQ job for manual date-range trip fetches."""
    return await run_task_with_history(
        ctx,
        "manual_fetch_trips_range",
        lambda: _manual_fetch_trips_range_logic(
            start_iso,
            end_iso,
            map_match=map_match,
            manual_run=manual_run,
        ),
        manual_run=manual_run,
    )


async def get_earliest_trip_date() -> datetime | None:
    """Find the start time of the earliest trip in the database."""
    try:
        # Use Beanie
        earliest_trip = await Trip.find().sort("startTime").first_or_none()
        if earliest_trip and earliest_trip.startTime:
            return earliest_trip.startTime
    except Exception:
        logger.exception("Error finding earliest trip date")
    return None


async def _fetch_all_missing_trips_logic(
    manual_run: bool = False,
    start_iso: str | None = None,
    progress_job_id: str | None = None,
) -> dict[str, Any]:
    """Import trips from Bouncie for the full history range.

    This is insert-only: existing trips are never modified.
    """

    start_dt = parse_timestamp(start_iso) if start_iso else None
    if start_iso and not start_dt:
        logger.error("Invalid start_iso provided: %s. Using default.", start_iso)

    start_dt = await resolve_import_start_dt_from_db(start_dt)
    end_dt = datetime.now(UTC)

    logger.info(
        "STARTING TRIP HISTORY IMPORT TASK: %s to %s (manual_run=%s, progress_job_id=%s)",
        start_dt.isoformat(),
        end_dt.isoformat(),
        manual_run,
        progress_job_id,
    )

    return await run_import(
        progress_job_id=progress_job_id,
        start_dt=start_dt,
        end_dt=end_dt,
    )


async def fetch_all_missing_trips(
    ctx: dict[str, Any],
    manual_run: bool = True,
    start_iso: str | None = None,
    progress_job_id: str | None = None,
):
    """ARQ job for fetching all missing trips."""
    return await run_task_with_history(
        ctx,
        "fetch_all_missing_trips",
        lambda: _fetch_all_missing_trips_logic(
            manual_run=manual_run,
            start_iso=start_iso,
            progress_job_id=progress_job_id,
        ),
        manual_run=manual_run,
    )
