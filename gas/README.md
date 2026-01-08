# Gas Tracking Module

This module provides comprehensive gas tracking and vehicle management functionality for the EveryStreet application.

## Overview

The gas tracking module was refactored from a monolithic `gas_api.py` (1,179 lines) into a modular package structure following the same proven pattern used in the `coverage/` and `tasks/` modules.

## Architecture

```
gas/
├── __init__.py                      # Package initialization & router aggregation
├── README.md                        # This file
├── serializers.py                   # Data serialization utilities
├── services/                        # Business logic layer
│   ├── __init__.py
│   ├── vehicle_service.py          # Vehicle CRUD operations
│   ├── fillup_service.py           # Fill-up CRUD & MPG calculations
│   ├── odometer_service.py         # Odometer estimation & location resolution
│   ├── statistics_service.py       # Gas statistics & vehicle sync
│   └── bouncie_service.py          # External Bouncie API integration
└── routes/                          # API endpoint handlers
    ├── __init__.py
    ├── vehicles.py                 # Vehicle management endpoints
    ├── fillups.py                  # Fill-up CRUD endpoints
    ├── location.py                 # Location & odometer endpoints
    └── statistics.py               # Statistics & sync endpoints
```

## Features

### 1. Vehicle Management

- CRUD operations for vehicle records
- Vehicle filtering by IMEI, VIN, and active status
- Soft delete (mark as inactive)

### 2. Gas Fill-up Tracking

- Record gas fill-ups with automatic MPG calculation
- Strict MPG calculation rules:
  - Previous fill-up must be FULL_TANK
  - Current fill-up must be FULL_TANK
  - User must not mark "Missed Previous"
  - Both fill-ups must have odometer readings
- Cascading recalculation when fill-ups are modified or deleted
- Support for partial fills and missed fill-ups

### 3. Vehicle Location & Odometer

- Real-time location via Bouncie API integration
- Historical location lookup from trip data
- Odometer estimation via interpolation/extrapolation
- Supports multiple GPS data formats (Point, LineString, FeatureCollection)

### 4. Gas Statistics

- Aggregate statistics by vehicle and date range
- Average MPG, total gallons, total cost
- Cost per mile calculations
- Vehicle synchronization from trip data

### 5. Bouncie API Integration

- OAuth token acquisition
- Real-time vehicle status lookup
- Odometer and location data retrieval

## API Endpoints

### Vehicle Management

- `GET /api/vehicles` - List vehicles with filters
- `POST /api/vehicles` - Create new vehicle
- `PUT /api/vehicles/{imei}` - Update vehicle
- `DELETE /api/vehicles/{imei}` - Mark vehicle inactive

### Gas Fill-ups

- `GET /api/gas-fillups` - List fill-ups with filters
- `GET /api/gas-fillups/{fillup_id}` - Get specific fill-up
- `POST /api/gas-fillups` - Create new fill-up
- `PUT /api/gas-fillups/{fillup_id}` - Update fill-up
- `DELETE /api/gas-fillups/{fillup_id}` - Delete fill-up

### Location & Odometer

- `GET /api/vehicle-location` - Get vehicle location at timestamp
- `GET /api/vehicles/estimate-odometer` - Estimate odometer reading

### Statistics

- `GET /api/gas-statistics` - Get gas consumption statistics
- `POST /api/vehicles/sync-from-trips` - Sync vehicles from trip data
- `GET /api/trip-gas-cost` - Calculate gas cost for specific trip

## MPG Calculation Logic

The MPG calculation follows strict rules to ensure accuracy:

1. **Requires two consecutive FULL_TANK fill-ups**
   - Previous fill-up establishes the full tank baseline
   - Current fill-up measures fuel consumed to return to full

2. **Both fill-ups must have odometer readings**
   - Miles = Current Odometer - Previous Odometer

3. **User must not mark "Missed Previous"**
   - Ensures no fill-ups were skipped between the two

4. **Calculation**: MPG = Miles / Gallons

5. **Cascading Updates**
   - When a fill-up is inserted, updated, or deleted
   - The next fill-up in sequence is automatically recalculated

## Odometer Estimation

The odometer estimation algorithm:

1. **Find nearest anchor point** (gas fill-up or trip with known odometer)
2. **Determine direction** (forward or backward from anchor)
3. **Sum trip distances** between anchor and target time
4. **Calculate**:
   - Forward: Estimated = Anchor + Distance
   - Backward: Estimated = Anchor - Distance

## Services

### VehicleService

- `get_vehicles()` - Fetch vehicles with filters
- `create_vehicle()` - Create new vehicle
- `update_vehicle()` - Update vehicle info
- `delete_vehicle()` - Mark vehicle inactive
- `get_vehicle_by_imei()` - Get single vehicle

### FillupService

- `get_fillups()` - Fetch fill-ups with filters
- `get_fillup_by_id()` - Get single fill-up
- `create_fillup()` - Create new fill-up with MPG calc
- `update_fillup()` - Update fill-up and recalculate
- `delete_fillup()` - Delete fill-up and recalculate
- `calculate_mpg()` - Calculate MPG for a fill-up
- `recalculate_subsequent_fillup()` - Cascade recalculation

### OdometerService

- `get_vehicle_location_at_time()` - Get location at timestamp
- `estimate_odometer_reading()` - Estimate odometer value

### StatisticsService

- `get_gas_statistics()` - Get aggregate statistics
- `sync_vehicles_from_trips()` - Sync vehicles from trip data
- `calculate_trip_gas_cost()` - Calculate trip gas cost

### BouncieService

- `fetch_vehicle_status()` - Get real-time data from Bouncie API

## Database Collections

The module interacts with:

- `vehicles_collection` - Vehicle records
- `gas_fillups_collection` - Gas fill-up records
- `trips_collection` - Trip data for odometer estimation

## Models

Uses Pydantic models from `models.py`:

- `VehicleModel` - Vehicle data validation
- `GasFillupCreateModel` - Fill-up data validation

## Integration

The gas module is integrated into the main application via `app.py`:

```python
from gas import router as gas_router
app.include_router(gas_router)
```

## Backward Compatibility

The refactored module maintains 100% backward compatibility:

- All API endpoints remain unchanged
- All query parameters and response formats are identical
- Existing client code requires no modifications

## Benefits of Modular Structure

1. **Maintainability** - Single responsibility per module (avg ~200 lines)
2. **Testability** - Services can be tested independently
3. **Reusability** - Services can be imported by other modules
4. **Scalability** - Easy to add new endpoints or services
5. **Documentation** - Clear organization with comprehensive docs

## Migration Notes

The original `gas_api.py` file can be removed after verifying the integration works correctly. The new package provides all the same functionality with better organization and maintainability.
