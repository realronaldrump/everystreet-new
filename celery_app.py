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
        REDIS_URL = (
            f"redis://{redis_user}:{redis_password}@{redis_host}:{redis_port}"
        )
    else:
        raise ValueError(
            "REDIS_URL environment variable is not set and cannot be constructed! "
            "This is required for Celery to connect to Redis broker. "
            "Please configure REDIS_URL in your environment (e.g., Railway)."
        )

logger.info(
    "Configuring Celery with broker: %s",
    REDIS_URL.split("@")[-1] if "@" in REDIS_URL else REDIS_URL,
)
os.environ["CELERY_BROKER_URL"] = REDIS_URL
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
                "Redis connection failed (attempt %d/%d): %s",
                retry_count,
                MAX_RETRIES,
                e,
            )
            if retry_count < MAX_RETRIES:
                logger.info(
                    "Retrying Redis connection in %s seconds...", RETRY_DELAY
                )
                time.sleep(RETRY_DELAY)
            else:
                logger.error(
                    "Failed to connect to Redis after %d attempts. Celery will likely fail to start.",
                    MAX_RETRIES,
                )
                raise  # Re-raise the exception to prevent Celery from starting without Redis
        except Exception as e:
            logger.error(
                "Unexpected error during Redis connection attempt: %s", e
            )
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
    # --- Celery Beat Schedule (NOW ONLY RUNS THE SCHEDULER TASK) ---
    beat_schedule={
        "run_task_scheduler_every_minute": {
            "task": "tasks.run_task_scheduler",  # Name of the new scheduler task in tasks.py
            "schedule": timedelta(
                minutes=1
            ),  # Run frequently (e.g., every minute)
            "options": {
                "queue": "high_priority"
            },  # Ensure this scheduler runs reliably
        },
        # REMOVED ALL OTHER STATIC TASK SCHEDULES
    },
    # --- Worker Monitoring and Events ---
    worker_send_task_events=True,  # Enable sending task events for monitoring (e.g., Flower)
    task_send_sent_event=True,  # Send 'task-sent' events
    worker_cancel_long_running_tasks_on_connection_loss=True,  # Cancel tasks if connection to broker is lost
)


# --- Signal Handlers for Logging and Error Management ---
@signals.task_failure.connect
def task_failure_handler(sender=None, task_id=None, exception=None, **kwargs):
    # Avoid logging scheduler task failures excessively if they are transient
    task_name = sender.name if sender else "unknown"
    if task_name != "tasks.run_task_scheduler":
        logger.error("Task %s (%s) failed: %s", task_name, task_id, exception)
    else:
        logger.warning("Scheduler task (%s) failed: %s", task_id, exception)


@signals.worker_ready.connect
def worker_ready_handler(**kwargs):
    logger.info(
        "Celery worker is ready and listening for tasks."
    )  # More descriptive message


@signals.worker_shutting_down.connect
def worker_shutdown_handler(**kwargs):
    logger.info(
        "Celery worker is shutting down..."
    )  # Indicate worker shutdown


@signals.beat_init.connect
def beat_init_handler(**kwargs):
    logger.info(
        "Celery beat scheduler initialized and started (running scheduler task)."
    )  # Indicate beat start


@signals.setup_logging.connect
def setup_celery_logging(**kwargs):
    # We use basicConfig, so skip Celery's default logging setup
    return True


# --- Handle time synchronization issues ---
@signals.worker_init.connect
def worker_init(**kwargs):
    # Log worker start time in UTC to help diagnose time drift issues
    from datetime import datetime, timezone

    current_time = datetime.now(timezone.utc)
    logger.info("Worker starting at UTC time: %s", current_time.isoformat())
