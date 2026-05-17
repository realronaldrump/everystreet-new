"""Shared Bouncie historical ingest runtime."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
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
from core.trip_map_cache import bump_trip_map_revision
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip
from setup.services.bouncie_oauth import BouncieOAuth
from trips.models import TripStatusProjection
from trips.pipeline import TripPipeline
from trips.services.historical_trip_writer import (
    BouncieHistoricalTripWriter,
    HistoricalTripWrite,
)
from trips.services.trip_history_import_service_config import (
    MIN_WINDOW_HOURS,
    RECOVERY_MIN_WINDOW_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    SPLIT_CHUNK_HOURS,
    SPLIT_CONCURRENCY,
    build_import_windows,
)
from trips.services.trip_ingest_issue_service import TripIngestIssueService

logger = logging.getLogger(__name__)

IngestMode = Literal["insert_only", "upsert_bouncie"]


@dataclass(frozen=True)
class FailedFetchWindow:
    """A Bouncie window that still failed at the recovery floor."""

    imei: str
    window_start: datetime
    window_end: datetime
    error: str

    def event_data(self) -> dict[str, str]:
        return {
            "imei": self.imei,
            "start": self.window_start.isoformat(),
            "end": self.window_end.isoformat(),
            "error": self.error,
        }


@dataclass
class WindowFetchResult:
    """Trips recovered from one requested window plus any unrecoverable slices."""

    trips: list[dict[str, Any]] = field(default_factory=list)
    failed_windows: list[FailedFetchWindow] = field(default_factory=list)


class WindowFetchIncompleteError(RuntimeError):
    """Raised by the list-returning wrapper on partial fetch failure."""

    def __init__(self, result: WindowFetchResult) -> None:
        self.result = result
        count = len(result.failed_windows)
        super().__init__(f"Unable to fetch {count} Bouncie sub-window(s)")


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


def ingest_counters_changed_trips(counters: dict[str, int]) -> bool:
    """Return whether ingest counters represent persisted trip changes."""
    return (
        int(counters.get("inserted", 0) or 0) > 0
        or int(counters.get("updated", 0) or 0) > 0
    )


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
    """Keep trips that overlap a request window."""
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
        if et < start:
            continue
        if st > end:
            continue
        kept.append(trip)
    return kept


def _normalize_raw_trips(
    raw_trips: list[dict[str, Any]], *, imei: str
) -> list[dict[str, Any]]:
    normalized_raw: list[dict[str, Any]] = []
    for trip in raw_trips:
        if not isinstance(trip, dict):
            continue
        if not trip.get("imei"):
            trip = dict(trip)
            trip["imei"] = imei
        normalized_raw.append(trip)
    return normalized_raw


def _safe_error_text(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    text = text.replace("\n", " ").replace("\r", " ")
    if len(text) > 240:
        text = text[:237] + "..."
    return text


def _build_sub_windows(
    window_start: datetime,
    window_end: datetime,
    *,
    split_size: timedelta,
) -> list[tuple[datetime, datetime]]:
    sub_windows: list[tuple[datetime, datetime]] = []
    cursor = window_start
    while cursor < window_end:
        sub_end = min(cursor + split_size, window_end)
        if sub_end <= cursor:
            break
        sub_windows.append((cursor, sub_end))
        cursor = sub_end
    return sub_windows


def _choose_recovery_split_size(
    span: timedelta,
    *,
    min_window: timedelta,
    split_chunk: timedelta,
    recovery_floor: timedelta,
) -> timedelta:
    if span <= min_window:
        return max(recovery_floor, span / 2)
    return min(split_chunk, span / 2)


def summarize_failed_fetch_windows(
    failed_windows: list[FailedFetchWindow],
    *,
    sample_size: int = 5,
) -> dict[str, Any]:
    """Build a compact, serializable summary for progress metadata/events."""
    if not failed_windows:
        return {"count": 0, "samples": []}
    starts = [w.window_start for w in failed_windows]
    ends = [w.window_end for w in failed_windows]
    return {
        "count": len(failed_windows),
        "first_start": min(starts).isoformat(),
        "last_end": max(ends).isoformat(),
        "samples": [w.event_data() for w in failed_windows[:sample_size]],
    }


async def fetch_trips_for_window_report(
    client: BouncieClient,
    *,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    min_window_hours: float = MIN_WINDOW_HOURS,
    recovery_min_window_seconds: int = RECOVERY_MIN_WINDOW_SECONDS,
    split_chunk_hours: int = SPLIT_CHUNK_HOURS,
    add_event: Callable[[str, str, dict[str, Any] | None], None] | None = None,
    chunk_semaphore: asyncio.Semaphore | None = None,
) -> WindowFetchResult:
    """
    Fetch trips for a window and aggressively recover around failing slices.

    Bouncie can return 500/timeouts for old ranges even when neighboring
    minute-scale ranges are valid. This routine splits only after a failure,
    keeps every recovered successful slice, and returns unrecoverable leaf
    slices for the caller to report as fetch errors.
    """
    max_span = timedelta(days=7) - timedelta(seconds=2)
    if chunk_semaphore is None:
        chunk_semaphore = asyncio.Semaphore(SPLIT_CONCURRENCY)

    recovery_floor = timedelta(seconds=max(1, recovery_min_window_seconds))
    min_window = timedelta(hours=max(min_window_hours, 0))
    split_chunk = timedelta(hours=max(min_window_hours, split_chunk_hours))

    async def fetch_once(start: datetime, end: datetime) -> list[dict[str, Any]]:
        query_start = (ensure_utc(start) or start) - timedelta(seconds=1)
        query_end = ensure_utc(end) or end
        if query_end - query_start > max_span:
            query_end = query_start + max_span
        async with asyncio.timeout(REQUEST_TIMEOUT_SECONDS):
            async with chunk_semaphore:
                token = await client.ensure_token()
                raw_trips = await client.fetch_trips_for_device_resilient(
                    token,
                    imei,
                    query_start,
                    query_end,
                )
        return _normalize_raw_trips(raw_trips, imei=imei)

    async def fetch_recovering(start: datetime, end: datetime) -> WindowFetchResult:
        start = ensure_utc(start) or start
        end = ensure_utc(end) or end
        try:
            return WindowFetchResult(trips=await fetch_once(start, end))
        except Exception as exc:
            span = end - start
            if span <= recovery_floor:
                failure = FailedFetchWindow(
                    imei=imei,
                    window_start=start,
                    window_end=end,
                    error=_safe_error_text(exc),
                )
                logger.exception(
                    "Bouncie recovery leaf failed (imei=%s, %s - %s)",
                    imei,
                    start.isoformat(),
                    end.isoformat(),
                )
                if add_event:
                    add_event(
                        "error",
                        f"Unrecoverable Bouncie slice for {imei}",
                        failure.event_data(),
                    )
                return WindowFetchResult(failed_windows=[failure])

            split_size = _choose_recovery_split_size(
                span,
                min_window=min_window,
                split_chunk=split_chunk,
                recovery_floor=recovery_floor,
            )
            if split_size <= timedelta(0):
                failure = FailedFetchWindow(
                    imei=imei,
                    window_start=start,
                    window_end=end,
                    error=_safe_error_text(exc),
                )
                return WindowFetchResult(failed_windows=[failure])

            sub_windows = _build_sub_windows(
                start,
                end,
                split_size=split_size,
            )
            if len(sub_windows) < 2:
                midpoint = start + span / 2
                sub_windows = [(start, midpoint), (midpoint, end)]

            logger.warning(
                "Window fetch failed (imei=%s, %s - %s). Splitting into %d chunks: %s",
                imei,
                start.isoformat(),
                end.isoformat(),
                len(sub_windows),
                exc,
            )
            if add_event:
                add_event(
                    "warning",
                    f"Splitting failing window for {imei} into {len(sub_windows)} chunks",
                    {
                        "imei": imei,
                        "start": start.isoformat(),
                        "end": end.isoformat(),
                        "chunks": len(sub_windows),
                        "error": _safe_error_text(exc),
                    },
                )

            child_results = await asyncio.gather(
                *[
                    fetch_recovering(sub_start, sub_end)
                    for sub_start, sub_end in sub_windows
                ],
            )
            merged = WindowFetchResult()
            for child in child_results:
                merged.trips.extend(child.trips)
                merged.failed_windows.extend(child.failed_windows)
            return merged

    result = await fetch_recovering(window_start, window_end)
    if add_event and result.trips:
        add_event(
            "info",
            f"Fetched {len(result.trips)} trips from recovered window",
            {
                "imei": imei,
                "start": (ensure_utc(window_start) or window_start).isoformat(),
                "end": (ensure_utc(window_end) or window_end).isoformat(),
                "failed_slices": len(result.failed_windows),
            },
        )
    return result


async def fetch_trips_for_window(
    client: BouncieClient,
    *,
    imei: str,
    window_start: datetime,
    window_end: datetime,
    min_window_hours: float = MIN_WINDOW_HOURS,
    recovery_min_window_seconds: int = RECOVERY_MIN_WINDOW_SECONDS,
    split_chunk_hours: int = SPLIT_CHUNK_HOURS,
    add_event: Callable[[str, str, dict[str, Any] | None], None] | None = None,
    chunk_semaphore: asyncio.Semaphore | None = None,
) -> list[dict[str, Any]]:
    """Return trips as a list, raising if any leaf slices remain unavailable."""
    result = await fetch_trips_for_window_report(
        client,
        imei=imei,
        window_start=window_start,
        window_end=window_end,
        min_window_hours=min_window_hours,
        recovery_min_window_seconds=recovery_min_window_seconds,
        split_chunk_hours=split_chunk_hours,
        add_event=add_event,
        chunk_semaphore=chunk_semaphore,
    )
    if result.failed_windows:
        raise WindowFetchIncompleteError(result)
    return result.trips


def _existing_source(existing: TripStatusProjection | dict[str, Any] | None) -> str:
    if existing is None:
        return ""
    if isinstance(existing, dict):
        value = existing.get("source")
    else:
        value = getattr(existing, "source", None)
    return str(value or "").strip().lower()


def _existing_is_processed(
    existing: TripStatusProjection | dict[str, Any] | None,
) -> bool:
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
    bump_revision: bool = True,
) -> dict[str, Any]:
    """
    Process Bouncie trips through a single shared ingest path.

    Returns:
        {"processed_transaction_ids": [...], "counters": {...}}
    """
    counters = build_ingest_counters()
    counters["found_raw"] = len([t for t in raw_trips if isinstance(t, dict)])
    processed_transaction_ids: list[str] = []
    writer = BouncieHistoricalTripWriter(pipeline)

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
            saved = await writer.write(
                HistoricalTripWrite(
                    raw_data=trip,
                    do_map_match=do_map_match,
                    do_geocode=do_geocode,
                    do_coverage=do_coverage,
                    prevalidated_data=validated_trip_data,
                    prevalidated_history=processing_status.get("history") or [],
                    prevalidated_state=processing_status.get("state"),
                    sync_mobility=sync_mobility,
                    bump_revision=bump_revision,
                ),
            )
        except Exception as exc:
            if is_duplicate_trip_error(exc):
                existing_after = await Trip.find_one(Trip.transactionId == tx)
                if (
                    existing_after
                    and str(existing_after.source or "").strip().lower()
                    == BOUNCIE_SOURCE
                ):
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
        selected = {
            str(v or "").strip() for v in selected_imeis if str(v or "").strip()
        }
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
        for window_start, window_end in build_import_windows(start_dt, end_dt):
            chunk_windows.append((imei, window_start, window_end))

    total_chunks = max(1, len(chunk_windows))
    completed_chunks = 0
    lock = asyncio.Lock()

    async def process_chunk(
        imei: str, window_start: datetime, window_end: datetime
    ) -> None:
        nonlocal completed_chunks
        chunk_result: dict[str, Any] | None = None
        try:
            async with semaphore:
                fetch_result = await fetch_trips_for_window_report(
                    client,
                    imei=imei,
                    window_start=window_start,
                    window_end=window_end,
                )
                raw = fetch_result.trips
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
                    bump_revision=False,
                )
                if fetch_result.failed_windows:
                    failed_count = len(fetch_result.failed_windows)
                    counters["fetch_errors"] += failed_count
                    await _record_ingest_issue(
                        issue_type="fetch_error",
                        message=(
                            "Bouncie fetch partially failed after adaptive recovery"
                        ),
                        transaction_id=None,
                        imei=imei,
                        details={
                            "imei": imei,
                            "window_start": window_start.isoformat(),
                            "window_end": window_end.isoformat(),
                            **summarize_failed_fetch_windows(
                                fetch_result.failed_windows,
                            ),
                        },
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
                    progress_section = progress_tracker.setdefault(
                        "fetch_and_store_trips", {}
                    )
                    progress_section["status"] = "running"
                    progress_section["progress"] = (
                        completed_chunks / total_chunks
                    ) * 100
                    progress_section["message"] = (
                        f"Processed {completed_chunks}/{total_chunks} chunks"
                    )

    await asyncio.gather(
        *(process_chunk(imei, s, e) for imei, s, e in chunk_windows),
    )

    if ingest_counters_changed_trips(counters):
        await bump_trip_map_revision()

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
    "FailedFetchWindow",
    "IngestMode",
    "WindowFetchIncompleteError",
    "WindowFetchResult",
    "build_ingest_counters",
    "dedupe_trips_by_transaction_id",
    "fetch_trips_for_window",
    "fetch_trips_for_window_report",
    "filter_trips_to_window",
    "ingest_counters_changed_trips",
    "is_duplicate_trip_error",
    "merge_ingest_counters",
    "process_bouncie_trips",
    "run_ingest_for_range",
    "run_ingest_for_transaction_id",
    "summarize_failed_fetch_windows",
]
