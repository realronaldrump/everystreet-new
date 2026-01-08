# Coverage Package

A modular, well-organized system for managing street coverage areas, calculations, and analysis.

## Package Structure

```
coverage/
├── __init__.py              # Package exports and documentation
├── README.md               # This file
├── serializers.py          # Data serialization utilities
├── gridfs_service.py       # GridFS operations for GeoJSON storage
├── services.py             # Business logic services
└── routes/                 # API route handlers
    ├── __init__.py
    ├── areas.py            # Coverage area CRUD operations
    ├── streets.py          # Street segment operations
    ├── calculation.py      # Coverage calculation endpoints
    ├── custom_boundary.py  # Custom boundary handling
    └── optimal_routes.py   # Optimal route generation
```

## Modules

### `serializers.py`

Handles all data serialization and JSON sanitization:

- `sanitize_value()` - Remove NaN/Infinity from data
- `sanitize_features()` - Sanitize GeoJSON feature collections
- `serialize_datetime()` - Convert datetime to ISO strings
- `serialize_object_id()` - Convert ObjectId to strings
- `serialize_coverage_area()` - Serialize coverage area documents
- `serialize_coverage_details()` - Serialize detailed coverage info
- `serialize_progress()` - Serialize task progress
- `serialize_optimal_route()` - Serialize route data

**Purpose**: Centralize all MongoDB type conversions and JSON sanitization to eliminate scattered datetime/ObjectId handling throughout the codebase.

### `gridfs_service.py`

Manages all GridFS operations for storing and streaming large GeoJSON files:

- `GridFSService` class with methods:
  - `get_file_metadata()` - Fetch file metadata
  - `stream_geojson()` - Stream GeoJSON data from GridFS
  - `delete_file()` - Delete a GridFS file
  - `delete_files_by_location()` - Bulk delete by location
  - `regenerate_streets_geojson()` - Regenerate and store GeoJSON

**Purpose**: Encapsulate complex GridFS streaming logic (previously 150+ lines of nested async code) into a reusable service with proper error handling and cleanup.

### `services.py`

Contains core business logic services:

#### `CoverageStatsService`

- `recalculate_stats()` - Recalculate coverage statistics
- `_aggregate_street_stats()` - Run MongoDB aggregation pipeline
- `_calculate_street_type_stats()` - Calculate per-street-type stats

**Purpose**: Extract the 250+ line stats calculation logic into a dedicated, testable service.

#### `SegmentMarkingService`

- `mark_segment()` - Mark street segments with manual overrides

**Purpose**: Centralize segment marking logic with proper validation and background task triggering.

#### `GeometryService`

- `bbox_from_geometry()` - Calculate bounding boxes from GeoJSON

**Purpose**: Provide geometry utility functions.

### `routes/` Directory

API route handlers organized by domain:

#### `areas.py`

Coverage area management endpoints:

- `GET /api/coverage_areas` - List all areas
- `GET /api/coverage_areas/{id}` - Get area details
- `POST /api/preprocess_streets` - Preprocess area streets
- `POST /api/coverage_areas/delete` - Delete area
- `POST /api/coverage_areas/cancel` - Cancel processing

#### `streets.py`

Street segment operations:

- `GET /api/coverage_areas/{id}/geojson/gridfs` - Stream GeoJSON from GridFS
- `GET /api/coverage_areas/{id}/streets` - Get street segments
- `GET /api/coverage_areas/{id}/streets/viewport` - Get viewport streets
- `POST /api/undriven_streets` - Get undriven streets
- `GET /api/street_segment/{id}` - Get segment details
- `POST /api/street_segments/mark_{driven|undriven|undriveable|driveable}` - Mark segments

#### `calculation.py`

Coverage calculation operations:

- `POST /api/street_coverage` - Start full calculation
- `GET /api/street_coverage/{task_id}` - Get calculation status
- `POST /api/street_coverage/incremental` - Start incremental update
- `POST /api/coverage_areas/{id}/refresh_stats` - Refresh statistics

#### `custom_boundary.py`

Custom boundary handling:

