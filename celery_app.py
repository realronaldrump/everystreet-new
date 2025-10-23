"""Celery application configuration for EveryStreet.

This module sets up the Celery application instance with Redis as the message
broker and result backend. It also configures Celery Beat to run the single
dynamic task scheduler.

**Important Security Note:** Celery workers should NOT be run with superuser
(root) privileges. Ensure your deployment environment (e.g., Dockerfile,
Railway configuration) is set up to run Celery workers as a non-root user. You
can use the `--uid` option when starting Celery workers to specify a different
user.
"""

import os
import time
from datetime import timedelta

from celery import Celery, signals
from celery.signals import worker_process_init
from celery.utils.log import get_task_logger
from dotenv import load_dotenv
from kombu import Queue
from pymongo.errors import ConnectionFailure

from db import db_manager
from live_tracking import initialize_db as initialize_live_tracking_db

logger = get_task_logger(__name__)

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL")
if not REDIS_URL:
    redis_host = os.getenv("REDISHOST") or os.getenv("RAILWAY_PRIVATE_DOMAIN")
    redis_port = os.getenv("REDISPORT", "6379")
    redis_password = os.getenv("REDISPASSWORD") or os.getenv("REDIS_PASSWORD")
    redis_user = os.getenv("REDISUSER", "default")

    if redis_host and redis_password:
        REDIS_URL = f"redis://{redis_user}:{redis_password}@{redis_host}:{redis_port}"
        logger.info("Constructed REDIS_URL from component variables.")
    else:
        REDIS_URL = "redis://localhost:6379"
        logger.warning(
            "REDIS_URL not provided; defaulting to local Redis at %s.",
            REDIS_URL,
        )

logger.info(
    "Configuring Celery with broker: %s",
    (REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL),
)
os.environ["CELERY_BROKER_URL"] = REDIS_URL
MAX_RETRIES = 10
RETRY_DELAY = 5


def get_redis_connection_with_retry():
    import redis
    from redis.exceptions import ConnectionError as RedisConnectionError

    retry_count = 0
    while retry_count < MAX_RETRIES:
        try:
            r = redis.from_url(REDIS_URL)
            r.ping()
            logger.info("Successfully connected to Redis broker.")
            return
        except RedisConnectionError as e:
            retry_count += 1
            logger.warning(
                "Redis connection failed (attempt %d/%d): %s",
                retry_count,
                MAX_RETRIES,
                e,
            )
            if retry_count < MAX_RETRIES:
                logger.info(
                    "Retrying Redis connection in %s seconds...",
                    RETRY_DELAY,
                )
                time.sleep(RETRY_DELAY)
            else:
                logger.error(
                    "Failed to connect to Redis after %d attempts. Celery will likely fail to start.",
                    MAX_RETRIES,
                )
                raise
        except Exception as e:
            logger.error(
                "Unexpected error during Redis connection attempt: %s",
                e,
            )
            raise


get_redis_connection_with_retry()

task_queues = [
    Queue("default", routing_key="default"),
    Queue(
        "high_priority",
        routing_key="high_priority",
    ),
    Queue("low_priority", routing_key="low_priority"),
]

app = Celery(
    "everystreet",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"],
)

app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_queues=task_queues,
    task_default_queue="default",
    task_default_exchange="tasks",
    task_default_routing_key="default",
worker_concurrency=int(os.getenv("CELERY_WORKER_CONCURRENCY", "2")),
worker_pool=os.getenv("CELERY_WORKER_POOL", "prefork"),
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    result_expires=3600,
    task_ignore_result=False,
    task_time_limit=1800,
    task_soft_time_limit=1500,
    broker_connection_retry=True,
    broker_connection_retry_on_startup=True,
    broker_connection_max_retries=10,
    broker_connection_timeout=30,
    worker_disable_rate_limits=True,
    event_time_to_system_time=True,
    event_queue_expired=60,
    event_queue_ttl=10,
    beat_schedule={
        "run_task_scheduler_every_minute": {
            "task": "tasks.run_task_scheduler",
            "schedule": timedelta(minutes=1),
            "options": {"queue": "high_priority"},
        },
    },
    worker_send_task_events=True,
    task_send_sent_event=True,
    worker_cancel_long_running_tasks_on_connection_loss=True,
)


@signals.task_failure.connect
def task_failure_handler(
    sender=None,
    task_id=None,
    exception=None,
    **kwargs,
):
    task_name = sender.name if sender else "unknown"
    if task_name != "tasks.run_task_scheduler":
        logger.error(
            "Task %s (%s) failed: %s",
            task_name,
            task_id,
            exception,
            exc_info=True,
        )
    else:
        logger.warning(
            "Scheduler task (%s) failed: %s",
            task_id,
            exception,
            exc_info=True,
        )


@signals.worker_ready.connect
def worker_ready_handler(**kwargs):
    logger.info("Celery worker is ready and listening for tasks.")


@signals.worker_shutting_down.connect
def worker_shutdown_handler(**kwargs):
    logger.info("Celery worker is shutting down...")


@signals.beat_init.connect
def beat_init_handler(**kwargs):
    logger.info(
        "Celery beat scheduler initialized and started (running scheduler task).",
    )


@signals.worker_init.connect
def worker_init(**kwargs):
    from datetime import datetime, timezone

    current_time = datetime.now(timezone.utc)
    logger.debug("Worker starting at UTC time: %s", current_time.isoformat())


@worker_process_init.connect(weak=False)
def init_worker(**kwargs):
    """Initialize database connection and modules for each Celery worker process."""
    logger.info("Initializing Celery worker process...")
    try:
        logger.info("Initializing DatabaseManager for worker...")
        _ = db_manager.client
        _ = db_manager.db
        if not db_manager.connection_healthy:
            logger.warning(
                "DB Manager connection unhealthy, attempting re-init.",
            )
            db_manager.ensure_connection()
            if not db_manager.connection_healthy:
                raise ConnectionFailure(
                    "DB Manager failed to establish connection in worker.",
                )
        logger.info("DatabaseManager connection verified for worker.")

        logger.info(
            "Initializing live_tracking global collections for worker...",
        )
        live_collection = db_manager.get_collection("live_trips")
        archive_collection = db_manager.get_collection("archived_live_trips")
        if live_collection is None or archive_collection is None:
            raise ConnectionFailure(
                "Failed to get live/archive collections from db_manager even though connection seems healthy.",
            )
        initialize_live_tracking_db(live_collection, archive_collection)
        logger.info("live_tracking global collections initialized for worker.")

        logger.info("Worker process initialization complete.")

    except Exception as e:
        logger.critical(
            f"CRITICAL ERROR during worker initialization: {e}",
            exc_info=True,
        )
        raise RuntimeError(
            f"Worker initialization failed critically: {e}",
        ) from e
