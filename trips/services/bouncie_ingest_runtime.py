"""Shared Bouncie historical ingest runtime."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any, Literal

from beanie.operators import In
from fastapi import HTTPException, status

from admin.services.admin_service import AdminService
from config import get_bouncie_config
from core.bouncie_normalization import normalize_rest_trip_payload
from core.clients.bouncie import BouncieClient
from core.date_utils import ensure_utc, parse_timestamp
from core.http.session import get_session
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip
from setup.services.bouncie_oauth import BouncieOAuth
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.trip_history_import_service_config import (
    MIN_WINDOW_HOURS,
    REQUEST_TIMEOUT_SECONDS,
    SPLIT_CHUNK_HOURS,
)
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)

IngestMode = Literal["insert_only", "upsert_bouncie"]

COUNTER_KEYS = (
    "found_raw",
    "found_unique",
    "skipped_existing",
    "skipped_conflicting_source",
    "validation_failed",
    "inserted",
    "updated",
    "fetch_errors",
    "process_errors",
)


def build_ingest_counters() -> dict[str, int]:
    """Build a default ingest counter dictionary."""
    return dict.fromkeys(COUNTER_KEYS, 0)


def merge_ingest_counters(target: dict[str, int], delta: dict[str, int]) -> None:
    """Merge ingest counters into a target dictionary in place."""
    for key, value in delta.items():
        target[key] = int(target.get(key, 0) or 0) + int(value or 0)


def is_duplicate_trip_error(exc: Exception) -> bool:
    """Detect duplicate-key collisions from persistence layers."""
    if exc.__class__.__name__ == "DuplicateKeyError":
        return True
    if isinstance(exc, HTTPException) and exc.status_code == status.HTTP_409_CONFLICT:
        detail = str(getattr(exc, "detail", "") or "").lower()
        return "already exists" in detail or "duplicate" in detail
    msg = str(exc).lower()
    return "duplicate key" in msg or "e11000" in msg


def dedupe_trips_by_transaction_id(trips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate trip dicts by transactionId, preserving first occurrence."""
    by_id: dict[str, dict[str, Any]] = {}
    for trip in trips:
        if not isinstance(trip, dict):
            continue
        tx = str(trip.get("transactionId") or "").strip()
        if not tx or tx in by_id:
            continue
        by_id[tx] = trip
    return list(by_id.values())


def filter_trips_to_window(
    trips: list[dict[str, Any]],
    *,
    window_start: datetime,
    window_end: datetime,
) -> list[dict[str, Any]]:
    """Defensively enforce window bounds on returned trips."""
    start = ensure_utc(window_start) or window_start
    end = ensure_utc(window_end) or window_end
    kept: list[dict[str, Any]] = []
    for trip in trips:
        if not isinstance(trip, dict):
            continue
        st = trip.get("startTime")
        et = trip.get("endTime")
        if not isinstance(st, datetime):
            st = parse_timestamp(st)
        if not isinstance(et, datetime):
            et = parse_timestamp(et)
        if not st or not et:
            continue
        st = ensure_utc(st) or st
        et = ensure_utc(et) or et
        if st < start:
            continue
        if et > end:
            continue
        kept.append(trip)
    return kept