- `POST /api/validate_custom_boundary` - Validate drawn boundary
- `POST /api/preprocess_custom_boundary` - Process custom boundary

#### `optimal_routes.py`

Optimal route generation and management:

- `POST /api/coverage_areas/{id}/generate-optimal-route` - Generate route
- `GET /api/coverage_areas/{id}/optimal-route` - Get route
- `GET /api/coverage_areas/{id}/optimal-route/gpx` - Export as GPX
- `DELETE /api/coverage_areas/{id}/optimal-route` - Delete route
- `GET /api/optimal-routes/{task_id}/progress` - Get progress
- `GET /api/optimal-routes/{task_id}/progress/sse` - Stream progress via SSE

## Integration

The main `coverage_api.py` file now serves as a thin integration layer:

```python
from fastapi import APIRouter
from coverage.routes import areas, calculation, custom_boundary, optimal_routes, streets

router = APIRouter()
router.include_router(areas.router, tags=["coverage-areas"])
router.include_router(streets.router, tags=["streets"])
router.include_router(calculation.router, tags=["calculation"])
router.include_router(custom_boundary.router, tags=["custom-boundary"])
router.include_router(optimal_routes.router, tags=["optimal-routes"])
```

## Benefits of Modular Structure

### Before (Monolithic)

- Single 2,130-line `coverage_api.py` file
- Mixed concerns (routing, business logic, serialization, GridFS)
- Difficult to test individual components
- Scattered datetime/ObjectId serialization
- 150+ lines of nested GridFS streaming code
- Hard to navigate and maintain

### After (Modular)

- **Clear separation of concerns**: Each module has a single responsibility
- **Testable components**: Services can be unit tested independently
- **DRY principle**: Serialization logic centralized, no duplication
- **Better organization**: Routes grouped by domain (areas, streets, etc.)
- **Easier to navigate**: ~200-400 lines per file vs. 2,130 lines
- **Reusable services**: GridFS, stats, and marking services can be used anywhere
- **Better error handling**: Centralized in service layer
- **Scalable**: Easy to add new routes or services

## Usage Examples

### Using Serializers

```python
from coverage.serializers import serialize_coverage_area, sanitize_features

# Serialize a coverage area document
area = await collection.find_one({"_id": location_id})
serialized = serialize_coverage_area(area)

# Sanitize GeoJSON features
features = sanitize_features(raw_features)
```

### Using Services

```python
from coverage.services import coverage_stats_service, segment_marking_service

# Recalculate stats
updated_data = await coverage_stats_service.recalculate_stats(location_id)

# Mark a segment
result = await segment_marking_service.mark_segment(
    location_id, segment_id, {"driven": True}, "driven"
)
```

### Using GridFS Service

```python
from coverage.gridfs_service import gridfs_service

# Regenerate GeoJSON
new_file_id = await gridfs_service.regenerate_streets_geojson(location_id)

# Stream GeoJSON
async for chunk in gridfs_service.stream_geojson(file_id, location_id):
    yield chunk
```

## Migration Notes

The refactoring is **fully backward compatible**:

- All API endpoints remain unchanged
- No changes required to frontend code
- `coverage_api.router` still exists and works identically
- All functionality preserved, just reorganized

## Testing Strategy

The modular structure enables better testing:

1. **Unit tests** for services (stats, marking, geometry)
2. **Unit tests** for serializers (datetime, ObjectId conversion)
3. **Integration tests** for GridFS operations
4. **Route tests** for each domain (areas, streets, etc.)
5. **End-to-end tests** for complete workflows

## Future Improvements

Potential enhancements enabled by this structure:

1. Add caching layer to services
2. Implement rate limiting per route group
3. Add request/response validation middleware
4. Create async task queue service
5. Add metrics and monitoring per service
6. Implement service-level logging
7. Add API versioning per route group

## Related Files

Files that work with this package:

- `coverage_tasks.py` - Async task orchestration
- `street_coverage_calculation.py` - Core calculation engine
- `tasks/coverage.py` - Celery task wrappers
- `app.py` - Main FastAPI application (imports `coverage_api.router`)
