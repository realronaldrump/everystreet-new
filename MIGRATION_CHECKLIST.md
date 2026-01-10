# Python Codebase Migration Checklist

This document provides a step-by-step checklist for migrating the codebase to use the new core modules and best practices established during the refactoring.

---

## Phase 1: Import Updates (High Priority)

### Files Importing from `utils.py`

Update all files that currently import from `utils.py` to use new core modules.

#### Step 1: Find All Files

```bash
grep -l "from utils import\|import utils" **/*.py
```

#### Step 2: Update Each File

For each file found:

**Before:**

```python
from utils import get_session, retry_async, reverse_geocode_mapbox
```

**After:**

```python
from core.http.session import get_session
from core.http.retry import retry_async
from core.http.geocoding import reverse_geocode_mapbox
```

#### Files Already Migrated

- [x] `external_geo_service.py`

#### Files Needing Migration

Search results will show all files that need updating.

---

## Phase 2: Exception Handling (High Priority)

### Replace Generic Exceptions with Custom Exceptions

#### Step 1: Find Generic Exception Usage

```bash
# Find generic Exception raises
grep -n "raise Exception\|raise ValueError" **/*.py

# Find HTTPException usage that should be custom exceptions
grep -n "raise HTTPException" **/*.py
```

#### Step 2: Update Service Layer

In service files (`*_service.py`, `*_processor.py`):

**Before:**

```python
def process_trip(trip_data):
    if not trip_data:
        raise ValueError("No trip data provided")
    # ...
    if external_api_call_failed:
        raise Exception("External service unavailable")
```

**After:**

```python
from core.exceptions import ValidationException, ExternalServiceException

def process_trip(trip_data):
    if not trip_data:
        raise ValidationException("No trip data provided")
    # ...
    if external_api_call_failed:
        raise ExternalServiceException("Mapbox API unavailable")
```

#### Step 3: Update API Route Handlers

In route files (`*_api.py`, `routes/*.py`):

**Before:**

```python
@router.get("/api/trips/{trip_id}")
async def get_trip(trip_id: str):
    try:
        trip = await TripService.get_trip(trip_id)
        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")
        return {"status": "success", "trip": trip}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
```

**After:**

```python
from core.exceptions import ResourceNotFoundException

@router.get("/api/trips/{trip_id}")
@api_route(logger)
async def get_trip(trip_id: str):
    trip = await TripService.get_trip(trip_id)
    if not trip:
        raise ResourceNotFoundException(f"Trip {trip_id} not found")
    return {"status": "success", "trip": trip}
```

---

## Phase 3: Aggregation Utilities (Medium Priority)

### Migrate Analytics Services to Use `db/aggregation_utils.py`

#### Files to Migrate

- [ ] `analytics/services/trip_analytics_service.py`
- [ ] `analytics/services/dashboard_service.py`
- [ ] `visits/services/visit_stats_service.py`
- [ ] Any other file with MongoDB aggregation pipelines

#### Migration Pattern

**Before:**

```python
from api_utils import get_mongo_tz_expr

tz_expr = get_mongo_tz_expr()
pipeline = [
    {"$match": query},
    {
        "$group": {
            "_id": {
                "date": {
                    "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": "$startTime",
                        "timezone": tz_expr
                    }
                }
            },
            "totalDistance": {"$sum": "$distance"}
        }
    }
]
```

**After:**

```python
from db.aggregation_utils import build_date_grouping_stage, organize_by_dimension

pipeline = [
    {"$match": query},
    build_date_grouping_stage(
        date_field="$startTime",
        group_by=["date"],
        sum_fields={"totalDistance": "$distance"}
    )
]

# Organize results
results = await aggregate_with_retry(collection, pipeline)
daily_data = organize_by_dimension(results, "date")
```

---

## Phase 4: Import Organization (Low Priority)

### Standardize Import Order

Follow PEP 8 import order in all Python files:

1. Standard library imports
2. Third-party imports
3. Local application imports

**Before:**

```python
from db import trips_collection
import asyncio
from fastapi import HTTPException
import logging
from utils import get_session
```

**After:**

```python
# Standard library
import asyncio
import logging

# Third-party
from fastapi import HTTPException

# Local application
from core.http.session import get_session
from db import trips_collection
```

#### Tool to Help

```bash
# Install isort
pip install isort

# Run on all files
isort **/*.py

# Or use with black for consistent formatting
black **/*.py
isort **/*.py
```

---

## Phase 5: Naming Standardization (Optional)

### Standardize Beanie Model Field Naming

Currently models have mixed naming conventions:

- camelCase: `transactionId`, `startTime`, `endTime`
- snake_case: `last_updated`, `closed_reason`

**Recommendation:** Choose one convention and apply consistently.

#### Option 1: Keep camelCase (matches API responses)

Benefits: Consistency with external APIs (Bouncie)

#### Option 2: Convert to snake_case (Python convention)

Benefits: Follows Python naming conventions

**Implementation:**

