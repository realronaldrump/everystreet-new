"""Trip fetching tasks.

This module provides Celery tasks for fetching trips from external sources:
- periodic_fetch_trips: Periodic automatic fetch of recent trips
- manual_fetch_trips_range: Manual fetch for a specific date range
- fetch_all_missing_trips: Bulk fetch to fill gaps in trip history
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from config import get_bouncie_config
from core.async_bridge import run_async_from_sync
from date_utils import parse_timestamp
from db import (
    count_documents_with_retry,
    find_one_with_retry,
    task_config_collection,
    trips_collection,
    update_one_with_retry,
)
from tasks.core import task_runner

logger = get_task_logger(__name__)


@task_runner
async def periodic_fetch_trips_async(
    _self,
    start_time_iso: str | None = None,
    end_time_iso: str | None = None,
    trigger_source: str = "scheduled",
) -> dict[str, Any]:
    """Async logic for fetching periodic trips since the last stored trip.

    Can optionally accept specific start/end times for event-driven fetches.
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

    # Use provided range if available (Event-Driven Mode)
    if start_time_iso and end_time_iso:
        try:
            start_date_fetch = parse_timestamp(start_time_iso)
            end_date_fetch = parse_timestamp(end_time_iso)

            if not start_date_fetch or not end_date_fetch:
                raise ValueError("Invalid start or end time format")

            logger.info(
                "Event-Driven Fetch (%s): Using provided range %s to %s",
                trigger_source,
                start_date_fetch.isoformat(),
                end_date_fetch.isoformat(),
            )
        except Exception as e:
            logger.error(
                "Failed to parse provided date range: %s. Falling back to default logic.",
                e,
            )
            start_date_fetch = None
    else:
        start_date_fetch = None

    # Fallback/Default Logic (Periodic Mode)
    if not start_date_fetch:
        try:
            logger.info("Looking for the most recent trip in the database (any source)")
            latest_trip = await find_one_with_retry(
                trips_collection,
                {},
                sort=[("endTime", -1)],
            )

            if latest_trip:
                latest_trip_id = latest_trip.get("transactionId", "unknown")
                latest_trip_source = latest_trip.get("source", "unknown")
                latest_trip_end = parse_timestamp(latest_trip.get("endTime"))

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

        except Exception as e:
            logger.exception("Error finding latest trip: %s", e)
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

    logger.info("Calling fetch_bouncie_trips_in_range...")
    try:
        fetched_trips = await fetch_bouncie_trips_in_range(
            start_date_fetch,
            end_date_fetch if "end_date_fetch" in locals() else now_utc,
            do_map_match=False,
        )
        logger.info(
            "fetch_bouncie_trips_in_range returned %d trips",
            len(fetched_trips),
        )

        if not fetched_trips:
            logger.warning("No trips were fetched in the date range")
        else:
            logger.info("Fetched %d trips in the date range", len(fetched_trips))

    except Exception as fetch_err:
        logger.exception("Error in fetch_bouncie_trips_in_range: %s", fetch_err)
        raise

    logger.info("Updating last_success_time in task config...")
    try:
        update_result = await update_one_with_retry(
            task_config_collection,
            {"_id": "global_background_task_config"},
            {"$set": {"tasks.periodic_fetch_trips.last_success_time": now_utc}},
            upsert=True,
        )
        logger.info(
            "Config update result: modified_count=%s, upserted_id=%s",
            update_result.modified_count,
            update_result.upserted_id,
        )
    except Exception as update_err:
        logger.exception("Error updating task config: %s", update_err)

    try:
        trips_after_fetch = await count_documents_with_retry(
            trips_collection,
            {"source": "bouncie"},
        )
        logger.info(
            "Total trips with source='bouncie' after fetch: %d",
            trips_after_fetch,
        )

        trips_recent = await count_documents_with_retry(
            trips_collection,
            {
                "source": "bouncie",
                "startTime": {"$gte": start_date_fetch},
            },
        )
        logger.info(
            "Trips with source='bouncie' since %s: %d",
            start_date_fetch.isoformat(),
            trips_recent,
        )
    except Exception as count_err:
        logger.exception("Error counting trips in database: %s", count_err)

    return {
        "status": "success",
        "message": f"Fetched {len(fetched_trips)} trips successfully",
        "trips_fetched": len(fetched_trips),
        "date_range": {
            "start": start_date_fetch.isoformat(),
            "end": now_utc.isoformat(),
        },
    }


