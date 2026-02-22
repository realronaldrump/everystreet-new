"""Trip normalization/validation/insert helpers for history import."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from beanie.operators import In

from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip
from trips.models import TripStatusProjection
from trips.services.trip_ingest_issue_service import TripIngestIssueService

if TYPE_CHECKING:
    from trips.services.trip_history_import_service_runtime import ImportRuntime


def _collect_unique_window_trips(
    raw_trips: list[dict[str, Any]],
    *,
    seen_transaction_ids: set[str],
    counters: dict[str, int],
) -> list[dict[str, Any]]:
    unique_trips: list[dict[str, Any]] = []
    for trip in raw_trips:
        tx = trip.get("transactionId")
        if not isinstance(tx, str) or not tx:
            continue
        if tx in seen_transaction_ids:
            continue
        if not trip.get("endTime"):
            counters["skipped_missing_end_time"] += 1
            continue
        seen_transaction_ids.add(tx)
        unique_trips.append(trip)
    counters["found_unique"] += len(unique_trips)
    return unique_trips


def _record_per_device_unique_counts(
    unique_trips: list[dict[str, Any]],
    per_device: dict[str, dict[str, int]],
) -> None:
    for trip in unique_trips:
        imei = trip.get("imei")
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["found_unique"] += 1


async def _load_existing_transaction_ids(
    unique_trips: list[dict[str, Any]],
) -> set[str]:
    incoming_ids = [
        t.get("transactionId") for t in unique_trips if t.get("transactionId")
    ]
    existing_docs = (
        await Trip.find(In(Trip.transactionId, incoming_ids))
        .project(TripStatusProjection)
        .to_list()
    )
    return {
        doc.transactionId
        for doc in existing_docs
        if getattr(doc, "transactionId", None)
        and str(getattr(doc, "source", "") or "").strip().lower() == BOUNCIE_SOURCE
    }


def _collect_new_trips(
    *,
    unique_trips: list[dict[str, Any]],
    existing_ids: set[str],
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
) -> list[dict[str, Any]]:
    new_trips: list[dict[str, Any]] = []
    for trip in unique_trips:
        tx = trip.get("transactionId")
        if not isinstance(tx, str) or not tx:
            continue
        imei = trip.get("imei")
        if tx in existing_ids:
            counters["skipped_existing"] += 1
            if isinstance(imei, str) and imei in per_device:
                per_device[imei]["skipped_existing"] += 1
            continue
        counters["new_candidates"] += 1
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["new_candidates"] += 1
        new_trips.append(trip)
    return new_trips


async def _record_validation_failure(
    *,
    validation: dict[str, Any],
    tx: str,
    imei: str | None,
    window_index: int,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    record_failure_reason: Callable[[str | None], None],
) -> None:
    counters["validation_failed"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["validation_failed"] += 1
    reason = (
        (validation.get("processing_status") or {}).get("errors", {}).get("validation")
    )
    add_event(
        "error",
        f"Trip failed validation ({tx})",
        {
            "transactionId": tx,
            "imei": imei,
            "reason": reason,
            "window_index": window_index,
        },
    )
    record_failure_reason(str(reason))
    await TripIngestIssueService.record_issue(
        issue_type="validation_failed",
        message=str(reason),
        source="bouncie",
        transaction_id=str(tx) if tx else None,
        imei=imei if isinstance(imei, str) else None,
        details={
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
            "reason": reason,
        },
    )


async def _record_process_failure(
    *,
    exc: Exception,
    tx: str,
    imei: str | None,
    window_index: int,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
    add_event: Callable[[str, str, dict[str, Any] | None], None],
    record_failure_reason: Callable[[str | None], None],
) -> None:
    counters["process_errors"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["errors"] += 1
    add_event(
        "error",
        f"Failed processing trip {tx}",
        {
            "error": str(exc),
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
        },
    )
    record_failure_reason(str(exc))
    await TripIngestIssueService.record_issue(
        issue_type="process_error",
        message=str(exc),
        source="bouncie",
        transaction_id=str(tx) if tx else None,
        imei=imei if isinstance(imei, str) else None,
        details={
            "transactionId": tx,
            "imei": imei,
            "window_index": window_index,
            "error": str(exc),
        },
    )


def _update_insert_result_counters(
    *,
    inserted: bool,
    imei: str | None,
    counters: dict[str, int],
    per_device: dict[str, dict[str, int]],
) -> None:
    if inserted:
        counters["inserted"] += 1
        if isinstance(imei, str) and imei in per_device:
            per_device[imei]["inserted"] += 1
        return
    counters["skipped_existing"] += 1
    if isinstance(imei, str) and imei in per_device:
        per_device[imei]["skipped_existing"] += 1


async def _process_new_trips_batch(
    *,
    runtime: ImportRuntime,
    new_trips: list[dict[str, Any]],
    window_index: int,
    windows_completed: int,
    current_window: dict[str, Any],
) -> bool:
    processed_count = 0
    for trip in new_trips:
        if (
            processed_count
            and processed_count % 25 == 0
            and await runtime.is_cancelled()
        ):
            return True

        tx = str(trip.get("transactionId") or "unknown")
        imei = trip.get("imei")
        validation = await runtime.pipeline.validate_raw_trip_with_basic(trip)
        if not validation.get("success"):
            await _record_validation_failure(
                validation=validation,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
                counters=runtime.counters,
                per_device=runtime.per_device,
                add_event=runtime.add_event,
                record_failure_reason=runtime.record_failure_reason,
            )
            processed_count += 1
            await _write_window_insert_progress(
                runtime=runtime,
                processed_count=processed_count,
                total=len(new_trips),
                window_index=window_index,
                windows_completed=windows_completed,
                current_window=current_window,
            )
            continue

        try:
            processing_status = validation.get("processing_status") or {}
            validated_trip_data = validation.get("processed_data")
            if not isinstance(validated_trip_data, dict):
                validated_trip_data = None
            inserted = await runtime.pipeline.process_raw_trip(
                trip,
                source="bouncie",
                do_map_match=False,
                do_geocode=runtime.do_geocode,
                do_coverage=runtime.do_coverage,
                prevalidated_data=validated_trip_data,
                prevalidated_history=processing_status.get("history"),
                prevalidated_state=processing_status.get("state"),
                sync_mobility=False,
            )
        except Exception as exc:
            await _record_process_failure(
                exc=exc,
                tx=tx,
                imei=imei if isinstance(imei, str) else None,
                window_index=window_index,
                counters=runtime.counters,
                per_device=runtime.per_device,
                add_event=runtime.add_event,
                record_failure_reason=runtime.record_failure_reason,
            )
        else:
            _update_insert_result_counters(
                inserted=bool(inserted),
                imei=imei if isinstance(imei, str) else None,
                counters=runtime.counters,
                per_device=runtime.per_device,
            )

        processed_count += 1
        await _write_window_insert_progress(
            runtime=runtime,
            processed_count=processed_count,
            total=len(new_trips),
            window_index=window_index,
            windows_completed=windows_completed,
            current_window=current_window,
        )

    return False


async def _write_window_insert_progress(
    *,
    runtime: ImportRuntime,
    processed_count: int,
    total: int,
    window_index: int,
    windows_completed: int,
    current_window: dict[str, Any],
) -> None:
    if processed_count % 5 != 0 and processed_count != total:
        return
    within = processed_count / max(1, total)
    overall = ((window_index - 1) + (0.4 + (0.6 * within))) / max(
        1,
        runtime.windows_total,
    )
    await runtime.write_progress(
        status="running",
        stage="processing",
        message=(
            f"Inserted {processed_count}/{total} trips "
            f"(window {window_index}/{runtime.windows_total})"
        ),
        progress=min(99.0, overall * 100.0),
        current_window=current_window,
        windows_completed=windows_completed,
    )


__all__ = [
    "_collect_new_trips",
    "_collect_unique_window_trips",
    "_load_existing_transaction_ids",
    "_process_new_trips_batch",
    "_record_per_device_unique_counts",
    "_record_process_failure",
    "_record_validation_failure",
    "_update_insert_result_counters",
    "_write_window_insert_progress",
]
