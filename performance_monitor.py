"""Performance monitoring and optimization tracking.

This module provides utilities to monitor application performance, track
optimization effectiveness, and generate performance reports.
"""

import asyncio
import logging
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Global performance metrics storage
_performance_data = {
    "api_requests": defaultdict(list),
    "database_operations": defaultdict(list),
    "processing_times": defaultdict(list),
    "cache_stats": defaultdict(dict),
    "memory_usage": deque(maxlen=100),
    "optimization_metrics": defaultdict(int),
}

# Configuration
MAX_METRIC_HISTORY = 1000
CLEANUP_INTERVAL_MINUTES = 30


class PerformanceTimer:
    """Context manager for timing operations."""
    
    def __init__(self, operation_name: str, category: str = "general"):
        self.operation_name = operation_name
        self.category = category
        self.start_time = None
        self.end_time = None
        
    def __enter__(self):
        self.start_time = time.perf_counter()
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.end_time = time.perf_counter()
        duration_ms = (self.end_time - self.start_time) * 1000
        
        # Record the performance data
        record_metric(
            category=self.category,
            operation=self.operation_name,
            value=duration_ms,
            metric_type="duration_ms"
        )
        
        # Log slow operations
        if duration_ms > 1000:  # Log operations over 1 second
            logger.warning(
                f"Slow operation detected: {self.operation_name} took {duration_ms:.2f}ms"
            )


@asynccontextmanager
async def async_performance_timer(operation_name: str, category: str = "general"):
    """Async context manager for timing operations."""
    start_time = time.perf_counter()
    try:
        yield
    finally:
        end_time = time.perf_counter()
        duration_ms = (end_time - start_time) * 1000
        
        record_metric(
            category=category,
            operation=operation_name,
            value=duration_ms,
            metric_type="duration_ms"
        )
        
        if duration_ms > 1000:
            logger.warning(
                f"Slow async operation: {operation_name} took {duration_ms:.2f}ms"
            )


