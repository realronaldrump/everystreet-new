"""
Bouncie_trip_fetcher.py.

Fetches trip data from the Bouncie API, processes and validates each
trip using the unified TripPipeline, and stores trips in MongoDB.
"""

import asyncio
import logging
from datetime import datetime, timedelta

from config import get_bouncie_config
from core.clients.bouncie import BouncieClient
from core.http.session import get_session
from setup.services.bouncie_oauth import BouncieOAuth
from trips.services.trip_batch_service import TripService
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)


async def fetch_trips_for_device(
    session,
    token: str,
    imei: str,
    start_dt: datetime,
    end_dt: datetime,
) -> list:
    """Fetch trips for a single device between start_dt and end_dt."""
    client = BouncieClient(session)
    trips = await client.fetch_trips_for_device(token, imei, start_dt, end_dt)
    if trips:
        logger.info(
            "Fetched %d trips for device %s",
            len(trips),
            imei,
        )
    else:
        logger.info(
            "Fetched 0 trips for device %s",
            imei,
        )
    return trips


async def fetch_trip_by_transaction_id(
    session,
    token: str,
    transaction_id: str,
) -> list:
    """Fetch a single trip by transactionId."""
    client = BouncieClient(session)
    trips = await client.fetch_trip_by_transaction_id(token, transaction_id)
    if trips:
        logger.info(
            "Fetched %d trips for transactionId %s",
            len(trips),
            transaction_id,
        )
    else:
        logger.info(
            "Fetched 0 trips for transactionId %s",
            transaction_id,
        )
    return trips


async def fetch_bouncie_trip_by_transaction_id(
    transaction_id: str,
    do_map_match: bool = False,
    task_progress: dict | None = None,
) -> list[str]:
    """Fetch and process a trip by transactionId."""
    if not transaction_id:
        return []

    progress_tracker = task_progress
    if progress_tracker is not None:
        progress_tracker.setdefault("fetch_and_store_trips", {})
        progress_tracker["fetch_and_store_trips"]["status"] = "running"
        progress_tracker["fetch_and_store_trips"]["progress"] = 0
        progress_tracker["fetch_and_store_trips"]["message"] = (
            "Starting trip fetch by transactionId"
        )

    try:
        credentials = await get_bouncie_config()
        session = await get_session()
        token = await BouncieOAuth.get_access_token(session, credentials)
        if not token:
            logger.error("Failed to obtain access token; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"]["message"] = (
                    "Failed to obtain access token"
                )
            return []

        trip_service = TripService()
        try:
            raw_trips = await fetch_trip_by_transaction_id(
                session,
                token,
                transaction_id,
            )
        except Exception as exc:
            await TripIngestIssueService.record_issue(
                issue_type="fetch_error",
                message=str(exc),
                source="bouncie",
                transaction_id=str(transaction_id),
                details={"transactionId": transaction_id, "error": str(exc)},
            )
            return []
        if not raw_trips:
            return []

        return await trip_service.process_bouncie_trips(
            raw_trips,
            do_map_match=do_map_match,
            progress_tracker=progress_tracker,
        )
    except Exception as e:
        logger.exception("Error in fetch_bouncie_trip_by_transaction_id")
        if progress_tracker is not None:
            progress_tracker["fetch_and_store_trips"]["status"] = "failed"
            progress_tracker["fetch_and_store_trips"]["message"] = f"Error: {e}"
        return []
    finally:
        if (
            progress_tracker is not None
            and progress_tracker["fetch_and_store_trips"]["status"] != "failed"
        ):
            progress_tracker["fetch_and_store_trips"]["status"] = "completed"
            progress_tracker["fetch_and_store_trips"]["progress"] = 100
            progress_tracker["fetch_and_store_trips"]["message"] = (
                "Completed fetch by transactionId."
            )


