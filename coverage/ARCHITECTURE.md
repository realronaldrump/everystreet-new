# Coverage Package Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FastAPI Application                       │
│                            (app.py)                              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ includes router
                             ▼
                    ┌─────────────────┐
                    │ coverage_api.py │  (Integration Layer - 24 lines)
                    └────────┬────────┘
                             │
                             │ imports & includes
                             ▼
          ┌──────────────────────────────────────────────┐
          │         coverage/ package                     │
          │                                               │
          │  ┌──────────────────────────────────────┐   │
          │  │  routes/ (API Route Handlers)        │   │
          │  │  ┌────────────────────────────────┐  │   │
          │  │  │ areas.py          (330 lines) │  │   │
          │  │  │ streets.py        (470 lines) │  │   │
          │  │  │ calculation.py    (140 lines) │  │   │
          │  │  │ custom_boundary.py (150 lines)│  │   │
          │  │  │ optimal_routes.py (280 lines) │  │   │
          │  │  └────────────────────────────────┘  │   │
          │  └──────────────┬───────────────────────┘   │
          │                 │ uses                       │
          │                 ▼                            │
          │  ┌──────────────────────────────────────┐   │
          │  │  Business Logic Layer                │   │
          │  │  ┌────────────────────────────────┐  │   │
          │  │  │ services.py (430 lines)        │  │   │
          │  │  │  ├─ CoverageStatsService       │  │   │
          │  │  │  ├─ SegmentMarkingService      │  │   │
          │  │  │  └─ GeometryService            │  │   │
          │  │  └────────────────────────────────┘  │   │
          │  └──────────────┬───────────────────────┘   │
          │                 │ uses                       │
          │                 ▼                            │
          │  ┌──────────────────────────────────────┐   │
          │  │  Data Access Layer                   │   │
          │  │  ┌────────────────────────────────┐  │   │
          │  │  │ gridfs_service.py (310 lines)  │  │   │
          │  │  │  └─ GridFSService              │  │   │
          │  │  └────────────────────────────────┘  │   │
          │  └──────────────┬───────────────────────┘   │
          │                 │ uses                       │
          │                 ▼                            │
          │  ┌──────────────────────────────────────┐   │
          │  │  Utilities Layer                     │   │
          │  │  ┌────────────────────────────────┐  │   │
          │  │  │ serializers.py (210 lines)     │  │   │
          │  │  │  ├─ sanitize_value()           │  │   │
          │  │  │  ├─ serialize_datetime()       │  │   │
          │  │  │  ├─ serialize_object_id()      │  │   │
          │  │  │  └─ serialize_*() functions    │  │   │
          │  │  └────────────────────────────────┘  │   │
          │  └──────────────────────────────────────┘   │
          └───────────────────┬──────────────────────────┘
                              │ interacts with
                              ▼
                  ┌────────────────────────┐
                  │   MongoDB Collections   │
                  │  ├─ coverage_metadata  │
                  │  ├─ streets            │
                  │  ├─ progress_status    │
                  │  └─ GridFS             │
                  └────────────────────────┘
```

## Data Flow Examples

### Example 1: Get Coverage Area Details

```
User Request
    │
    ▼
GET /api/coverage_areas/{id}
    │
    ▼
coverage_api.router → areas.router → areas.get_coverage_area_details()
                                            │
                                            ├─ find_one_with_retry(coverage_metadata)
                                            │
                                            ▼
                                     serialize_coverage_details()
                                            │
                                            ▼
                                      JSON Response
```

### Example 2: Mark Segment as Driven

```
User Request
    │
    ▼
POST /api/street_segments/mark_driven
    │
    ▼
coverage_api.router → streets.router → streets.mark_street_segment_as_driven()
                                            │
                                            ▼
                                 segment_marking_service.mark_segment()
                                            │
                                            ├─ Validate segment & location
                                            ├─ Update street segment
                                            ├─ Mark metadata for update
                                            │
                                            ▼
                                 coverage_stats_service.recalculate_stats()
                                            │
                                            ├─ Aggregate street stats
                                            ├─ Update coverage metadata
                                            │
                                            ▼
                                 gridfs_service.regenerate_streets_geojson()
                                            │
                                            ├─ Fetch streets from DB
                                            ├─ Build GeoJSON
                                            ├─ Upload to GridFS
                                            │
                                            ▼
                                      Success Response
```

### Example 3: Stream GeoJSON from GridFS

```
User Request
    │
    ▼
GET /api/coverage_areas/{id}/geojson/gridfs
    │
    ▼
coverage_api.router → streets.router → streets.get_coverage_area_geojson_from_gridfs()
                                            │
                                            ├─ Get coverage metadata
                                            ├─ Get GridFS file ID
                                            │
                                            ▼
                                 gridfs_service.get_file_metadata()
                                            │
                                            ▼
                                 gridfs_service.stream_geojson()
                                            │
                                            ├─ Open GridFS stream
                                            ├─ Read chunks (8KB)
                                            ├─ Yield to client
                                            ├─ Close stream
                                            │
                                            ▼
                                   Streaming Response
