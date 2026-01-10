"""Webhook processing task.

This module provides the Celery task for processing Bouncie webhook events
asynchronously, including trip start, data, metrics, and end events.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from celery import shared_task
from celery.utils.log import get_task_logger
from pymongo.errors import ConnectionFailure

from db import db_manager
from live_tracking import (
    process_trip_data,
    process_trip_end,
    process_trip_metrics,
    process_trip_start,
)
from utils import run_async_from_sync

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
    """Celery task to process Bouncie webhook data asynchronously.

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

    live_collection = None

    try:
        logger.debug(
            "Task %s: Attempting to get DB collections via db_manager.",
            celery_task_id,
        )
        _ = db_manager.client
        if not db_manager.connection_healthy:
            logger.warning(
                "Task %s: DB Manager connection unhealthy, attempting re-init.",
                celery_task_id,
            )
            db_manager.ensure_connection()
            if not db_manager.connection_healthy:
                logger.critical(
                    "Task %s: DB Manager re-initialization failed.",
                    celery_task_id,
                )
                raise ConnectionFailure(
                    "DB Manager connection unhealthy after re-init attempt.",
                )

        live_collection = db_manager.get_collection("live_trips")

        if live_collection is None:
            logger.critical(
                "Task %s: Failed to obtain required DB collection "
                "('live_trips') via db_manager.",
                celery_task_id,
            )
            raise ConnectionFailure("Failed to obtain DB collection via db_manager.")

        logger.debug("Task %s: Successfully obtained DB collections.", celery_task_id)

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
            run_async_from_sync(process_trip_start(data, live_collection))
        elif event_type == "tripData":
            run_async_from_sync(process_trip_data(data, live_collection))
        elif event_type == "tripMetrics":
            run_async_from_sync(process_trip_metrics(data, live_collection))
        elif event_type == "tripEnd":
            run_async_from_sync(process_trip_end(data, live_collection))
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

    except ConnectionFailure as db_err:
        logger.error(
            "Task %s (%s): Database connection error during processing: %s",
            task_name,
            celery_task_id,
            db_err,
            exc_info=False,
        )
        if (
            hasattr(self, "request")
            and hasattr(self.request, "retries")
            and hasattr(self, "default_retry_delay")
        ):
            countdown = int(self.default_retry_delay * (2**self.request.retries))
            logger.info(
                "Retrying task %s in %d seconds due to DB connection error.",
                celery_task_id,
                countdown,
            )
            try:
                raise self.retry(exc=db_err, countdown=countdown)
            except Exception as retry_exc:
                logger.critical(
                    "Failed to *initiate* retry for task %s: %s",
                    celery_task_id,
                    retry_exc,
                )
                raise db_err from retry_exc
        else:
            logger.error(
                "Cannot retry task %s as Celery retry context is missing.",
                celery_task_id,
            )
            raise db_err

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
            logger.error(
                "Cannot retry task %s for generic error as Celery retry "
                "context is missing.",
                celery_task_id,
            )
            raise e

    return {"status": "error", "message": "Unknown error (unreachable)"}