```python
# If choosing snake_case, add aliases for backward compatibility
class Trip(Document):
    transaction_id: Indexed(str, unique=True) | None = Field(None, alias="transactionId")
    start_time: datetime | None = Field(None, alias="startTime")
    end_time: datetime | None = Field(None, alias="endTime")
```

---

## Phase 6: Remove Backward Compatibility (Future)

### After All Migrations Complete

#### Step 1: Remove Re-exports from utils.py

Once all imports have been migrated to core modules, remove re-exports:

**Current utils.py:**

```python
# Re-export for backward compatibility
from core.http.session import get_session
from core.http.retry import retry_async
# ...
```

**After Migration:**

```python
# Remove all re-exports
# Keep only calculate_distance() and meters_to_miles()
```

#### Step 2: Update Documentation

Remove deprecation notices and update all documentation to reference new modules.

---

## Testing Checklist

### Before Each Phase

- [ ] Create feature branch
- [ ] Make changes
- [ ] Run syntax validation: `python3 -m py_compile <file>`
- [ ] Run type checking: `mypy <file>` (if using mypy)
- [ ] Run tests: `pytest tests/`
- [ ] Test affected API endpoints manually
- [ ] Check logs for any errors
- [ ] Merge to main only after verification

### Critical Test Areas

#### Error Handling

- [ ] Test ValidationException → 400 response
- [ ] Test ResourceNotFoundException → 404 response
- [ ] Test RateLimitException → 429 response
- [ ] Test ExternalServiceException → 502 response
- [ ] Test generic Exception → 500 response

#### HTTP Utilities

- [ ] Test get_session() in main process
- [ ] Test get_session() after fork (Celery workers)
- [ ] Test retry_async() with network failures
- [ ] Test geocoding with Mapbox
- [ ] Test geocoding fallback to Nominatim

#### Aggregation Utilities

- [ ] Test date grouping with UTC timezone
- [ ] Test date grouping with custom timezone
- [ ] Test organize_by_dimension() with various dimensions
- [ ] Test edge cases (empty results, single result)

#### Async Bridge

- [ ] Test run_async_from_sync() in Celery task
- [ ] Test event loop cleanup
- [ ] Test multiple sequential calls
- [ ] Monitor for memory leaks

---

## Verification Commands

### Syntax Check All Files

```bash
find . -name "*.py" -not -path "./venv/*" -not -path "./node_modules/*" -exec python3 -m py_compile {} \;
```

### Find Files Still Using Old Imports

```bash
# Check for utils imports
grep -r "from utils import" --include="*.py" --exclude-dir=venv --exclude-dir=node_modules .

# Check for generic exceptions
grep -r "raise Exception\|raise ValueError" --include="*.py" --exclude-dir=venv --exclude-dir=node_modules .
```

### Run All Tests

```bash
# Run pytest
pytest

# Run with coverage
pytest --cov=. --cov-report=html
```

---

## Progress Tracking

### Phase 1: Import Updates

- [x] external_geo_service.py
- [ ] All other files importing from utils.py

### Phase 2: Exception Handling

- [x] api_utils.py enhanced
- [ ] Service layer files
- [ ] API route handler files

### Phase 3: Aggregation Utilities

- [ ] analytics/services/trip_analytics_service.py
- [ ] analytics/services/dashboard_service.py
- [ ] visits/services/visit_stats_service.py

### Phase 4: Import Organization

- [ ] All Python files formatted with isort/black

### Phase 5: Naming Standardization

- [ ] Decide on naming convention
- [ ] Update Beanie models
- [ ] Update all references

### Phase 6: Remove Backward Compatibility

- [ ] utils.py re-exports removed
- [ ] Documentation updated

---

## Rollback Procedure

If you encounter issues during migration:

1. **Keep new modules** - They don't break existing code
2. **Revert modified files** - Restore from git
3. **Keep utils.py intact** - It maintains backward compatibility
4. **Document the issue** - Note what went wrong
5. **Fix and retry** - Address the issue and try again

---

## Support

**Questions during migration?**

- Check [PYTHON_REFACTORING_SUMMARY.md](./PYTHON_REFACTORING_SUMMARY.md)
- Review inline documentation in new modules
- Check migration examples above

**Found an issue?**

- Document it clearly
- Create a minimal reproduction case
- Check if the old code had the same issue
- File an issue or ask for help

**Need help with a specific file?**

- Look at already-migrated files as examples (e.g., external_geo_service.py)
- Follow the patterns shown in this checklist
- Test thoroughly before and after

---

## Success Criteria

Migration is complete when:

- ✅ All files import from core modules instead of utils.py
- ✅ Service layer uses custom exceptions
- ✅ API routes use @api_route decorator with minimal try/except
- ✅ Analytics services use aggregation_utils.py
- ✅ All tests pass
- ✅ No errors in application logs
- ✅ API endpoints return proper error codes
- ✅ Documentation is updated

---

**Last Updated:** 2026-01-10
**Current Phase:** Phase 1 - Import Updates
**Priority:** High priority migrations should be done first
