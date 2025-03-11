"""
Celery application configuration for EveryStreet.

This module sets up the Celery application instance with Redis as the message broker
and result backend. It also configures Celery Beat for scheduled tasks.
"""

import os
import logging
import time
from datetime import timedelta
from celery import Celery, signals
from dotenv import load_dotenv
from kombu import Queue

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

# Get Redis URL from environment (fallback to a default for development)
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
logger.info(
    f"Configuring Celery with broker: {REDIS_URL.split('@')[-1] if '@' in REDIS_URL else REDIS_URL}"
)

# Max retry attempts for Redis connection
MAX_RETRIES = 10
RETRY_DELAY = 5  # seconds


# Try to establish Redis connection with retries
def get_redis_connection_with_retry():
    import redis
    from redis.exceptions import ConnectionError

    retry_count = 0
    while retry_count < MAX_RETRIES:
        try:
            # Test the connection
            r = redis.from_url(REDIS_URL)
            r.ping()
            logger.info("Successfully connected to Redis")
            return True
        except ConnectionError as e:
            retry_count += 1
            logger.warning(
                f"Redis connection failed (attempt {retry_count}/{MAX_RETRIES}): {e}"
            )
            if retry_count < MAX_RETRIES:
                logger.info(f"Retrying in {RETRY_DELAY} seconds...")
                time.sleep(RETRY_DELAY)
            else:
                logger.error(f"Failed to connect to Redis after {MAX_RETRIES} attempts")
                raise
        except Exception as e:
            logger.error(f"Unexpected error connecting to Redis: {e}")
            raise


# Try to establish connection before proceeding
get_redis_connection_with_retry()

# Task queues definition
task_queues = [
    Queue("default", routing_key="default"),
    Queue("high_priority", routing_key="high_priority"),
    Queue("low_priority", routing_key="low_priority"),
]

# Create Celery application
app = Celery(
    "everystreet",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["tasks"],
)

# Configure Celery
app.conf.update(
    # General settings
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    # Use task queues
    task_queues=task_queues,
    task_default_queue="default",
    task_default_exchange="tasks",
    task_default_routing_key="default",
    # Concurrency and resource control
    worker_concurrency=int(os.getenv("CELERY_WORKER_CONCURRENCY", "4")),
    task_acks_late=True,  # Tasks are acknowledged after completion
    task_reject_on_worker_lost=True,  # Ensure tasks are re-queued if worker dies
    worker_prefetch_multiplier=1,  # One task at a time per worker
    # Result management
    result_expires=3600,  # Results expire after 1 hour
    task_ignore_result=False,  # We want to track results
    # Retry settings
    task_time_limit=1800,  # 30 minutes max per task
    task_soft_time_limit=1500,  # Soft limit 25 minutes
    broker_connection_retry=True,
    broker_connection_retry_on_startup=True,
    broker_connection_max_retries=10,
    broker_connection_timeout=30,
    # Beat scheduler settings
    beat_schedule={
        "fetch_trips_hourly": {
            "task": "tasks.periodic_fetch_trips",
            "schedule": timedelta(
                minutes=int(os.getenv("TRIP_FETCH_INTERVAL_MINUTES", "60"))
            ),
            "options": {"queue": "default"},
        },
        "preprocess_streets_daily": {
            "task": "tasks.preprocess_streets",
            "schedule": timedelta(days=1),
            "options": {"queue": "low_priority"},
        },
        "update_coverage_hourly": {
            "task": "tasks.update_coverage_for_all_locations",
            "schedule": timedelta(minutes=60),
            "options": {"queue": "default"},
        },
        "cleanup_stale_trips_hourly": {
            "task": "tasks.cleanup_stale_trips",
            "schedule": timedelta(minutes=60),
            "options": {"queue": "low_priority"},
        },
        "cleanup_invalid_trips_daily": {
            "task": "tasks.cleanup_invalid_trips",
            "schedule": timedelta(days=1),
            "options": {"queue": "low_priority"},
        },
        "update_geocoding_twice_daily": {
            "task": "tasks.update_geocoding",
            "schedule": timedelta(hours=12),
            "options": {"queue": "default"},
        },
        "remap_unmatched_trips_6h": {
            "task": "tasks.remap_unmatched_trips",
            "schedule": timedelta(hours=6),
            "options": {"queue": "default"},
        },
        "validate_trip_data_twice_daily": {
            "task": "tasks.validate_trip_data",
            "schedule": timedelta(hours=12),
            "options": {"queue": "low_priority"},
        },
    },
    # Worker monitoring settings
    worker_send_task_events=True,
    task_send_sent_event=True,
    worker_cancel_long_running_tasks_on_connection_loss=True,
)


# Signal handlers for better error handling and monitoring
@signals.task_failure.connect
def task_failure_handler(sender=None, task_id=None, exception=None, **kwargs):
    logger.error(f"Task {task_id} failed: {exception}")


@signals.worker_ready.connect
def worker_ready_handler(**kwargs):
    logger.info("Celery worker is ready")


@signals.worker_shutting_down.connect
def worker_shutdown_handler(**kwargs):
    logger.info("Celery worker is shutting down")


@signals.beat_init.connect
def beat_init_handler(**kwargs):
    logger.info("Celery beat scheduler initialized")


@signals.setup_logging.connect
def setup_celery_logging(**kwargs):
    return True  # Skip default Celery logging config, use our own


# Make the Celery app available to tasks.py and other modules
if __name__ == "__main__":
    app.start()