async def fetch_trips_for_window(
    client: BouncieClient,
    *,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    min_window_hours: float = MIN_WINDOW_HOURS,
    split_chunk_hours: int = SPLIT_CHUNK_HOURS,
    add_event: Callable[[str, str, dict[str, Any] | None], None] | None = None,
    chunk_semaphore: asyncio.Semaphore | None = None,
) -> list[dict[str, Any]]:
    """
    Fetch trips for a window using BouncieClient and split recursively on failure.

    Returned trips are raw Bouncie payload dictionaries.
    """
    max_span = timedelta(days=7) - timedelta(seconds=2)
    query_start = (ensure_utc(window_start) or window_start) - timedelta(seconds=1)
    query_end = ensure_utc(window_end) or window_end
    if query_end - query_start > max_span:
        query_end = query_start + max_span

    if chunk_semaphore is None:
        chunk_semaphore = asyncio.Semaphore(15)

    try:
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            async with chunk_semaphore:
                token = await client.ensure_token()
                raw_trips = await client.fetch_trips_for_device_resilient(
                    token,
                    imei,
                    query_start,
                    query_end,
                )
    except Exception as exc:
        span = window_end - window_start
        if span <= timedelta(hours=min_window_hours):
            raise

        split_size = min(
            timedelta(hours=max(min_window_hours, split_chunk_hours)),
            span / 2,
        )
        if split_size <= timedelta(0):
            raise

        sub_windows: list[tuple[datetime, datetime]] = []
        cursor = window_start
        while cursor < window_end:
            sub_end = min(cursor + split_size, window_end)
            if sub_end <= cursor:
                break
            sub_windows.append((cursor, sub_end))
            cursor = sub_end

        if len(sub_windows) < 2:
            midpoint = window_start + span / 2
            sub_windows = [
                (window_start, midpoint),
                (midpoint, window_end),
            ]

        logger.warning(
            "Window fetch failed (imei=%s, %s - %s). Splitting into %d chunks: %s",
            imei,
            window_start.isoformat(),
            window_end.isoformat(),
            len(sub_windows),
            exc,
        )
        if add_event:
            add_event(
                "warning",
                f"Splitting failing window for {imei} into {len(sub_windows)} chunks",
                {"imei": imei, "chunks": len(sub_windows)},
            )

        async def fetch_sub(sub_start: datetime, sub_end: datetime) -> list[dict[str, Any]]:
            try:
                chunk = await fetch_trips_for_window(
                    client,
                    imei=imei,
                    window_start=sub_start,
                    window_end=sub_end,
                    min_window_hours=min_window_hours,
                    split_chunk_hours=split_chunk_hours,
                    add_event=add_event,
                    chunk_semaphore=chunk_semaphore,
                )
            except Exception:
                logger.exception(
                    "Sub-window fetch failed (imei=%s, %s - %s)",
                    imei,
                    sub_start.isoformat(),
                    sub_end.isoformat(),
                )
                if add_event:
                    add_event(
                        "error",
                        f"Sub-window fetch failed for {imei}",
                        {"start": sub_start.isoformat(), "end": sub_end.isoformat()},
                    )
                return []
            if add_event and chunk:
                add_event(
                    "info",
                    f"Fetched {len(chunk)} trips from sub-chunk",
                    {
                        "imei": imei,
                        "start": sub_start.isoformat(),
                        "end": sub_end.isoformat(),
                    },
                )
            return chunk

        tasks = [fetch_sub(sub_start, sub_end) for sub_start, sub_end in sub_windows]
        results_lists = await asyncio.gather(*tasks)
        results: list[dict[str, Any]] = []
        for chunk in results_lists:
            results.extend(chunk)
        return results
    else:
        normalized_raw: list[dict[str, Any]] = []
        for trip in raw_trips:
            if not isinstance(trip, dict):
                continue
            if not trip.get("imei"):
                trip = dict(trip)
                trip["imei"] = imei
            normalized_raw.append(trip)
        return normalized_raw


def _existing_source(existing: TripStatusProjection | dict[str, Any] | None) -> str:
    if existing is None:
        return ""
    if isinstance(existing, dict):
        value = existing.get("source")
    else:
        value = getattr(existing, "source", None)
    return str(value or "").strip().lower()


def _existing_is_processed(existing: TripStatusProjection | dict[str, Any] | None) -> bool:
    if existing is None:
        return False
    if isinstance(existing, dict):
        status_value = existing.get("status")
        processing_state = existing.get("processing_state")
        matched = existing.get("matchedGps")
    else:
        status_value = getattr(existing, "status", None)
        processing_state = getattr(existing, "processing_state", None)
        matched = getattr(existing, "matchedGps", None)

    return bool(
        status_value == "processed"
        or processing_state in {"completed", "map_matched"}
        or matched is not None,
    )


def _existing_has_match(existing: TripStatusProjection | dict[str, Any] | None) -> bool:
    if existing is None:
        return False
    if isinstance(existing, dict):
        return bool(existing.get("matchedGps"))
    return bool(getattr(existing, "matchedGps", None))


