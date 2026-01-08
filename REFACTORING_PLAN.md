# Codebase Refactoring Plan

## Executive Summary

This document outlines the comprehensive refactoring plan to transform the EveryStreet codebase from monolithic files into a well-organized, modular package structure following established best practices.

## Current State Analysis

### Monolithic Files Requiring Refactoring

| File | Lines | Type | Priority | Complexity |
|------|-------|------|----------|-----------|
| **db.py** | 1,234 | Infrastructure | Low | High |
| **trips.py** | 1,033 | API | High | High |
| **route_solver.py** | 1,095 | Algorithm | Medium | Very High |
| **analytics_api.py** | 884 | API | High | Medium |
| **export_api.py** | 789 | API | High | Medium |
| **visits.py** | 819 | API | High | Medium |
| **gas_api.py** | 1,179 | API | ✅ DONE | Medium |

### Already Refactored (Reference Patterns)

| Module | Original Lines | Status | Pattern |
|--------|---------------|--------|---------|
| **coverage/** | 2,130 | ✅ Complete | services/ + routes/ |
| **tasks/** | N/A | ✅ Complete | modular package |
| **gas/** | 1,179 | ✅ Complete | services/ + routes/ |

## Refactoring Strategy

### Pattern: Services + Routes Architecture

All API modules will follow this proven pattern:

```
module/
├── __init__.py                      # Router aggregation
├── README.md                        # Documentation
├── serializers.py                   # Data transformation (if needed)
├── services/                        # Business logic layer
│   ├── __init__.py
│   └── *_service.py                # Service classes
└── routes/                          # API endpoint handlers
    ├── __init__.py
    └── *.py                        # Route files by domain
```

### Benefits

1. **Separation of Concerns** - Business logic separate from API handling
2. **Testability** - Services can be unit tested without HTTP layer
3. **Reusability** - Services can be imported by other modules
4. **Maintainability** - Smaller files, clearer organization
5. **Scalability** - Easy to add new routes/services

## Detailed Refactoring Plans

### 1. ✅ gas_api.py → gas/ (COMPLETED)

**Status**: Complete
**Lines**: 1,179 → 1,395 (modular)
**Structure**:
```
gas/
├── services/
│   ├── vehicle_service.py (149 lines)
│   ├── fillup_service.py (336 lines)
│   ├── odometer_service.py (253 lines)
│   ├── statistics_service.py (227 lines)
│   └── bouncie_service.py (99 lines)
└── routes/
    ├── vehicles.py (72 lines)
    ├── fillups.py (97 lines)
    ├── location.py (42 lines)
    └── statistics.py (50 lines)
```

**Key Services**:
- VehicleService: Vehicle CRUD operations
- FillupService: Fill-up tracking + MPG calculations
- OdometerService: Location & odometer estimation
- StatisticsService: Gas statistics & vehicle sync
- BouncieService: External API integration

### 2. trips.py → trips/ (PRIORITY: HIGH)

**Current**: 1,033 lines
**Estimated New**: ~1,250 lines (modular)

**Proposed Structure**:
```
trips/
├── __init__.py
├── README.md
├── serializers.py                   # Date/GPS serialization
├── services/
│   ├── __init__.py
│   ├── trip_query_service.py       # Trip querying & filtering
│   ├── trip_crud_service.py        # Create, update, delete
│   ├── trip_stats_service.py       # Statistics & aggregations
│   ├── trip_cost_service.py        # Gas cost calculations
│   └── trip_export_service.py      # GPX/KML export
└── routes/
    ├── __init__.py
    ├── query.py                    # GET /api/trips, filtering
    ├── crud.py                     # POST/PUT/DELETE operations
    ├── stats.py                    # Statistics endpoints
    └── export.py                   # Export endpoints
```

**Key Responsibilities**:
- Trip CRUD operations
- Trip filtering & search
- Gas cost calculation integration
- Statistics aggregation
- GPX/KML export
- Calendar view support

**Dependencies**:
- gas.services.StatisticsService (for gas cost calc)
- TripService (existing utility)
- GeometryService (GPS validation)

### 3. analytics_api.py → analytics/ (PRIORITY: HIGH)

**Current**: 884 lines
**Estimated New**: ~1,000 lines (modular)

**Proposed Structure**:
```
analytics/
├── __init__.py
├── README.md
├── services/
│   ├── __init__.py
│   ├── coverage_analytics_service.py    # Coverage statistics
│   ├── trip_analytics_service.py        # Trip analytics
│   ├── time_analytics_service.py        # Time-based analysis
│   └── dashboard_service.py             # Dashboard data
└── routes/
    ├── __init__.py
    ├── coverage.py                      # Coverage analytics
    ├── trips.py                         # Trip analytics
    └── dashboard.py                     # Dashboard endpoints
```

**Key Responsibilities**:
- Coverage analytics (% complete, miles covered)
- Trip analytics (frequency, patterns, heatmaps)
- Time-based analysis (daily/weekly/monthly)
- Dashboard data aggregation

### 4. export_api.py → exports/ (PRIORITY: HIGH)

**Current**: 789 lines
**Estimated New**: ~900 lines (modular)

**Proposed Structure**:
```
exports/
├── __init__.py
├── README.md
├── services/
│   ├── __init__.py
│   ├── trip_export_service.py       # Trip GPX/KML export
│   ├── coverage_export_service.py   # Coverage data export
│   ├── data_export_service.py       # Generic CSV/JSON export
│   └── archive_service.py           # Data archival
└── routes/
    ├── __init__.py
    ├── trips.py                     # Trip export endpoints
    ├── coverage.py                  # Coverage export
    └── data.py                      # Generic export endpoints
```

**Key Responsibilities**:
- Trip export (GPX, KML, CSV, GeoJSON)
- Coverage export (GeoJSON, Shapefile)
- Data archival and backup
- Batch export operations

### 5. visits.py → visits/ (PRIORITY: HIGH)

**Current**: 819 lines
**Estimated New**: ~950 lines (modular)

**Proposed Structure**:
```
visits/
├── __init__.py
├── README.md
├── services/
│   ├── __init__.py
│   ├── visit_tracking_service.py    # Visit detection & tracking
│   ├── place_service.py             # Place management
│   └── visit_stats_service.py       # Visit statistics
└── routes/
    ├── __init__.py
    ├── visits.py                    # Visit CRUD endpoints
    ├── places.py                    # Place management
    └── stats.py                     # Visit statistics
```

**Key Responsibilities**:
- Visit detection from trip data
- Place identification & management
- Visit duration tracking
- Frequently visited places

### 6. route_solver.py (PRIORITY: MEDIUM - Special Case)

**Current**: 1,095 lines
**Complexity**: Very High (complex algorithm)

**Status**: Defer to later phase

**Rationale**:
- This is a complex algorithmic module, not an API
- Requires deep understanding of route optimization logic
- Breaking it up incorrectly could introduce bugs
- Lower priority than API modules
- Consider: Keep as single well-documented file OR refactor into:
  ```
  route_solver/
  ├── __init__.py
  ├── solver.py                      # Main solver logic
  ├── heuristics.py                  # Route heuristics
  ├── optimization.py                # Optimization algorithms
  └── validation.py                  # Solution validation
  ```

### 7. db.py (PRIORITY: LOW - Infrastructure)

**Current**: 1,234 lines
**Type**: Infrastructure/Utility

**Status**: Defer - Not critical

**Rationale**:
- Well-designed singleton pattern
- Heavily used by all modules
- Refactoring would require updating ~50+ files
- Already well-organized internally
- Breaking changes would be high risk
- Consider: Leave as-is OR minor cleanup:
  ```
  db/
  ├── __init__.py                    # Re-exports for compatibility
  ├── manager.py                     # DatabaseManager class
  ├── operations.py                  # Retry wrappers
  ├── collections.py                 # Collection definitions
  ├── indexes.py                     # Index creation
  └── serializers.py                 # Serialization utils
  ```

## Implementation Order

### Phase 1: High-Priority API Modules ✅
1. ✅ gas_api.py → gas/
2. ⏳ trips.py → trips/
3. ⏳ analytics_api.py → analytics/
4. ⏳ export_api.py → exports/
5. ⏳ visits.py → visits/

### Phase 2: Algorithm & Utility Modules
6. route_solver.py (evaluate if needed)

### Phase 3: Infrastructure (Optional)
7. db.py (only if team consensus agrees)

## Migration Checklist (Per Module)

### Before Refactoring
- [ ] Read entire file to understand structure
- [ ] Identify distinct responsibilities
- [ ] List all external dependencies
- [ ] Document key business logic

### During Refactoring
- [ ] Create module directory structure
- [ ] Extract services with business logic
- [ ] Create route handlers (thin layer)
- [ ] Write comprehensive README
- [ ] Add __init__.py with router aggregation
- [ ] Update imports in app.py

### After Refactoring
- [ ] Syntax check all Python files
- [ ] Backup original file (.bak)
- [ ] Test import in Python
- [ ] Verify all endpoints work
- [ ] Run integration tests
- [ ] Create refactoring summary document
- [ ] Remove backup file after verification

## Integration Pattern

Each refactored module integrates the same way:

**Before**:
```python
from module_api import router as module_router
app.include_router(module_router)
```

**After**:
```python
from module import router as module_router
app.include_router(module_router)
```

## Backwards Compatibility

All refactorings MUST maintain 100% backwards compatibility:
- ✅ Same API endpoints
- ✅ Same request/response formats
- ✅ Same query parameters
- ✅ Same business logic
- ✅ Zero client changes required

## Benefits Summary

### Development
- Faster navigation (find code in ~200 line files vs 1,000+)
- Safer refactoring (isolated changes)
- Clearer structure (obvious where code goes)
- Better imports (explicit service dependencies)

### Testing
- Unit testable services
- Mockable dependencies
- Isolated failures
- Faster test execution

### Maintenance
- Single responsibility per file
- Better error messages
- Easier debugging
- Comprehensive documentation

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking changes | High | Maintain 100% backwards compatibility |
| Import errors | Medium | Comprehensive syntax checks before deployment |
| Performance regression | Low | Services add minimal overhead |
| Team confusion | Medium | Thorough documentation + README per module |
| Incomplete refactoring | Medium | Complete one module fully before moving to next |

## Success Metrics

- [ ] All API modules < 1,000 lines
- [ ] Average file size < 250 lines
- [ ] 100% backwards compatible
- [ ] Comprehensive README per module
- [ ] All endpoints tested and working
- [ ] Zero client-side changes required

## Timeline Estimate

| Module | Estimated Time | Status |
|--------|---------------|--------|
| gas/ | 2-3 hours | ✅ Complete |
| trips/ | 2-3 hours | ⏳ In Progress |
| analytics/ | 2 hours | Pending |
| exports/ | 2 hours | Pending |
| visits/ | 2 hours | Pending |
| **Total** | **10-12 hours** | **20% Complete** |

## Next Steps

1. ✅ Complete gas/ refactoring
2. ⏳ Execute trips/ refactoring
3. Execute analytics/ refactoring
4. Execute exports/ refactoring
5. Execute visits/ refactoring
6. Comprehensive testing
7. Documentation updates
8. Remove backup files
9. Team review

## References

- `coverage/README.md` - Reference implementation
- `tasks/` - Reference package structure
- `GAS_REFACTORING_SUMMARY.md` - Detailed gas refactoring notes
- `REFACTORING_SUMMARY.md` - Coverage refactoring notes

## Conclusion

This refactoring plan transforms the EveryStreet codebase from monolithic files into a well-organized, maintainable architecture. Following the proven patterns from coverage/ and tasks/, we'll create a more testable, scalable, and developer-friendly codebase while maintaining 100% backwards compatibility.
