"""Gunicorn configuration file.

Optimized for Railway deployment with memory and resource constraints.
"""

import logging
import os

bind = "0.0.0.0:" + os.environ.get("PORT", "8080")
backlog = 1024

workers = int(os.environ.get("GUNICORN_WORKERS", "2"))
worker_class = "uvicorn.workers.UvicornWorker"

timeout = 180
graceful_timeout = 30
keepalive = 5

errorlog = "-"
loglevel = "warning"
accesslog = "-"
access_log_format = (
    '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"'
)
logconfig_dict = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s [%(process)d] [%(levelname)s] %(message)s",
            "datefmt": "[%Y-%m-%d %H:%M:%S %z]",
        },
        "access": {
            "format": access_log_format,
        },
    },
    "handlers": {
        "error_console": {
            "class": "logging.StreamHandler",
            "formatter": "default",
            "stream": "ext://sys.stderr",
        },
        "access_console": {
            "class": "logging.StreamHandler",
            "formatter": "access",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "gunicorn.error": {
            "level": loglevel.upper(),
            "handlers": ["error_console"],
            "propagate": False,
        },
    },
    "root": {
        "level": loglevel.upper(),
        "handlers": ["error_console"],
    },
}

proc_name = "everyseg"

worker_connections = 1000

max_requests = 1000
max_requests_jitter = 100

preload_app = True

threads = int(os.environ.get("GUNICORN_THREADS", "2"))

wsgi_app = "app:app"

daemon = False

max_worker_memory = 512 * 1024 * 1024


def on_starting(server):
    """Log when server starts."""
    logging.getLogger("gunicorn.error").info(
        f"Starting Gunicorn with {workers} workers, timeout {timeout}s"
    )


def post_fork(server, worker):
    """Post-fork actions."""
    pass


def on_exit(server):
    """Log when server exits."""
    logging.getLogger("gunicorn.error").info("Gunicorn server shutting down.")


def worker_abort(worker):
    """Log worker timeouts."""
    logging.getLogger("gunicorn.error").warning(
        f"Worker {worker.pid} was aborted due to timeout or memory limits"
    )


def worker_exit(server, worker):
    """Log when worker exits."""
    logging.getLogger("gunicorn.error").info(f"Worker {worker.pid} exited.")