async def _record_ingest_issue(
    *,
    issue_type: str,
    message: str,
    transaction_id: str | None,
    imei: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    await TripIngestIssueService.record_issue(
        issue_type=issue_type,
        message=message,
        source=BOUNCIE_SOURCE,
        transaction_id=transaction_id,
        imei=imei,
        details=details or {},
    )


async def process_bouncie_trips(
    raw_trips: list[dict[str, Any]],
    *,
    pipeline: TripPipeline,
    mode: IngestMode,
    do_map_match: bool,
    do_geocode: bool,
    do_coverage: bool,
    sync_mobility: bool,
    force_rematch_all: bool = False,
) -> dict[str, Any]:
    """
    Process Bouncie trips through a single shared ingest path.

    Returns:
        {"processed_transaction_ids": [...], "counters": {...}}
    """
    counters = build_ingest_counters()
    counters["found_raw"] = len([t for t in raw_trips if isinstance(t, dict)])
    processed_transaction_ids: list[str] = []

    normalized = [
        normalize_rest_trip_payload(t) for t in raw_trips if isinstance(t, dict)
    ]
    unique_trips = dedupe_trips_by_transaction_id(normalized)
    counters["found_unique"] = len(unique_trips)

    candidates: list[dict[str, Any]] = []
    for trip in unique_trips:
        tx = str(trip.get("transactionId") or "").strip()
        if not tx:
            continue
        if not trip.get("endTime"):
            counters["validation_failed"] += 1
            await _record_ingest_issue(
                issue_type="validation_failed",
                message="Missing endTime",
                transaction_id=tx,
                imei=str(trip.get("imei") or "") or None,
                details={"transactionId": tx, "imei": trip.get("imei")},
            )
            continue
        candidates.append(trip)

    incoming_ids = [
        str(t.get("transactionId") or "").strip()
        for t in candidates
        if str(t.get("transactionId") or "").strip()
    ]
    existing_docs = (
        await Trip.find(In(Trip.transactionId, incoming_ids))
        .project(TripStatusProjection)
        .to_list()
        if incoming_ids
        else []
    )
    existing_by_id: dict[str, TripStatusProjection] = {}
    for doc in existing_docs:
        tx = str(getattr(doc, "transactionId", "") or "").strip()
        if tx:
            existing_by_id[tx] = doc

    for trip in candidates:
        tx = str(trip.get("transactionId") or "").strip()
        imei = str(trip.get("imei") or "").strip() or None
        existing = existing_by_id.get(tx)
        source_value = _existing_source(existing)

        if existing and source_value and source_value != BOUNCIE_SOURCE:
            counters["skipped_conflicting_source"] += 1
            await _record_ingest_issue(
                issue_type="conflicting_existing_source",
                message="Existing trip row has non-bouncie source",
                transaction_id=tx,
                imei=imei,
                details={
                    "transactionId": tx,
                    "imei": imei,
                    "existing_source": source_value,
                    "requested_source": BOUNCIE_SOURCE,
                },
            )
            continue

        if existing and mode == "insert_only":
            counters["skipped_existing"] += 1
            continue

        needs_processing = True
        if existing and mode == "upsert_bouncie":
            already_processed = _existing_is_processed(existing)
            has_match = _existing_has_match(existing)
            needs_geocode_repair = bool(
                do_geocode
                and not (
                    TripPipeline._has_meaningful_location(
                        getattr(existing, "startLocation", None),
                    )
                    and TripPipeline._has_meaningful_location(
                        getattr(existing, "destination", None),
                    )
                ),
            )
            needs_processing = (
                not already_processed
                or force_rematch_all
                or (do_map_match and not has_match)
                or needs_geocode_repair
            )
            if not needs_processing:
                counters["skipped_existing"] += 1
                continue

        validation = await pipeline.validate_raw_trip_with_basic(trip)
        if not validation.get("success"):
            counters["validation_failed"] += 1
            reason = (
                (validation.get("processing_status") or {})
                .get("errors", {})
                .get("validation")
            )
            await _record_ingest_issue(
                issue_type="validation_failed",
                message=str(reason),
                transaction_id=tx,
                imei=imei,
                details={"transactionId": tx, "imei": imei, "reason": reason},
            )
            continue

        processing_status = validation.get("processing_status") or {}
        validated_trip_data = validation.get("processed_data")
        if not isinstance(validated_trip_data, dict):
            validated_trip_data = None

        try:
            saved = await pipeline.process_raw_trip(
                trip,
                source=BOUNCIE_SOURCE,
                do_map_match=do_map_match,
                do_geocode=do_geocode,
                do_coverage=do_coverage,
                prevalidated_data=validated_trip_data,
                prevalidated_history=processing_status.get("history"),
                prevalidated_state=processing_status.get("state"),
                sync_mobility=sync_mobility,
            )
        except Exception as exc:
            if is_duplicate_trip_error(exc):
                existing_after = await Trip.find_one(Trip.transactionId == tx)
                if existing_after and str(existing_after.source or "").strip().lower() == BOUNCIE_SOURCE:
                    processed_transaction_ids.append(tx)
                    counters["updated"] += 1
                    continue
                if existing_after:
                    counters["skipped_conflicting_source"] += 1
                    await _record_ingest_issue(
                        issue_type="conflicting_existing_source",
                        message="Duplicate race resolved to non-bouncie source",
                        transaction_id=tx,
                        imei=imei,
                        details={
                            "transactionId": tx,
                            "imei": imei,
                            "existing_source": getattr(existing_after, "source", None),
                        },
                    )
                    continue

            counters["process_errors"] += 1
            await _record_ingest_issue(
                issue_type="process_error",
                message=str(exc),
                transaction_id=tx,
                imei=imei,
                details={"transactionId": tx, "imei": imei, "error": str(exc)},
            )
            continue

        if not saved or not getattr(saved, "id", None):
            counters["process_errors"] += 1
            await _record_ingest_issue(
                issue_type="process_error",
                message="Trip processing returned no saved record",
                transaction_id=tx,
                imei=imei,
                details={"transactionId": tx, "imei": imei},
            )
            continue

        processed_transaction_ids.append(tx)
        if existing:
            counters["updated"] += 1
        else:
            counters["inserted"] += 1

    return {
        "processed_transaction_ids": processed_transaction_ids,
        "counters": counters,
    }


async def _resolve_geocode_preference() -> bool:
    app_settings = await AdminService.get_persisted_app_settings()
    return bool(app_settings.model_dump().get("geocodeTripsOnFetch", True))


async def _resolve_force_google_rematch(do_map_match: bool) -> bool:
    if not do_map_match:
        return False
    app_settings = await AdminService.get_persisted_app_settings()
    provider = str(getattr(app_settings, "map_provider", "") or "").strip().lower()
    return provider == "google"


async def run_ingest_for_range(
    *,
    start_dt: datetime,
    end_dt: datetime,
    mode: IngestMode,
    do_map_match: bool = False,
    do_geocode: bool | None = None,
    do_coverage: bool = False,
    sync_mobility: bool = True,
    selected_imeis: list[str] | None = None,
    progress_tracker: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run range ingest for all eligible devices."""
    counters = build_ingest_counters()
    processed_ids: list[str] = []

    credentials = await get_bouncie_config()
    imeis = list(credentials.get("authorized_devices") or [])
    if selected_imeis is not None:
        selected = {str(v or "").strip() for v in selected_imeis if str(v or "").strip()}
        imeis = [imei for imei in imeis if str(imei or "").strip() in selected]
    imeis = [str(imei or "").strip() for imei in imeis if str(imei or "").strip()]

    if not imeis:
        return {"processed_transaction_ids": [], "counters": counters}

    session = await get_session()
    token = await BouncieOAuth.get_access_token(session, credentials)
    if not token:
        return {"processed_transaction_ids": [], "counters": counters}

    if do_geocode is None:
        do_geocode = await _resolve_geocode_preference()
    force_rematch_all = await _resolve_force_google_rematch(do_map_match)

    fetch_concurrency = credentials.get("fetch_concurrency", 12)
    if not isinstance(fetch_concurrency, int) or fetch_concurrency < 1:
        fetch_concurrency = 12
    semaphore = asyncio.Semaphore(fetch_concurrency)

    pipeline = TripPipeline()
    client = BouncieClient(session, credentials=credentials)

    chunk_windows: list[tuple[str, datetime, datetime]] = []
    for imei in imeis:
        current_start = start_dt
        while current_start < end_dt:
            current_end = min(current_start + timedelta(days=7), end_dt)
            chunk_windows.append((imei, current_start, current_end))
            current_start = current_end

    total_chunks = max(1, len(chunk_windows))
    completed_chunks = 0
    lock = asyncio.Lock()

    async def process_chunk(imei: str, window_start: datetime, window_end: datetime) -> None:
        nonlocal completed_chunks
        chunk_result: dict[str, Any] | None = None
        try:
            async with semaphore:
                raw = await fetch_trips_for_window(
                    client,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                )
                raw = filter_trips_to_window(
                    raw,
                    window_start=window_start,
                    window_end=window_end,
                )
                chunk_result = await process_bouncie_trips(
                    raw,
                    pipeline=pipeline,
                    mode=mode,
                    do_map_match=do_map_match,
                    do_geocode=bool(do_geocode),
                    do_coverage=do_coverage,
                    sync_mobility=sync_mobility,
                    force_rematch_all=force_rematch_all,
                )
        except Exception as exc:
            counters["fetch_errors"] += 1
            await _record_ingest_issue(
                issue_type="fetch_error",
                message=str(exc),
                transaction_id=None,
                imei=imei,
                details={
                    "imei": imei,
                    "window_start": window_start.isoformat(),
                    "window_end": window_end.isoformat(),
                    "error": str(exc),
                },
            )
            logger.exception(
                "Bouncie range ingest chunk failed (imei=%s, %s - %s)",
                imei,
                window_start.isoformat(),
                window_end.isoformat(),
            )
        else:
            if chunk_result:
                merge_ingest_counters(counters, chunk_result["counters"])
                processed_ids.extend(chunk_result["processed_transaction_ids"])
        finally:
            async with lock:
                completed_chunks += 1
                if progress_tracker is not None:
                    progress_section = progress_tracker.setdefault("fetch_and_store_trips", {})
                    progress_section["status"] = "running"
                    progress_section["progress"] = (completed_chunks / total_chunks) * 100
                    progress_section["message"] = (
                        f"Processed {completed_chunks}/{total_chunks} chunks"
                    )

    await asyncio.gather(
        *(process_chunk(imei, s, e) for imei, s, e in chunk_windows),
    )

    return {
        "processed_transaction_ids": list(dict.fromkeys(processed_ids)),
        "counters": counters,
    }


async def run_ingest_for_transaction_id(
    *,
    transaction_id: str,
    mode: IngestMode = "upsert_bouncie",
    do_map_match: bool = False,
    do_geocode: bool | None = None,
    do_coverage: bool = True,
    sync_mobility: bool = True,
) -> dict[str, Any]:
    """Fetch and process trips by transaction-id through shared ingest path."""
    counters = build_ingest_counters()
    tx = str(transaction_id or "").strip()
    if not tx:
        return {"processed_transaction_ids": [], "counters": counters}

    credentials = await get_bouncie_config()
    session = await get_session()
    token = await BouncieOAuth.get_access_token(session, credentials)
    if not token:
        return {"processed_transaction_ids": [], "counters": counters}

    if do_geocode is None:
        do_geocode = await _resolve_geocode_preference()
    force_rematch_all = await _resolve_force_google_rematch(do_map_match)

    client = BouncieClient(session, credentials=credentials)
    raw = await client.fetch_trip_by_transaction_id(token, tx)
    result = await process_bouncie_trips(
        raw,
        pipeline=TripPipeline(),
        mode=mode,
        do_map_match=do_map_match,
        do_geocode=bool(do_geocode),
        do_coverage=do_coverage,
        sync_mobility=sync_mobility,
        force_rematch_all=force_rematch_all,
    )
    merge_ingest_counters(counters, result["counters"])
    return {
        "processed_transaction_ids": result["processed_transaction_ids"],
        "counters": counters,
    }


__all__ = [
    "COUNTER_KEYS",
    "IngestMode",
    "build_ingest_counters",
    "dedupe_trips_by_transaction_id",
    "fetch_trips_for_window",
    "filter_trips_to_window",
    "is_duplicate_trip_error",
    "merge_ingest_counters",
    "process_bouncie_trips",
    "run_ingest_for_range",
    "run_ingest_for_transaction_id",
]
