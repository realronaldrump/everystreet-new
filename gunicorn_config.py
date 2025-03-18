"""
Gunicorn configuration file.
Optimized for resource-intensive street coverage operations.
"""

import os
import multiprocessing

# Server socket
bind = "0.0.0.0:8080"
backlog = 1024

# Worker processes
# Reduce worker count to avoid memory pressure
workers = multiprocessing.cpu_count() // 2 or 2
worker_class = "uvicorn.workers.UvicornWorker"

# Timeouts - increase for long-running operations
timeout = 180  # 3 minutes instead of default 30 seconds
graceful_timeout = 30
keepalive = 5

# Logging
errorlog = "-"
loglevel = "info"
accesslog = "-"
access_log_format = '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'

# Process naming
proc_name = "everyseg"

# Worker connections
worker_connections = 1000

# Max requests
max_requests = 1000
max_requests_jitter = 100

# Preload app to reduce memory use per worker
preload_app = True

# Thread configuration
threads = 2

# WSGI application path
wsgi_app = "app:app"

# Process management
daemon = False

# Memory limits - restart workers approaching memory limits
max_worker_memory = 1024 * 1024 * 1024  # 1GB


def worker_memory_exceeded(worker):
    return worker.memory_info().rss > max_worker_memory


def on_starting(server):
    """Log when server starts"""
    print(f"Starting Gunicorn with {workers} workers, timeout {timeout}s")


def pre_fork(server, worker):
    """Pre-fork actions"""
    pass


def post_fork(server, worker):
    """Post-fork actions"""
    # Set lower nice value for better CPU priority
    try:
        import os

        os.nice(10)  # Higher priority (lower nice value)
    except:
        pass


def worker_abort(worker):
    """Log worker timeouts"""
    print(f"Worker {worker.pid} was aborted due to timeout or memory limits")
