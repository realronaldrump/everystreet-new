#!/bin/bash
# Script for running the application locally with reduced resource usage

echo "Starting EveryStreet with reduced worker configuration for local development..."
echo "This configuration uses fewer resources but may handle fewer concurrent requests."

# Activate virtual environment if present
if [ -d "venv" ]; then
    source venv/bin/activate
    echo "Virtual environment activated"
fi

# Run with only 2 workers for local development
gunicorn app:app -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8080 --workers 2 --worker-connections 100 --graceful-timeout 30

# Deactivate virtual environment if it was activated
if [ -n "$VIRTUAL_ENV" ]; then
    deactivate
fi 