"""
Webhook processing task.

This module provides the Celery task for processing Bouncie webhook
events asynchronously, including trip start, data, metrics, and end
events.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger

from core.async_bridge import run_async_from_sync
from live_tracking import (
    process_trip_data,
    process_trip_end,
    process_trip_metrics,
    process_trip_start,
)

logger = get_task_logger(__name__)


@shared_task(
    bind=True,
    name="tasks.process_webhook_event_task",
    max_retries=3,
    default_retry_delay=90,
    time_limit=300,
    soft_time_limit=240,
    acks_late=True,
    queue="default",
)
def process_webhook_event_task(self, data: dict[str, Any]) -> dict[str, Any]:
    """
    Celery task to process Bouncie webhook data asynchronously.

    Obtains DB collections reliably at the start of execution via db_manager.

    Note: This is NOT an async function and does NOT use the task_runner decorator.
    """
    task_name = "process_webhook_event_task"
    celery_task_id = self.request.id
    start_time = datetime.now(UTC)
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")

    logger.info(
        "Celery Task %s (%s) started processing webhook: Type=%s, TransactionID=%s",
        task_name,
        celery_task_id,
        event_type or "Unknown",
        transaction_id or "N/A",
    )

    try:
        # We rely on Beanie initialization being done at app startup / celery worker startup
        if not event_type:
            logger.error(
                "Task %s: Missing eventType in webhook data: %s",
                celery_task_id,
                data,
            )
            return {"status": "error", "message": "Missing eventType"}

        if (
            event_type in ("tripStart", "tripData", "tripMetrics", "tripEnd")
            and not transaction_id
        ):
            logger.error(
                "Task %s: Missing transactionId for required event type %s: %s",
                celery_task_id,
                event_type,
                data,
            )
            return {
                "status": "error",
                "message": f"Missing transactionId for {event_type}",
            }

        if event_type == "tripStart":
            run_async_from_sync(process_trip_start(data))
        elif event_type == "tripData":
            run_async_from_sync(process_trip_data(data))
        elif event_type == "tripMetrics":
            run_async_from_sync(process_trip_metrics(data))
        elif event_type == "tripEnd":
            run_async_from_sync(process_trip_end(data))
        elif event_type in ("connect", "disconnect", "battery", "mil"):
            logger.info(
                "Task %s: Received non-trip event type: %s. Ignoring. Payload: %s",
                celery_task_id,
                event_type,
                data,
            )
        else:
            logger.warning(
                "Task %s: Received unknown event type: %s. Payload: %s",
                celery_task_id,
                event_type,
                data,
            )

        end_time = datetime.now(UTC)
        runtime = (end_time - start_time).total_seconds() * 1000
        logger.info(
            "Celery Task %s (%s) successfully processed webhook: "
            "Type=%s, TransactionID=%s in %.0fms",
            task_name,
            celery_task_id,
            event_type,
            transaction_id or "N/A",
            runtime,
        )
        return {"status": "success", "message": "Event processed successfully"}

    except Exception as e:
        end_time = datetime.now(UTC)
        runtime = (end_time - start_time).total_seconds() * 1000
        error_msg = (
            f"Unhandled error processing webhook event "
            f"{event_type or 'Unknown'} (TxID: {transaction_id or 'N/A'})"
        )
        logger.exception(
            "Celery Task %s (%s) FAILED processing webhook: %s. Runtime: %.0fms",
            task_name,
            celery_task_id,
            error_msg,
            runtime,
            exc_info=e,
        )
        if (
            hasattr(self, "request")
            and hasattr(self.request, "retries")
            and hasattr(self, "default_retry_delay")
        ):
            countdown = int(self.default_retry_delay * (2**self.request.retries))
            logger.info(
                "Retrying task %s in %d seconds due to generic error: %s",
                celery_task_id,
                countdown,
                e,
            )
            try:
                raise self.retry(exc=e, countdown=countdown)
            except Exception as retry_exc:
                logger.critical(
                    "Failed to *initiate* retry for task %s after generic error: %s",
                    celery_task_id,
                    retry_exc,
                )
                raise e from retry_exc
        else:
            logger.exception(
                "Cannot retry task %s for generic error as Celery retry "
                "context is missing.",
                celery_task_id,
            )
            raise

    return {"status": "error", "message": "Unknown error (unreachable)"}
