# Analytics Module

This module provides comprehensive analytics and insights functionality for the EveryStreet application.

## Overview

The analytics module was refactored from a monolithic `analytics_api.py` (884 lines) into a modular package structure following the same proven pattern used in the `gas/`, `coverage/`, and `tasks/` modules.

## Architecture

```
analytics/
├── __init__.py                      # Package initialization & router aggregation
├── README.md                        # This file
├── services/                        # Business logic layer
│   ├── __init__.py
│   ├── trip_analytics_service.py   # Trip aggregations and behavior analytics
│   ├── time_analytics_service.py   # Time-based filtering and analysis
│   └── dashboard_service.py        # Dashboard metrics and insights
└── routes/                          # API endpoint handlers
    ├── __init__.py
    ├── trips.py                     # Trip analytics endpoints
    └── dashboard.py                 # Dashboard and insights endpoints
```

## Features

### 1. Trip Analytics
- **Daily Distance Aggregation** - Track total distance and trip count by date
- **Hourly Distribution** - Analyze trip patterns by hour of day
- **Weekday Distribution** - Understand weekly driving patterns
- **Driver Behavior Statistics** - Comprehensive driving behavior metrics including:
  - Total trips and distance
  - Average and maximum speed
  - Hard braking and acceleration counts
  - Idle time and fuel consumption
  - Weekly and monthly trend analysis

### 2. Time-Based Analytics
- **Hour-Based Filtering** - Get trips for specific hours (0-23)
- **Day-of-Week Filtering** - Get trips for specific days (0=Sunday to 6=Saturday)
- **Duration Calculation** - Automatic trip duration computation
- **Limited Result Sets** - Returns up to 100 trips for performance

### 3. Dashboard Insights
- **Driving Insights** - Aggregate statistics including:
  - Total trips and distance
  - Fuel consumption
  - Maximum speed
  - Idle time
  - Longest trip distance
  - Top 5 visited destinations with visit counts and durations
- **Trip Metrics** - Comprehensive metrics including:
  - Total and average distance
  - Average start time (circular mean calculation)
  - Average driving time
  - Average and maximum speed
  - Total duration in seconds

### 4. Recent Trip History
- Get recent trips for landing page activity feed
- Configurable limit (1-20 trips)
- Excludes invalid trips
- Sorted by end time (most recent first)

## API Endpoints

### Trip Analytics
- `GET /api/trip-analytics` - Get analytics on trips over time
  - Query params: `start_date`, `end_date` (required)
  - Returns: Daily distances, hourly distribution, weekday distribution

- `GET /api/time-period-trips` - Get trips for specific time period
  - Query params: `time_type` (hour/day), `time_value` (0-23 or 0-6)
  - Returns: Up to 100 trips matching the time criteria

- `GET /api/driver-behavior` - Get driving behavior statistics
  - Query params: `start_date`, `end_date` (optional)
  - Returns: Totals, weekly trends, monthly trends

- `GET /api/trips/history` - Get recent trips
  - Query params: `limit` (1-20, default 5)
  - Returns: Recent trip list

### Dashboard
- `GET /api/driving-insights` - Get aggregated driving insights
  - Query params: Standard date filters
  - Returns: Insights including top destinations

- `GET /api/metrics` - Get trip metrics and statistics
  - Query params: Standard date filters
  - Returns: Comprehensive metrics with formatted values

## Services

### TripAnalyticsService
- `get_trip_analytics(query)` - Get trip analytics across multiple dimensions
- `get_driver_behavior_analytics(query)` - Get comprehensive behavior statistics
- `get_recent_trips(limit)` - Get recent trip history
- `_organize_daily_data(results)` - Helper to organize daily aggregates
- `_organize_hourly_data(results)` - Helper to organize hourly aggregates
- `_organize_weekday_data(results)` - Helper to organize weekday aggregates

### TimeAnalyticsService
- `get_time_period_trips(query, time_type, time_value)` - Get trips for specific time periods

### DashboardService
- `get_driving_insights(query)` - Get aggregated driving insights
- `get_metrics(query)` - Get trip metrics with circular mean calculations

## Database Collections