def record_metric(
    category: str,
    operation: str,
    value: float,
    metric_type: str = "count",
    timestamp: Optional[datetime] = None
):
    """Record a performance metric.
    
    Args:
        category: Category of the metric (e.g., 'database', 'api', 'processing')
        operation: Specific operation name
        value: Metric value
        metric_type: Type of metric ('count', 'duration_ms', 'size_bytes', etc.)
        timestamp: Optional timestamp (defaults to now)
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)
    
    metric_key = f"{category}.{operation}"
    metric_data = {
        "timestamp": timestamp,
        "value": value,
        "type": metric_type,
        "operation": operation,
        "category": category
    }
    
    # Store in appropriate collection
    if metric_type == "duration_ms":
        _performance_data["processing_times"][metric_key].append(metric_data)
    elif category == "database":
        _performance_data["database_operations"][metric_key].append(metric_data)
    elif category == "api":
        _performance_data["api_requests"][metric_key].append(metric_data)
    else:
        _performance_data["optimization_metrics"][metric_key] += value
    
    # Cleanup old data
    _cleanup_old_metrics(metric_key, category)


def _cleanup_old_metrics(metric_key: str, category: str):
    """Remove old metrics to prevent memory buildup."""
    cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
    
    for collection_name in ["processing_times", "database_operations", "api_requests"]:
        if metric_key in _performance_data[collection_name]:
            metrics = _performance_data[collection_name][metric_key]
            # Keep only recent metrics
            recent_metrics = [
                m for m in metrics 
                if m["timestamp"] > cutoff_time
            ]
            _performance_data[collection_name][metric_key] = recent_metrics[-MAX_METRIC_HISTORY:]


def get_performance_summary(hours: int = 1) -> Dict[str, Any]:
    """Get a performance summary for the specified time period.
    
    Args:
        hours: Number of hours to look back
        
    Returns:
        Dictionary with performance summary
    """
    cutoff_time = datetime.now(timezone.utc) - timedelta(hours=hours)
    summary = {
        "time_period_hours": hours,
        "api_performance": {},
        "database_performance": {},
        "processing_performance": {},
        "cache_performance": {},
        "optimization_metrics": dict(_performance_data["optimization_metrics"]),
    }
    
    # Analyze API performance
    api_metrics = []
    for operation, metrics in _performance_data["api_requests"].items():
        recent_metrics = [m for m in metrics if m["timestamp"] > cutoff_time]
        if recent_metrics:
            durations = [m["value"] for m in recent_metrics]
            summary["api_performance"][operation] = {
                "request_count": len(recent_metrics),
                "avg_duration_ms": sum(durations) / len(durations),
                "max_duration_ms": max(durations),
                "min_duration_ms": min(durations),
            }
    
    # Analyze database performance
    db_metrics = []
    for operation, metrics in _performance_data["database_operations"].items():
        recent_metrics = [m for m in metrics if m["timestamp"] > cutoff_time]
        if recent_metrics:
            durations = [m["value"] for m in recent_metrics]
            summary["database_performance"][operation] = {
                "operation_count": len(recent_metrics),
                "avg_duration_ms": sum(durations) / len(durations),
                "max_duration_ms": max(durations),
                "min_duration_ms": min(durations),
            }
    
    # Analyze processing performance
    for operation, metrics in _performance_data["processing_times"].items():
        recent_metrics = [m for m in metrics if m["timestamp"] > cutoff_time]
        if recent_metrics:
            durations = [m["value"] for m in recent_metrics]
            summary["processing_performance"][operation] = {
                "operation_count": len(recent_metrics),
                "avg_duration_ms": sum(durations) / len(durations),
                "max_duration_ms": max(durations),
                "min_duration_ms": min(durations),
            }
    
    # Get cache performance from utils if available
    try:
        from utils import get_performance_metrics
        cache_metrics = get_performance_metrics()
        summary["cache_performance"] = cache_metrics
    except ImportError:
        pass
    
    return summary


def get_optimization_report() -> Dict[str, Any]:
    """Generate a comprehensive optimization effectiveness report."""
    summary = get_performance_summary(hours=24)
    
    # Calculate optimization effectiveness
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "recommendations": [],
        "performance_score": 0,
    }
    
    # Analyze performance patterns and generate recommendations
    api_perf = summary.get("api_performance", {})
    db_perf = summary.get("database_performance", {})
    
    # Check for slow API endpoints
    slow_apis = [
        op for op, stats in api_perf.items()
        if stats.get("avg_duration_ms", 0) > 500
    ]
    if slow_apis:
        report["recommendations"].append({
            "type": "performance",
            "priority": "high",
            "message": f"Slow API endpoints detected: {', '.join(slow_apis)}",
            "suggestion": "Consider adding caching or optimizing database queries"
        })
    
    # Check for slow database operations
    slow_db_ops = [
        op for op, stats in db_perf.items()
        if stats.get("avg_duration_ms", 0) > 200
    ]
    if slow_db_ops:
        report["recommendations"].append({
            "type": "database",
            "priority": "medium",
            "message": f"Slow database operations: {', '.join(slow_db_ops)}",
            "suggestion": "Consider adding indexes or optimizing queries"
        })
    
    # Calculate performance score (0-100)
    score = 100
    if slow_apis:
        score -= len(slow_apis) * 15
    if slow_db_ops:
        score -= len(slow_db_ops) * 10
    
    # Check cache hit rates
    cache_perf = summary.get("cache_performance", {})
    if cache_perf:
        # Analyze cache effectiveness
        for cache_type, stats in cache_perf.items():
            if isinstance(stats, dict) and "hit_count" in str(stats):
                # Cache is working
                score += 5
    
    report["performance_score"] = max(0, min(100, score))
    
    return report


def log_request_timing(endpoint: str, method: str, duration_ms: float, status_code: int):
    """Log API request timing information."""
    record_metric(
        category="api",
        operation=f"{method}:{endpoint}",
        value=duration_ms,
        metric_type="duration_ms"
    )
    
    # Also record status code
    record_metric(
        category="api",
        operation=f"{method}:{endpoint}:status_{status_code}",
        value=1,
        metric_type="count"
    )


def log_database_operation(operation_type: str, collection: str, duration_ms: float):
    """Log database operation timing."""
    record_metric(
        category="database",
        operation=f"{operation_type}:{collection}",
        value=duration_ms,
        metric_type="duration_ms"
    )


def log_processing_step(step_name: str, duration_ms: float, items_processed: int = 1):
    """Log processing step performance."""
    record_metric(
        category="processing",
        operation=step_name,
        value=duration_ms,
        metric_type="duration_ms"
    )
    
    # Also record throughput
    if items_processed > 0:
        throughput = items_processed / (duration_ms / 1000)  # items per second
        record_metric(
            category="processing",
            operation=f"{step_name}:throughput",
            value=throughput,
            metric_type="items_per_second"
        )


async def start_performance_monitoring():
    """Start background performance monitoring tasks."""
    logger.info("Starting performance monitoring")
    
    async def cleanup_task():
        """Periodic cleanup of old metrics."""
        while True:
            try:
                await asyncio.sleep(CLEANUP_INTERVAL_MINUTES * 60)
                cutoff_time = datetime.now(timezone.utc) - timedelta(hours=24)
                
                # Cleanup old metrics
                for collection in ["processing_times", "database_operations", "api_requests"]:
                    for metric_key in list(_performance_data[collection].keys()):
                        metrics = _performance_data[collection][metric_key]
                        recent_metrics = [
                            m for m in metrics 
                            if m["timestamp"] > cutoff_time
                        ]
                        _performance_data[collection][metric_key] = recent_metrics
                
                logger.debug("Completed performance metrics cleanup")
                
            except Exception as e:
                logger.error(f"Error in performance monitoring cleanup: {e}")
    
    # Start the cleanup task
    asyncio.create_task(cleanup_task())


def get_real_time_metrics() -> Dict[str, Any]:
    """Get real-time performance metrics for monitoring dashboards."""
    now = datetime.now(timezone.utc)
    last_minute = now - timedelta(minutes=1)
    last_hour = now - timedelta(hours=1)
    
    # Get recent API requests
    recent_api_requests = 0
    api_avg_duration = 0
    api_durations = []
    
    for operation, metrics in _performance_data["api_requests"].items():
        recent_metrics = [m for m in metrics if m["timestamp"] > last_minute]
        recent_api_requests += len(recent_metrics)
        api_durations.extend([m["value"] for m in recent_metrics])
    
    if api_durations:
        api_avg_duration = sum(api_durations) / len(api_durations)
    
    # Get recent database operations
    recent_db_ops = 0
    db_avg_duration = 0
    db_durations = []
    
    for operation, metrics in _performance_data["database_operations"].items():
        recent_metrics = [m for m in metrics if m["timestamp"] > last_minute]
        recent_db_ops += len(recent_metrics)
        db_durations.extend([m["value"] for m in recent_metrics])
    
    if db_durations:
        db_avg_duration = sum(db_durations) / len(db_durations)
    
    return {
        "timestamp": now.isoformat(),
        "last_minute": {
            "api_requests": recent_api_requests,
            "api_avg_duration_ms": api_avg_duration,
            "database_operations": recent_db_ops,
            "db_avg_duration_ms": db_avg_duration,
        },
        "system_health": {
            "performance_score": get_optimization_report()["performance_score"],
            "total_optimization_metrics": len(_performance_data["optimization_metrics"]),
        }
    }


# Decorator for automatic performance monitoring
def monitor_performance(category: str = "general"):
    """Decorator to automatically monitor function performance."""
    def decorator(func):
        if asyncio.iscoroutinefunction(func):
            async def async_wrapper(*args, **kwargs):
                async with async_performance_timer(func.__name__, category):
                    return await func(*args, **kwargs)
            return async_wrapper
        else:
            def sync_wrapper(*args, **kwargs):
                with PerformanceTimer(func.__name__, category):
                    return func(*args, **kwargs)
            return sync_wrapper
    return decorator 