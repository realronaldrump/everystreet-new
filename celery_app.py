"""
Celery application configuration for EveryStreet.

This module sets up the Celery application instance with Redis as the message broker
and result backend. It also configures Celery Beat for scheduled tasks.
"""

import os
import logging
from datetime import timedelta
from celery import Celery
from dotenv import load_dotenv

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
logger.info(f"Configuring Celery with broker: {REDIS_URL.split('@')[-1]}")

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
    
    # Concurrency and resource control
    worker_concurrency=4,  # Adjust based on your needs
    task_acks_late=True,  # Tasks are acknowledged after completion
    task_reject_on_worker_lost=True,  # Ensure tasks are re-queued if worker dies
    worker_prefetch_multiplier=1,  # One task at a time per worker
    
    # Result management
    result_expires=3600,  # Results expire after 1 hour
    task_ignore_result=False,  # We want to track results
    
    # Retry settings
    task_time_limit=1800,  # 30 minutes max per task
    task_soft_time_limit=1500,  # Soft limit 25 minutes
    
    # Beat scheduler settings
    beat_schedule={
        "fetch_trips_hourly": {
            "task": "tasks.periodic_fetch_trips",
            "schedule": timedelta(minutes=60),
            "options": {"queue": "default"},
        },
        "preprocess_streets_daily": {
            "task": "tasks.preprocess_streets",
            "schedule": timedelta(days=1),
            "options": {"queue": "default"},
        },
        "update_coverage_hourly": {
            "task": "tasks.update_coverage_for_all_locations",
            "schedule": timedelta(minutes=60),
            "options": {"queue": "default"},
        },
        "cleanup_stale_trips_hourly": {
            "task": "tasks.cleanup_stale_trips",
            "schedule": timedelta(minutes=60),
            "options": {"queue": "default"},
        },
        "cleanup_invalid_trips_daily": {
            "task": "tasks.cleanup_invalid_trips",
            "schedule": timedelta(days=1),
            "options": {"queue": "default"},
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
            "options": {"queue": "default"},
        },
    },
    
    # Worker monitoring settings
    worker_send_task_events=True,
    task_send_sent_event=True,
)

# Make the Celery app available to tasks.py and other modules
if __name__ == "__main__":
    app.start()