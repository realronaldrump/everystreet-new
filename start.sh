#!/bin/bash
# Start all services in background
gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 1 &
celery -A celery_app worker --loglevel=info -n worker1@%h &
celery -A celery_app beat --loglevel=info &
celery -A celery_app --broker=$REDIS_URL flower --port=5555 --inspect-timeout=15000 --persistent=True &

# To stop all processes, run: kill $(jobs -p)
echo "All services started. Press Ctrl+C to stop all."
wait