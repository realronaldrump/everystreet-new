"""
Celery application configuration for EveryStreet.

This module sets up the Celery application instance with Redis as the
message broker and result backend. It also configures Celery Beat to run
the single dynamic task scheduler.

**Important Security Note:** Celery workers should NOT be run with
superuser (root) privileges. Ensure your deployment environment (e.g.,
Dockerfile) is set up to run Celery workers as a non-root user. You can
use the `--uid` option when starting Celery workers to specify a
different user.
"""

import logging
import os
import time
from datetime import UTC, timedelta

from celery import Celery, signals
from celery.signals import worker_process_init
from celery.utils.log import get_task_logger
from dotenv import load_dotenv
from kombu import Queue

from core.async_bridge import set_worker_loop, shutdown_worker_loop
from db import db_manager
from redis_config import get_redis_url

logger = get_task_logger(__name__)

# Load environment variables FIRST
load_dotenv()

# Get Redis URL using centralized configuration
REDIS_URL = get_redis_url()
logger.info(
    "Configuring Celery with broker: %s",
    REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL,
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
                logger.exception(
                    "Failed to connect to Redis after %d attempts. Celery will likely fail to start.",
                    MAX_RETRIES,
                )
                raise
        except Exception as e:
            logger.exception(
                "Unexpected error during Redis connection attempt: %s",
                e,
            )
            raise


get_redis_connection_with_retry()

task_queues = [
    Queue("default", routing_key="default"),
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
    **_kwargs,
) -> None:
    task_name = sender.name if sender else "unknown"
    if task_name != "tasks.run_task_scheduler":
        logger.error(
            "Task %s (%s) failed: %s",
            task_name,
            task_id,
            exception,
        )
    else:
        logger.warning(
            "Scheduler task (%s) failed: %s",
            task_id,
            exception,
        )


@signals.worker_ready.connect
def worker_ready_handler(**_kwargs) -> None:
    logger.info("Celery worker is ready and listening for tasks.")


@signals.worker_shutting_down.connect
def worker_shutdown_handler(**_kwargs) -> None:
    logger.info("Celery worker is shutting down...")


@signals.beat_init.connect
def beat_init_handler(**_kwargs) -> None:
    logger.info(
        "Celery beat scheduler initialized and started (running scheduler task).",
    )


@signals.worker_init.connect
def worker_init(**_kwargs) -> None:
    import sys
    from datetime import datetime

    # Ensure the current working directory is in sys.path so we can import modules
    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())

    current_time = datetime.now(UTC)
    logger.debug("Worker starting at UTC time: %s", current_time.isoformat())


@worker_process_init.connect(weak=False)
def init_worker(**_kwargs):
    """Initialize database connection and modules for each Celery worker process."""
    logger.info("Initializing Celery worker process...")
    try:
        # Database connection is now handled lazily by db_manager
        # with automatic loop detection and reconnection
        logger.info("Worker process starting (DB connection is lazy)")

        # ---- NEW: Configure MongoDB Logging for Worker ----
        try:
            from mongodb_logging_handler import MongoDBHandler

            mongo_handler = MongoDBHandler()

            # We need to run setup_indexes, but we can't await here easily.
            # However, the handler handles async emission.
            # Ideally, indexes are set up by the main app, but we can try to ensure it.
            # For now, just attaching the handler is the priority.

            # Configure formatting
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
            )
            mongo_handler.setFormatter(formatter)
            mongo_handler.setLevel(logging.INFO)

            # Attach to the root logger to capture everything
            root_logger = logging.getLogger()
            root_logger.addHandler(mongo_handler)

            # Ensure logs also go to stdout/stderr for terminal visibility
            stream_handler = logging.StreamHandler()
            stream_handler.setFormatter(formatter)
            stream_handler.setLevel(logging.INFO)
            root_logger.addHandler(stream_handler)

            # Also ensure 'tasks' logger has it
            tasks_logger = logging.getLogger("tasks")
            tasks_logger.addHandler(mongo_handler)
            tasks_logger.addHandler(stream_handler)

            logger.info(
                "MongoDB logging handler and StreamHandler attached to worker process.",
            )
        except Exception as log_err:
            logger.exception("Failed to attach MongoDB logging handler: %s", log_err)
        # ---------------------------------------------------

        # ---------------------------------------------------
        logger.info("Initializing Beanie ODM for worker...")
        # Beanie initialization must be run in an event loop
        import asyncio

        # Dedicated loop for sync-to-async calls in this worker process
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        set_worker_loop(loop)
        # Ensure db_manager is ready
        loop.run_until_complete(db_manager.init_beanie())
        logger.info("Beanie ODM initialized.")

        logger.info("Worker process initialization complete.")

    except Exception as e:
        logger.critical(
            "CRITICAL ERROR during worker initialization: %s",
            e,
            exc_info=True,
        )
        msg = f"Worker initialization failed critically: {e}"
        raise RuntimeError(
            msg,
        ) from e


@signals.worker_process_shutdown.connect(weak=False)
def worker_process_shutdown_handler(**_kwargs) -> None:
    logger.info("Celery worker process shutting down...")
    shutdown_worker_loop()


# Import tasks to ensure they are registered with Celery
import tasks  # noqa: E402