@shared_task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    time_limit=3600,
    soft_time_limit=3300,
    name="tasks.periodic_fetch_trips",
)
def periodic_fetch_trips(
    _self,
    start_time_iso: str | None = None,
    end_time_iso: str | None = None,
    trigger_source: str = "scheduled",
    **_kwargs,
):
    """Celery task wrapper for fetching periodic trips.

    Accepts kwargs to support event-driven triggers with specific date ranges.
    """
    return run_async_from_sync(
        periodic_fetch_trips_async(
            _self,
            start_time_iso=start_time_iso,
            end_time_iso=end_time_iso,
            trigger_source=trigger_source,
        )
    )


@task_runner
async def manual_fetch_trips_range_async(
    _self,
    start_iso: str,
    end_iso: str,
    map_match: bool = False,
    manual_run: bool = False,
) -> dict[str, Any]:
    """Fetch trips for a user-specified date range."""

    def _parse_iso(dt_str: str) -> datetime:
        parsed = parse_timestamp(dt_str)
        if not parsed:
            raise ValueError(f"Invalid date value: {dt_str}")
        return parsed

    start_dt = _parse_iso(start_iso)
    end_dt = _parse_iso(end_iso)

    if end_dt <= start_dt:
        raise ValueError("End date must be after start date")

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


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    time_limit=3600,
    soft_time_limit=3300,
    name="tasks.manual_fetch_trips_range",
)
def manual_fetch_trips_range(
    _self,
    start_iso: str,
    end_iso: str,
    map_match: bool = False,
    **_kwargs,
):
    """Celery task wrapper for manual date-range trip fetches."""
    manual_run = _kwargs.get("manual_run", True)

    return run_async_from_sync(
        manual_fetch_trips_range_async(
            _self,
            start_iso,
            end_iso,
            map_match=map_match,
            manual_run=manual_run,
        ),
    )


async def get_earliest_trip_date() -> datetime | None:
    """Find the start time of the earliest trip in the database."""
    try:
        earliest_trip = await find_one_with_retry(
            trips_collection,
            {},
            sort=[("startTime", 1)],
            projection={"startTime": 1},
        )
        if earliest_trip and "startTime" in earliest_trip:
            return parse_timestamp(earliest_trip["startTime"])
    except Exception as e:
        logger.error("Error finding earliest trip date: %s", e)
    return None


@task_runner
async def fetch_all_missing_trips_async(
    _self, manual_run: bool = False, start_iso: str | None = None
) -> dict[str, Any]:
    """Fetch all trips from a start date (defaulting to earliest trip or 2020-01-01) to now."""

    if start_iso:
        start_dt = parse_timestamp(start_iso)
        if not start_dt:
            logger.error(
                "Invalid start_iso provided: %s. Using default.",
                start_iso,
            )
    else:
        start_dt = None

    if not start_dt:
        # Try to find the earliest trip in the DB to use as a start date
        # This ensures we cover everything from the beginning of our history
        earliest_db_date = await get_earliest_trip_date()
        if earliest_db_date:
            # Go back a bit further just in case? Or just use that date.
            # Let's use that date.
            start_dt = earliest_db_date
            logger.info("Using earliest trip date from DB: %s", start_dt)
        else:
            # Fallback if DB is empty
            start_dt = datetime(2020, 1, 1, tzinfo=UTC)
            logger.info("No trips in DB, using hardcoded start date: %s", start_dt)

    end_dt = datetime.now(UTC)

    logger.info(
        "STARTING FETCH ALL MISSING TRIPS TASK: %s to %s (manual_run=%s)",
        start_dt.isoformat(),
        end_dt.isoformat(),
        manual_run,
    )

    try:
        initial_count = await count_documents_with_retry(trips_collection, {})
        logger.info("Current total trips in DB before fetch: %d", initial_count)
    except Exception as e:
        logger.error("Error counting trips: %s", e)

    # We disable map matching for this bulk operation to be faster/safer,
    # or we could make it configurable. For now, let's default to False
    # to avoid slamming the map matching service with years of data.
    # The user can run "Remap Unmatched Trips" later if needed.
    fetched_trips = await fetch_bouncie_trips_in_range(
        start_dt,
        end_dt,
        do_map_match=False,
    )

    logger.info("Fetch all missing trips completed: %d trips", len(fetched_trips))

    return {
        "status": "success",
        "trips_fetched": len(fetched_trips),
        "date_range": {
            "start": start_dt.isoformat(),
            "end": end_dt.isoformat(),
        },
    }


@shared_task(
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    time_limit=7200,  # Allow 2 hours for this potentially large task
    soft_time_limit=7000,
    name="tasks.fetch_all_missing_trips",
)
def fetch_all_missing_trips(_self, **_kwargs):
    """Celery task wrapper for fetching all missing trips."""
    manual_run = _kwargs.get("manual_run", True)
    start_iso = _kwargs.get("start_iso")
    return run_async_from_sync(
        fetch_all_missing_trips_async(_self, manual_run=manual_run, start_iso=start_iso)
    )
