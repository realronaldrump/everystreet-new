# Performance Monitoring System

This document describes the comprehensive performance monitoring system implemented in the EveryStreet application.

## 🚀 Overview

The performance monitoring system provides real-time tracking of application performance, automatic optimization recommendations, and detailed analytics to help maintain and improve system efficiency.

## 🎯 Key Features

### Real-Time Monitoring

- **API Request Tracking**: Response times, request counts, status codes
- **Database Operation Monitoring**: Query durations, operation types, collection performance
- **Processing Performance**: Task execution times, throughput metrics
- **System Health Scoring**: 0-100 performance score with status indicators

### Automatic Analysis

- **Performance Bottleneck Detection**: Identifies slow operations automatically
- **Optimization Recommendations**: Actionable suggestions for improvements
- **Trend Analysis**: Historical performance patterns and degradation detection
- **Resource Usage Tracking**: Memory, connection pool, and cache performance

### Dashboard & API

- **Interactive Web Dashboard**: Real-time charts and metrics visualization
- **REST API Endpoints**: Programmatic access to all performance data
- **Automatic Cleanup**: Prevents memory buildup with configurable retention
- **Background Monitoring**: Non-intrusive performance collection

## 📊 Metrics Tracked

### API Performance

```python
{
    "api_requests": {
        "GET:/api/trips": {
            "request_count": 150,
            "avg_duration_ms": 85.5,
            "max_duration_ms": 250.0,
            "min_duration_ms": 45.0
        }
    }
}
```

### Database Performance

```python
{
    "database_operations": {
        "find:trips": {
            "operation_count": 75,
            "avg_duration_ms": 25.3,
            "max_duration_ms": 85.0,
            "min_duration_ms": 8.0
        }
    }
}
```

### System Health

```python
{
    "performance_score": 85,
    "status": "good",
    "recommendations_count": 2,
    "timestamp": "2024-01-20T15:30:00Z"
}
```

## 🛠️ Usage

### Basic Integration

The performance monitoring is automatically integrated into your FastAPI application:

```python
# Performance monitoring is automatically started in app.py startup event
# All API requests are automatically tracked via middleware
# Database operations are automatically monitored via DatabaseOperationMixin
```

### Manual Performance Tracking

For custom operations, you can use the performance monitoring decorators and context managers:

```python
from performance_monitor import (
    PerformanceTimer,
    async_performance_timer,
    monitor_performance,
    log_processing_step
)

# Sync context manager
with PerformanceTimer("custom_operation", "processing"):
    # Your code here
    process_data()

# Async context manager
async def async_operation():
    async with async_performance_timer("async_processing", "api"):
        # Your async code here
        await process_async_data()

# Decorator for automatic monitoring
@monitor_performance("processing")
async def my_function():
    # Function automatically monitored
    return await some_work()

# Manual logging
log_processing_step("data_validation", duration_ms=125.5, items_processed=100)
```

### API Endpoints

#### Get Performance Health

```bash
GET /api/performance/health
```

Returns overall system health status and performance score.

#### Get Real-Time Metrics

```bash
GET /api/performance/metrics
```

Returns current performance metrics for monitoring dashboards.

#### Get Performance Summary

```bash
GET /api/performance/summary?hours=24
```

Returns detailed performance summary for specified time period.

#### Get Optimization Report

```bash
GET /api/performance/report
```

Returns comprehensive analysis with optimization recommendations.

### Web Dashboard

Access the interactive performance dashboard at:

```
http://localhost:8080/performance
```

The dashboard provides:

- Real-time performance charts
- System health indicators
- Optimization recommendations
- Historical trend analysis
- Auto-refresh every 30 seconds

## 📈 Performance Scoring

The system calculates a performance score (0-100) based on:

- **API Response Times**: Target <500ms for 95% of requests
- **Database Query Performance**: Target <200ms average
- **Error Rates**: Target <1% error rate
- **Cache Effectiveness**: Bonus points for good cache hit rates

### Score Ranges

- **80-100**: Excellent (Green)
- **60-79**: Good (Blue)
- **40-59**: Fair (Yellow)
- **0-39**: Poor (Red)

## 🔧 Configuration

### Environment Variables

```bash
# Optional: Configure cleanup intervals
PERFORMANCE_CLEANUP_INTERVAL_MINUTES=30
PERFORMANCE_MAX_METRIC_HISTORY=1000
```

### Customization

You can customize performance thresholds in `performance_monitor.py`:

```python
# Slow operation thresholds
SLOW_API_THRESHOLD_MS = 500
SLOW_DB_THRESHOLD_MS = 200

# Metric retention
MAX_METRIC_HISTORY = 1000
CLEANUP_INTERVAL_MINUTES = 30
```

## 🔍 Optimization Recommendations

The system automatically generates recommendations based on performance patterns:

### API Performance

- **Slow Endpoints**: Identifies endpoints with >500ms average response time
- **High Error Rates**: Detects endpoints with elevated error rates
- **Suggestions**: Caching recommendations, query optimization hints

### Database Performance

- **Slow Queries**: Identifies operations taking >200ms on average
- **Index Recommendations**: Suggests indexes for frequently queried fields
- **Connection Pool**: Monitors and suggests pool size adjustments

### Processing Performance

- **Bottlenecks**: Identifies slow processing steps
- **Throughput Issues**: Detects low items/second processing rates
- **Optimization Hints**: Suggests batch processing or parallel execution

## 🧪 Testing

Run the performance monitoring test suite:

```bash
python test_performance_monitoring.py
```

This test script:

- Verifies all monitoring functions work correctly
- Tests API endpoints
- Simulates performance load
- Generates sample reports

## 📊 Sample Dashboard Data

```json
{
  "timestamp": "2024-01-20T15:30:00Z",
  "last_minute": {
    "api_requests": 45,
    "api_avg_duration_ms": 125.5,
    "database_operations": 32,
    "db_avg_duration_ms": 35.2
  },
  "system_health": {
    "performance_score": 85,
    "total_optimization_metrics": 156
  }
}
```

## 🔄 Best Practices

### Monitoring Strategy

1. **Start with Dashboard**: Use web dashboard for real-time monitoring
2. **Set Up Alerts**: Monitor performance score and implement alerting
3. **Regular Reviews**: Weekly review of optimization recommendations
4. **Trend Analysis**: Watch for performance degradation over time

### Performance Optimization

1. **Address High-Priority Recommendations First**
2. **Implement Caching**: For frequently accessed data
3. **Database Indexing**: Based on slow query recommendations
4. **Code Optimization**: Focus on operations taking >1 second

### Integration

1. **CI/CD Integration**: Include performance tests in deployment pipeline
2. **Monitoring Alerts**: Set up alerts for performance score drops
3. **Capacity Planning**: Use metrics for scaling decisions
4. **Regular Maintenance**: Follow optimization recommendations

## 🐛 Troubleshooting

### Performance Monitoring Not Working

1. Check that `start_performance_monitoring()` is called in startup
2. Verify imports are correct
3. Check for ImportError exceptions in logs

### Missing Metrics

1. Ensure middleware is properly configured
2. Check database operation instrumentation
3. Verify cleanup intervals aren't too aggressive

### Dashboard Not Loading

1. Confirm the `/performance` route is accessible
2. Check that the template file exists
3. Verify no JavaScript errors in browser console

### High Memory Usage

1. Reduce `MAX_METRIC_HISTORY` value
2. Decrease `CLEANUP_INTERVAL_MINUTES`
3. Monitor for memory leaks in custom instrumentation

## 📚 Integration Examples

### Custom Monitoring

```python
from performance_monitor import log_processing_step, PerformanceTimer

def process_large_dataset(data):
    with PerformanceTimer("dataset_processing", "batch"):
        # Your processing logic
        results = []
        for item in data:
            # Process each item
            results.append(process_item(item))

        # Log additional metrics
        log_processing_step(
            "batch_processing",
            duration_ms=timer.duration_ms,
            items_processed=len(data)
        )

        return results
```

### Health Check Integration

```python
import requests

def check_system_health():
    response = requests.get("http://localhost:8080/api/performance/health")
    health = response.json()

    if health["performance_score"] < 60:
        # Send alert or notification
        send_alert(f"Performance degraded: {health['status']}")

    return health
```

## 🎯 Performance Goals

Target performance metrics for optimal system operation:

- **API Response Time**: 95th percentile < 500ms
- **Database Queries**: Average < 200ms
- **Error Rate**: < 1% of all requests
- **Performance Score**: Maintain > 80
- **Cache Hit Rate**: > 80% where applicable
- **Memory Usage**: Stable, no continuous growth

## 📞 Support

For issues or questions about the performance monitoring system:

1. Check the troubleshooting section above
2. Review the test script for examples
3. Examine the dashboard for real-time insights
4. Check application logs for performance-related messages

The performance monitoring system is designed to be transparent and non-intrusive while providing comprehensive insights into your application's performance characteristics.
