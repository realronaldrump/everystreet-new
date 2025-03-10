#!/bin/bash
# Start all services in background
gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 1 &
celery -A celery_app worker --loglevel=info &
celery -A celery_app beat --loglevel=info &
celery -A celery_app flower --port=5555 --broker=redis://default:**@yamanote.proxy.rlwy.net:52169// &

# To stop all processes, run: kill $(jobs -p)
echo "All services started. Press Ctrl+C to stop all."
wait