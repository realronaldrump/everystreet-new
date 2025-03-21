"""
Celery application configuration for EveryStreet.

This module sets up the Celery application instance with Redis as the message broker
and result backend. It also configures Celery Beat for scheduled tasks.

**Important Security Note:** Celery workers should NOT be run with superuser (root) privileges.
Ensure your deployment environment (e.g., Dockerfile, Railway configuration)
is set up to run Celery workers as a non-root user. You can use the `--uid` option
when starting Celery workers to specify a different user.
"""

import logging
import os
import time
from datetime import timedelta

from celery import Celery, signals
from dotenv import load_dotenv
from kombu import Queue

# Set up logging
logging.basicConfig(
    level=logging.INFO,  # Set root logger level to INFO
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

# --- Redis Broker Configuration ---
# Get Redis URL from environment variable or construct it
REDIS_URL = os.getenv("REDIS_URL")
if not REDIS_URL:
    # Try to construct from individual components
    redis_host = os.getenv("REDISHOST") or os.getenv("RAILWAY_PRIVATE_DOMAIN")
    redis_port = os.getenv("REDISPORT", "6379")
    redis_password = os.getenv("REDISPASSWORD") or os.getenv("REDIS_PASSWORD")
    redis_user = os.getenv("REDISUSER", "default")

    if redis_host and redis_password:
        REDIS_URL = f"redis://{redis_user}:{redis_password}@{redis_host}:{redis_port}"
    else:
        raise ValueError(
            "REDIS_URL environment variable is not set and cannot be constructed! "
            "This is required for Celery to connect to Redis broker. "
            "Please configure REDIS_URL in your environment (e.g., Railway)."
        )

logger.info(
    f"Configuring Celery with broker: {REDIS_URL.split('@')[-1] if '@' in REDIS_URL else REDIS_URL}"
)
os.environ['CELERY_BROKER_URL'] = REDIS_URL
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
            # Test the Redis connection
            r = redis.from_url(REDIS_URL)
            r.ping()
            logger.info(
                "Successfully connected to Redis broker."
            )  # More specific log message
            return True
        except ConnectionError as e:
            retry_count += 1
            logger.warning(
                f"Redis connection failed (attempt {retry_count}/{MAX_RETRIES}): {e}"
            )
            if retry_count < MAX_RETRIES:
                logger.info(f"Retrying Redis connection in {RETRY_DELAY} seconds...")
                time.sleep(RETRY_DELAY)
            else:
                logger.error(
                    f"Failed to connect to Redis after {MAX_RETRIES} attempts. Celery will likely fail to start."
                )
                raise  # Re-raise the exception to prevent Celery from starting without Redis
        except Exception as e:
            logger.error(f"Unexpected error during Redis connection attempt: {e}")
            raise  # Re-raise unexpected exceptions


# Attempt Redis connection before Celery app initialization
get_redis_connection_with_retry()

# --- Celery Task Queue Configuration ---
# Define task queues for routing tasks based on priority
task_queues = [
    Queue("default", routing_key="default"),
    Queue("high_priority", routing_key="high_priority"),
    Queue("low_priority", routing_key="low_priority"),
]

# --- Celery Application Instance ---
# Create the Celery application instance
app = Celery(
    "everystreet",
    broker=REDIS_URL,  # Use the configured Redis URL
    backend=REDIS_URL,  # Use Redis also as the result backend
    include=["tasks"],  # Auto-discover tasks in the 'tasks' module
)

# --- Celery Configuration ---
app.conf.update(
    # --- General Task Settings ---
    task_serializer="json",  # JSON for task serialization
    accept_content=["json"],  # Accept JSON content
    result_serializer="json",  # Serialize task results to JSON
    timezone="UTC",  # Timezone setting for Celery
    enable_utc=True,  # Use UTC for time handling
    # --- Task Queue Settings ---
    task_queues=task_queues,  # Apply the defined task queues
    task_default_queue="default",  # Default queue for tasks without explicit routing
    task_default_exchange="tasks",  # Default exchange name
    task_default_routing_key="default",  # Default routing key
    # --- Worker Concurrency and Resource Control ---
    worker_concurrency=int(
        os.getenv("CELERY_WORKER_CONCURRENCY", "2")
    ),  # Number of worker processes (adjusted for Railway)
    task_acks_late=True,  # Acknowledge tasks after they are completed (more reliable)
    task_reject_on_worker_lost=True,  # Re-queue tasks if a worker unexpectedly dies
    worker_prefetch_multiplier=1,  # Fetch only one task at a time per worker (for resource management)
    # --- Task Result Management ---
    result_expires=3600,  # Task results expire after 1 hour (adjust as needed)
    task_ignore_result=False,  # Store task results in the backend
    # --- Task Retry and Time Limits ---
    task_time_limit=1800,  # Hard time limit for tasks (30 minutes - adjust if tasks are expected to take longer)
    task_soft_time_limit=1500,  # Soft time limit (25 minutes - allows tasks to gracefully exit before hard limit)
    broker_connection_retry=True,  # Enable broker connection retries
    broker_connection_retry_on_startup=True,  # Retry connection on startup
    broker_connection_max_retries=10,  # Maximum retry attempts for broker connection
    broker_connection_timeout=30,  # Connection timeout for broker
    # --- Flower Settings ---
    flower_inspect_timeout=15000,  # Increase Flower inspection timeout (15 seconds)
    worker_disable_rate_limits=True,  # Disable rate limits for better Railway performance
    # --- Time Synchronization ---
    event_time_to_system_time=True,  # Help with clock skew between workers
    # --- Event Queues Settings ---
    event_queue_expired=60,  # Expire the event queue after 60 seconds
    event_queue_ttl=10,  # Event queue TTL of 10 seconds
    # --- Celery Beat Schedule (Periodic Tasks) ---
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
        "update_coverage_incremental": {
            "task": "tasks.update_coverage_for_new_trips",
            "schedule": timedelta(hours=2),  # Run every 2 hours
            "options": {"queue": "default"},
        },
    },
    # --- Worker Monitoring and Events ---
    worker_send_task_events=True,  # Enable sending task events for monitoring (e.g., Flower)
    task_send_sent_event=True,  # Send 'task-sent' events
    worker_cancel_long_running_tasks_on_connection_loss=True,  # Cancel tasks if connection to broker is lost
)


# --- Signal Handlers for Logging and Error Management ---
@signals.task_failure.connect
def task_failure_handler(sender=None, task_id=None, exception=None, **kwargs):
    logger.error(f"Task {task_id} failed: {exception}")  # More informative error log


@signals.worker_ready.connect
def worker_ready_handler(**kwargs):
    logger.info(
        "Celery worker is ready and listening for tasks."
    )  # More descriptive message


@signals.worker_shutting_down.connect
def worker_shutdown_handler(**kwargs):
    logger.info("Celery worker is shutting down...")  # Indicate worker shutdown


@signals.beat_init.connect
def beat_init_handler(**kwargs):
    logger.info("Celery beat scheduler initialized and started.")  # Indicate beat start


@signals.setup_logging.connect
def setup_celery_logging(**kwargs):
    return True  # Skip default Celery logging config, we are using basicConfig


# --- Handle time synchronization issues ---
@signals.worker_init.connect
def worker_init(**kwargs):
    # Log worker start time in UTC to help diagnose time drift issues
    from datetime import datetime, timezone

    current_time = datetime.now(timezone.utc)
    logger.info(f"Worker starting at UTC time: {current_time.isoformat()}")


# --- Run Celery App (for development/testing - not typically used in production deployments) ---
if __name__ == "__main__":
    app.start()