```

## Module Dependencies

```
┌───────────────────────────────────────────────────────────┐
│                    routes/                                 │
│  (Depends on: services, gridfs_service, serializers, db)  │
└───────────────────────────┬───────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│                   services.py                              │
│     (Depends on: gridfs_service, serializers, db)         │
└───────────────────────────┬───────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│                gridfs_service.py                           │
│            (Depends on: serializers, db)                   │
└───────────────────────────┬───────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────┐
│                  serializers.py                            │
│                 (No dependencies)                          │
└───────────────────────────────────────────────────────────┘
```

## Separation of Concerns

### Layer 1: Routes (API/HTTP Layer)
**Responsibilities**:
- HTTP request/response handling
- Request validation
- Endpoint routing
- Error response formatting

**Files**: `routes/*.py`

**Should NOT**:
- Contain business logic
- Direct database access (use services)
- Data transformation (use serializers)

### Layer 2: Services (Business Logic Layer)
**Responsibilities**:
- Business logic implementation
- Complex calculations
- Workflow orchestration
- State management

**Files**: `services.py`

**Should NOT**:
- Handle HTTP concerns
- Know about request/response formats
- Direct MongoDB type handling (use serializers)

### Layer 3: Data Access Layer
**Responsibilities**:
- GridFS operations
- File storage/retrieval
- Stream management

**Files**: `gridfs_service.py`

**Should NOT**:
- Contain business logic
- Handle HTTP concerns

### Layer 4: Utilities Layer
**Responsibilities**:
- Data serialization
- Type conversions
- JSON sanitization

**Files**: `serializers.py`

**Should NOT**:
- Contain business logic
- Database operations
- HTTP handling

## Testing Strategy

### Unit Tests

```python
# Test serializers
def test_serialize_datetime():
    dt = datetime.now(UTC)
    result = serialize_datetime(dt)
    assert isinstance(result, str)

# Test services
async def test_recalculate_stats():
    service = CoverageStatsService()
    result = await service.recalculate_stats(location_id)
    assert result is not None

# Test GridFS service
async def test_stream_geojson():
    chunks = []
    async for chunk in gridfs_service.stream_geojson(file_id, location_id):
        chunks.append(chunk)
    assert len(chunks) > 0
```

### Integration Tests

```python
# Test route + service integration
async def test_mark_segment_integration(test_client):
    response = await test_client.post(
        "/api/street_segments/mark_driven",
        json={"location_id": str(id), "segment_id": "seg123"}
    )
    assert response.status_code == 200
    # Verify stats were recalculated
    # Verify GeoJSON was regenerated
```

### End-to-End Tests

```python
# Test complete workflow
async def test_coverage_calculation_workflow(test_client):
    # Start calculation
    # Poll for progress
    # Verify completion
    # Check stats
    # Verify GeoJSON
```

## Design Patterns Used

### 1. Service Pattern
- `CoverageStatsService`, `SegmentMarkingService`, `GridFSService`
- Encapsulates business logic
- Reusable across the application

### 2. Repository Pattern (via db_manager)
- Database access through `find_one_with_retry`, etc.
- Abstraction over MongoDB operations

### 3. Serializer Pattern
- Dedicated serialization layer
- Consistent data transformation

### 4. Router Pattern
- FastAPI routers for modular endpoint organization
- Tagged for OpenAPI documentation

### 5. Singleton Pattern
- Global service instances (`gridfs_service`, `coverage_stats_service`)
- Shared across requests

## Performance Considerations

### Streaming Large Files
- GridFS streaming uses 8KB chunks
- Async generators for memory efficiency
- Proper cleanup in finally blocks

### Database Operations
- Retry logic for resilience
- Batch operations where possible
- Aggregation pipelines for complex queries

### Async/Await
- Non-blocking I/O operations
- Concurrent task execution
- Background task scheduling

## Error Handling

### Layered Error Handling

```
Route Layer
    ├─ HTTPException for client errors
    ├─ 400 for validation errors
    ├─ 404 for not found
    └─ 500 for server errors
        │
        ▼
Service Layer
    ├─ Business logic validation
    ├─ Logging errors
    └─ Return None or raise for routes to handle
        │
        ▼
Data Access Layer
    ├─ GridFS errors (NoFile, etc.)
    ├─ MongoDB errors
    └─ Stream cleanup errors
        │
        ▼
Utilities Layer
    ├─ Type conversion errors
    └─ Validation errors
```

## Scalability Features

### 1. Horizontal Scaling
- Stateless route handlers
- Service instances are lightweight
- GridFS supports distributed storage

### 2. Caching (Future)
- Can add caching at service layer
- Redis integration straightforward
- Serializers make cache key generation easy

### 3. Rate Limiting (Future)
- Per-route-group limits
- Tagged routes make this easy

### 4. API Versioning (Future)
- Can version route groups independently
- `/api/v2/coverage_areas/...`

## Monitoring & Observability

### Logging Strategy
- Each layer logs at appropriate level
- Service layer logs business events
- GridFS service logs storage operations
- Routes log HTTP events

### Metrics (Future)
- Request count per route group
- Service method execution time
- GridFS operation metrics
- Error rates per layer

## Conclusion

The new architecture provides:
- **Clear boundaries** between layers
- **Single responsibility** per module
- **Testability** through isolation
- **Maintainability** through organization
- **Scalability** through modular design
- **Extensibility** through service pattern
