"""
Gunicorn configuration file.
Optimized for Railway deployment with memory and resource constraints.
"""

import os

# Server socket
bind = "0.0.0.0:" + os.environ.get("PORT", "8080")
backlog = 1024

# Worker processes - use fixed amount instead of CPU-based calculation
workers = int(os.environ.get("GUNICORN_WORKERS", "2"))
worker_class = "uvicorn.workers.UvicornWorker"

# Timeouts - adjusted for long-running operations
timeout = 180  # 3 minutes
graceful_timeout = 30
keepalive = 5

# Logging
errorlog = "-"
loglevel = os.environ.get("GUNICORN_LOG_LEVEL", "info")
accesslog = "-"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

# Process naming
proc_name = "everyseg"

# Worker connections
worker_connections = 1000

# Max requests and jitter to prevent memory leaks
max_requests = 1000
max_requests_jitter = 100

# Preload app to reduce memory use per worker
preload_app = True

# Thread configuration - adjusted for Railway
threads = int(os.environ.get("GUNICORN_THREADS", "2"))

# WSGI application path
wsgi_app = "app:app"

# Process management
daemon = False

# Memory limits - reduced for Railway containers
max_worker_memory = 512 * 1024 * 1024  # 512MB


def on_starting(server):
    """Log when server starts"""
    print(f"Starting Gunicorn with {workers} workers, timeout {timeout}s")


def post_fork(server, worker):
    """Post-fork actions"""
    # Set worker priority - don't try to change nice value in containers
    pass


def worker_abort(worker):
    """Log worker timeouts"""
    print(f"Worker {worker.pid} was aborted due to timeout or memory limits")