The module interacts with:
- `trips_collection` - Trip data for all analytics

## Key Algorithms

### Circular Mean for Average Start Time
The metrics endpoint calculates the average trip start time using circular mean to handle the 24-hour wraparound correctly:
1. Collect all start hours (UTC)
2. Calculate circular average using `calculate_circular_average_hour()`
3. Convert from UTC to local timezone (America/Chicago)
4. Format as 12-hour time with AM/PM

### Time Zone Handling
All time-based aggregations use `get_mongo_tz_expr()` to ensure consistent timezone handling across queries.

### Duration Calculation
Trip duration is calculated with fallback logic:
```python
if startTime and endTime and startTime < endTime:
    duration = (endTime - startTime) / 1000  # Convert ms to seconds
else:
    duration = stored_duration or 0
```

## Data Aggregation Patterns

### Faceted Aggregation
The driver behavior endpoint uses MongoDB's `$facet` operator to compute multiple aggregations in a single query:
- **totals** - Overall statistics
- **weekly** - ISO week-based grouping
- **monthly** - Month-based grouping

### Multi-Dimensional Grouping
Trip analytics groups by multiple dimensions simultaneously:
- Date (YYYY-MM-DD format)
- Hour of day (0-23)
- Day of week (1=Sunday, 7=Saturday)

Then organizes the results into separate views for different visualizations.

## Response Formats

### Trip Analytics Response
```json
{
  "daily_distances": [
    {"date": "2024-01-15", "distance": 45.2, "count": 3}
  ],
  "time_distribution": [
    {"hour": 8, "count": 5}
  ],
  "weekday_distribution": [
    {"day": 0, "count": 12}
  ]
}
```

### Driver Behavior Response
```json
{
  "totalTrips": 150,
  "totalDistance": 1234.56,
  "avgSpeed": 35.2,
  "maxSpeed": 75.8,
  "hardBrakingCounts": 12,
  "hardAccelerationCounts": 8,
  "totalIdlingTime": 450.5,
  "fuelConsumed": 45.2,
  "weekly": [...],
  "monthly": [...]
}
```

### Metrics Response
```json
{
  "total_trips": 150,
  "total_distance": "1234.56",
  "avg_distance": "8.23",
  "avg_start_time": "08:45 AM",
  "avg_driving_time": "00:25",
  "avg_speed": "35.20",
  "max_speed": "75.80",
  "total_duration_seconds": 22500
}
```

## Integration

The analytics module is integrated into the main application via `app.py`:

```python
from analytics import router as analytics_router
app.include_router(analytics_router)
```

## Backward Compatibility

The refactored module maintains 100% backward compatibility:
- All API endpoints remain unchanged
- All query parameters and response formats are identical
- Existing client code requires no modifications
- All timezone and aggregation logic preserved

## Benefits of Modular Structure

1. **Maintainability** - Single responsibility per module (avg ~200-300 lines)
2. **Testability** - Services can be tested independently
3. **Reusability** - Services can be imported by other modules
4. **Scalability** - Easy to add new analytics endpoints or metrics
5. **Documentation** - Clear organization with comprehensive docs
6. **Separation of Concerns** - Routes handle HTTP, services handle business logic

## Performance Considerations

- **Aggregation Pipelines** - All heavy computation done in MongoDB
- **Result Limits** - Time-period trips limited to 100 for performance
- **Index Usage** - Relies on indexes from `db.init_database()`
- **Efficient Grouping** - Multi-dimensional grouping done in single query

## Error Handling

- Missing required parameters return 400 Bad Request
- Invalid time_type values return 400 Bad Request with descriptive message
- Database errors return 500 Internal Server Error
- All errors logged with full context for debugging

## Migration Notes

The original `analytics_api.py` has been backed up to `analytics_api.py.bak`. The new package provides all the same functionality with better organization and maintainability.

## Testing Recommendations

When testing the analytics module:
1. Test with various date ranges including edge cases
2. Verify timezone handling across different time zones
3. Test circular mean calculation with hours around midnight
4. Verify aggregation accuracy with known data sets
5. Test time-period filtering for all hours and days
6. Verify top destinations ranking logic
7. Test with empty result sets