async def fetch_bouncie_trips_in_range(
    start_dt: datetime,
    end_dt: datetime,
    do_map_match: bool = False,
    task_progress: dict | None = None,
) -> list:
    # Parallel chunk processing across devices and 7-day windows
    all_new_trips = []
    progress_tracker = task_progress
    if progress_tracker is not None:
        progress_tracker["fetch_and_store_trips"]["status"] = "running"
        progress_tracker["fetch_and_store_trips"]["progress"] = 0
        progress_tracker["fetch_and_store_trips"]["message"] = "Starting trip fetch"

    try:
        # Get Bouncie credentials from database or environment
        credentials = await get_bouncie_config()
        authorized_devices = credentials.get("authorized_devices", [])

        if not authorized_devices:
            logger.error("No authorized devices configured; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"]["message"] = (
                    "No authorized devices configured"
                )
            return all_new_trips

        session = await get_session()
        token = await BouncieOAuth.get_access_token(session, credentials)
        if not token:
            logger.error("Failed to obtain access token; aborting fetch")
            if progress_tracker is not None:
                progress_tracker["fetch_and_store_trips"]["status"] = "failed"
                progress_tracker["fetch_and_store_trips"]["message"] = (
                    "Failed to obtain access token"
                )
            return all_new_trips

        # Initialize TripService once
        trip_service = TripService()

        # Build chunk windows (7-day slices per device)
        chunk_windows: list[tuple[str, datetime, datetime]] = []
        for imei in authorized_devices:
            current_start = start_dt
            while current_start < end_dt:
                current_end = min(current_start + timedelta(days=7), end_dt)
                chunk_windows.append((imei, current_start, current_end))
                current_start = current_end

        if not chunk_windows:
            return all_new_trips

        # Concurrency control - get from credentials config
        max_concurrency = credentials.get("fetch_concurrency", 12)
        if not isinstance(max_concurrency, int) or max_concurrency < 1:
            max_concurrency = 12
        semaphore = asyncio.Semaphore(max_concurrency)
        completed_chunks = 0
        progress_lock = asyncio.Lock()
        total_chunks = len(chunk_windows)

        async def process_chunk(imei: str, s: datetime, e: datetime) -> list[dict]:
            async with semaphore:
                try:
                    try:
                        raw_trips_chunk = await fetch_trips_for_device(
                            session,
                            token,
                            imei,
                            s,
                            e,
                        )
                    except Exception as exc:
                        logger.exception(
                            "Fetch failed for device %s (%s to %s)",
                            imei,
                            s.isoformat(),
                            e.isoformat(),
                        )
                        await TripIngestIssueService.record_issue(
                            issue_type="fetch_error",
                            message=str(exc),
                            source="bouncie",
                            imei=str(imei),
                            details={
                                "imei": imei,
                                "window_start": s.isoformat(),
                                "window_end": e.isoformat(),
                                "error": str(exc),
                            },
                        )
                        return []
                    if raw_trips_chunk:
                        logger.info(
                            "Processing %s fetched trips for device %s (do_map_match=%s)...",
                            len(raw_trips_chunk),
                            imei,
                            do_map_match,
                        )
                        try:
                            processed_transaction_ids = (
                                await trip_service.process_bouncie_trips(
                                    raw_trips_chunk,
                                    do_map_match=do_map_match,
                                    progress_tracker=progress_tracker,
                                )
                            )
                        except Exception as exc:
                            logger.exception(
                                "Trip processing failed for device %s (%s to %s)",
                                imei,
                                s.isoformat(),
                                e.isoformat(),
                            )
                            await TripIngestIssueService.record_issue(
                                issue_type="process_error",
                                message=str(exc),
                                source="bouncie",
                                imei=str(imei),
                                details={
                                    "imei": imei,
                                    "window_start": s.isoformat(),
                                    "window_end": e.isoformat(),
                                    "error": str(exc),
                                },
                            )
                            return []
                        return [
                            {"transactionId": t.get("transactionId"), "imei": imei}
                            for t in raw_trips_chunk
                            if t.get("transactionId") in processed_transaction_ids
                        ]
                    logger.info(
                        "Fetched 0 trips for device %s in range %s to %s",
                        imei,
                        s,
                        e,
                    )
                    return []
                finally:
                    nonlocal completed_chunks
                    async with progress_lock:
                        completed_chunks += 1
                        if progress_tracker is not None and total_chunks:
                            pct = (completed_chunks / total_chunks) * 100
                            progress_tracker["fetch_and_store_trips"]["progress"] = pct
                            progress_tracker["fetch_and_store_trips"]["message"] = (
                                f"Processed {completed_chunks}/{total_chunks} chunks"
                            )

        # Kick off tasks in parallel
        tasks = [process_chunk(imei, s, e) for (imei, s, e) in chunk_windows]
        results = await asyncio.gather(*tasks, return_exceptions=False)

        # Flatten results
        for lst in results:
            if lst:
                all_new_trips.extend(lst)
    except Exception as e:
        logger.exception("Error in fetch_bouncie_trips_in_range")
        if progress_tracker is not None:
            progress_tracker["fetch_and_store_trips"]["status"] = "failed"
            progress_tracker["fetch_and_store_trips"]["message"] = f"Error: {e}"
    finally:
        if (
            progress_tracker is not None
            and progress_tracker["fetch_and_store_trips"]["status"] != "failed"
        ):
            progress_tracker["fetch_and_store_trips"]["status"] = "completed"
            progress_tracker["fetch_and_store_trips"]["progress"] = 100
            progress_tracker["fetch_and_store_trips"]["message"] = (
                f"Completed fetch and processing. Found {len(all_new_trips)} new/updated trips."
            )
    logger.info(
        "fetch_bouncie_trips_in_range finished, returning %d trips.",
        len(all_new_trips),
    )
    return all_new_trips


__all__ = [
    "fetch_bouncie_trip_by_transaction_id",
    "fetch_bouncie_trips_in_range",
    "fetch_trip_by_transaction_id",
    "fetch_trips_for_device",
]
