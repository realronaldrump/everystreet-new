# Every Street — Comprehensive Codebase Audit

**Date:** 2026-02-26
**Scope:** Full application audit — backend, frontend, infrastructure, data model, and architecture

---

## Executive Summary

Every Street is a ~175,000-line application (50K Python, 69K JS, 33K CSS, 12K HTML) built on FastAPI + MongoDB + Redis + Mapbox GL, with self-hosted Valhalla (routing) and Nominatim (geocoding). It integrates with two Bouncie OBD2 trackers to track driving trips and calculate street-level coverage for selected areas.

**The core vision is sound and the architecture is well-intentioned.** The modular router design, Beanie ODM models, ARQ task queue, and Docker Compose stack are all good choices. However, the codebase has accumulated significant complexity debt across several dimensions:

1. **Duplicated logic** — ~500+ lines of copy-paste code in the trip pipeline alone; 6 files for trip history import that should be 2
2. **Incomplete features** — Turn-by-turn navigation, simulator mode, optimal route polling, auto-follow, and coverage layer switching are all half-built
3. **Frontend fragmentation** — 156 JS modules with 13+ different map instantiation patterns, no shared lifecycle management
4. **Coverage accuracy** — The core feature uses raw GPS (not map-matched geometry) for street matching, causing mismatches on parallel roads
5. **Custom implementations where libraries exist** — Custom greedy routing solver instead of OR-Tools, custom gap detection instead of standard segmentation, custom spatial indexing instead of leveraging MongoDB's native geo queries

**The good news:** The data model is clean, the test suite is substantial (81 Python + 24 JS test files), the Docker infrastructure is production-ready, and the core coverage algorithm works. This is a solid foundation to build on.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Critical Issues (Fix First)](#2-critical-issues)
3. [High-Priority Improvements](#3-high-priority-improvements)
4. [Code Quality & Dead Code](#4-code-quality--dead-code)
5. [Feature Completeness Audit](#5-feature-completeness-audit)
6. [Third-Party Opportunities](#6-third-party-opportunities)
7. [Frontend Consolidation Plan](#7-frontend-consolidation-plan)
8. [Performance Bottlenecks](#8-performance-bottlenecks)
9. [Recommended Action Plan](#9-recommended-action-plan)

---

## 1. Architecture Overview

### Tech Stack
| Layer | Technology | Notes |
|-------|-----------|-------|
| Web Framework | FastAPI (async) | 17+ modular routers |
| Database | MongoDB 7 (replica set) | Beanie ODM, Motor driver |
| Cache/Queue | Redis 7 | ARQ task queue, live trip state |
| Routing Engine | Valhalla (self-hosted) | Map matching + route planning |
| Geocoding | Nominatim (self-hosted) | Address lookup + boundary fetch |
| Frontend Maps | Mapbox GL JS | 156 JS modules |
| Charts | Chart.js | Analytics/insights |
| OSM Data | PyROSM + OSMnx | Street network extraction |
| Spatial | Shapely + GeoPandas + PyProj | Coverage calculations |
| Hex Grid | H3 | Mobility insights |
| Container | Docker Compose | 7 services + Watchtower auto-update |

### Data Flow
```
Bouncie API ──webhook──▶ Redis (live state) ──▶ WebSocket ──▶ Browser
     │                                                         (real-time map)
     │
     └──periodic sync──▶ Trip Pipeline ──▶ MongoDB (historical)
                             │
                             ├── Map Matching (Valhalla)
                             ├── Geocoding (Nominatim)
                             ├── Coverage Update (spatial matching)
                             └── Mobility Profile (H3 aggregation)
```

### Database Collections (21 Beanie models)
Trip, TripMobilityProfile, H3StreetLabelCache, RecurringRoute, TripIngestIssue, OsmData, Place, TaskConfig, TaskHistory, GasFillup, Vehicle, SetupSession, AppSettings, ServerLog, BouncieCredentials, CountyVisitedCache, CountyTopology, CoverageArea, CoverageState, Job, Street, MapServiceConfig, GeoServiceHealth

### Background Tasks (17 registered, 8 cron)
- `periodic_fetch_trips` — Every 12h, fetch new trips from Bouncie
- `validate_trips` — Every 12h, mark invalid/stationary trips
- `remap_unmatched_trips` — Every 6h, retry failed map matches
- `update_coverage_for_new_trips` — Every 3h, update coverage stats
- `sync_mobility_profiles` — Every 30min, H3 mobility data
- `fetch_all_missing_trips` — Manual, full history import (24h timeout)
- `generate_optimal_route` — Manual, route optimization (90min timeout)
- `build_recurring_routes` — Manual, trip clustering
- Plus: heartbeat, log purge, map data setup, map service monitoring, auto-provisioning

---

## 2. Critical Issues

### 2.1 Coverage Uses Raw GPS Instead of Map-Matched Geometry

**File:** `core/coverage.py`
**Impact:** Core feature accuracy

The street coverage calculation — the primary purpose of the app — uses raw GPS coordinates to determine which street segments have been driven. This means:
- GPS drift (40-foot buffer) can match the wrong street on parallel roads
- A trip that was correctly map-matched to Road A might be credited to adjacent Road B
- The map-matched geometry (`matchedGps`) is computed and stored but **never used for coverage**

**Fix:** Use `matchedGps` (Valhalla map-matched geometry) when available, falling back to raw GPS only when matching failed. This is a high-impact change that will significantly improve coverage accuracy.

### 2.2 Trip Pipeline Has 400+ Lines of Duplicated Code

**File:** `trips/pipeline.py` (897 lines)
**Impact:** Maintainability, bug surface area

`process_raw_trip()` (lines 96-256) and `process_raw_trip_insert_only()` (lines 257-394) share enormous amounts of duplicated logic. Similarly, `_validate_and_basic()` and `_validate_only()` are 90% identical.

**Fix:** Extract shared logic into `_process_validated_trip()` helper. Use a mode flag (`full` vs `insert_only`) instead of two separate methods.

### 2.3 Trip History Import Is Over-Fragmented (6 Files, 1,623 Lines)

**Files:** `trips/services/trip_history_import_service*.py` (6 files)
**Impact:** Maintainability, onboarding complexity

The import pipeline is split across 6 files with the main service file being just a re-export hub. Functions like `_fetch_device_window` take **17 parameters**. Progress tracking logic is duplicated with different formulas across files.

**Fix:** Consolidate into 2-3 files max. Wrap the 17 parameters into an `ImportContext` dataclass. Unify progress calculation.

### 2.4 Webhook Auth Has Race Condition

**File:** `tracking/api/webhooks.py` (lines 56-58)
**Impact:** Security

If a webhook arrives before credentials are saved, the code accepts the auth header as the webhook key and stores it. An attacker could send an arbitrary key that gets persisted.

**Fix:** Require `webhook_key` to be pre-configured before accepting webhooks. Reject webhooks when no key is configured.

### 2.5 Map Matching Produces Straight Lines (Known Bug)

**File:** `trips/services/matching.py`
**Impact:** Data quality

The chunking algorithm for large traces uses a brittle deduplication strategy at chunk boundaries — it compares exact coordinates (`final_matched[-1] == matched[0]`). When Valhalla fails on a chunk, the fallback recursive splitting can produce disconnected segments that appear as straight lines on the map.

**Fix:** Implement overlap strategy (2-3 overlapping points at chunk boundaries) instead of exact-match deduplication. Add validation that matched geometry is continuous (no >500m jumps between consecutive points).

---

## 3. High-Priority Improvements

### 3.1 Frontend: 13+ Map Instantiation Patterns

**Files:** `static/js/modules/map-core.js`, `map-base.js`, and 13+ feature modules
**Impact:** Consistency, memory, testing

Maps are created via `mapCore.getMap()`, `createMap()` from map-base.js, AND direct `new mapboxgl.Map()` calls. The Mapbox token is hardcoded in 3 separate places.

**Fix:** Standardize on `mapCore` singleton. Remove `map-base.js`. Centralize token in one location.

### 3.2 LiveTripTracker Is a 1,651-Line Monolith

**File:** `static/js/modules/features/tracking/index.js`
**Impact:** Testability, maintainability

Single file handling WebSocket connection, map rendering, UI state, and heatmap integration.

**Fix:** Split into: `tracking-ws.js` (connection), `tracking-renderer.js` (map layers), `tracking-state.js` (state machine), `tracking-heatmap.js` (heatmap integration).

### 3.3 Visits System Has Parallel Implementations

**Files:** `static/js/modules/visits/` (legacy) AND `static/js/modules/features/visits/` (new)
**Impact:** Confusion, wasted code

Two complete implementations exist. VisitsManager alone is 19KB with 30+ methods.

**Fix:** Determine authoritative implementation, remove the other, and split the surviving one into focused modules.

### 3.4 Analytics Pipelines Have No Caching

**Files:** `analytics/services/*.py`
**Impact:** Performance

Large MongoDB aggregation pipelines are recalculated on every request. Dashboard, trip analytics, and mobility insights all hit the database fresh.

**Fix:** Add Redis-based caching with TTL for aggregate queries. Invalidate on trip insert/update.

### 3.5 ConnectionManager in Live API Is Dead Code

**File:** `tracking/api/live.py` (lines 40-55)
**Impact:** Code clarity

`ConnectionManager` class maintains an `active_connections` list that is never read or used.

**Fix:** Remove it or implement proper connection tracking.

### 3.6 Processing API Ignores Its Own Options

**File:** `processing/api.py` (line 52)
**Impact:** Bug

`process_single_trip` hardcodes `map_match=False`, ignoring the `options.map_match` flag from the API request.

**Fix:** Use `options.map_match` instead of hardcoded `False`.

---

## 4. Code Quality & Dead Code

### Dead Code Identified (~150+ lines)

| Location | What | Action |
|----------|------|--------|
| `tracking/api/live.py:40-55` | ConnectionManager class | Remove |
| `tracking/services/tracking_service.py:34-36` | `_last_seen_at`, `_last_seen_event_type`, `_last_saved_at` globals | Remove (duplicates DB state) |
| `static/js/modules/insights/charts.js:68+` | `spotlightPlugin` | Remove (never activated) |
| `static/js/modules/map-base.js` | Entire file | Remove (consolidate into map-core) |
| `static/js/modules/features/map/index.js` scroll tilt | Mobile-disabled scroll tilt code | Remove |
| `trips/services/trip_history_import_service.py` | Re-export hub (128 lines, no logic) | Inline into consolidated module |

### Overly Complex Patterns

| Location | What | Simplification |
|----------|------|---------------|
| `trips/pipeline.py:619-629` | `_gps_quality()` tuple scoring | Simplify to boolean comparison |
| `config.py:47-72` | `validate_mapbox_token()` + `require_mapbox_token()` chain | Single function (token is hardcoded) |
| `config.py:82-127` | 8 `require_*` functions that just call `get_*` | Remove `require_*` variants (they add no validation) |
| `core/service_config.py` | Manual cache invalidation | Add TTL-based expiry |
| `tasks/config.py` | Status strings as raw strings | Use enum |

### Code Duplication

| Pattern | Locations | Fix |
|---------|-----------|-----|
| Trip validation + basic processing | `pipeline.py` lines 396-467 | Extract shared method |
| Progress tracking formulas | `trip_history_import_service_fetch.py:334`, `_processing.py:285` | Unify formula |
| Date/time formatting | 4+ JS modules | Centralize in `utils/date-utils.js` |
| Table creation | 4 functions in visits JS | Single configurable table factory |
| Debounce/throttle | Multiple JS modules | Shared utility |
| Map creation | 13+ JS modules | Single `mapCore` entry point |
| Bouncie source enforcement | Multiple analytics services | Already centralized in `trip_source_policy.py` — ensure all call sites use it |

---

## 5. Feature Completeness Audit

### Working Well
- Trip sync from Bouncie API (periodic + manual)
- Trip validation and filtering
- Coverage area creation and management
- Street segmentation (150ft fixed segments)
- Coverage statistics with delta updates
- Map matching via Valhalla (when it works)
- Geocoding via Nominatim
- Gas tracking with MPG calculation
- County visited tracking
- Server logs viewer
- Settings management UI
- Setup wizard
- Docker deployment with auto-updates

### Partially Working (Needs Fixes)
| Feature | Status | Issue |
|---------|--------|-------|
| Live tracking | ~70% | WebSocket reconnection lacks backoff; stale recovery is reactive |
| Map matching | ~60% | Chunking produces straight lines; no quality validation |
| Coverage accuracy | ~75% | Uses raw GPS instead of matched geometry |
| Recurring routes | ~80% | Complex fingerprinting with unclear correctness |
| Export system | ~85% | No disk space management; retention policy incomplete |
| Coverage backfill | ~80% | Re-runs recalculate all timestamps; no idempotency guard |

### Incomplete / Half-Built
| Feature | Status | Recommendation |
|---------|--------|---------------|
| Turn-by-turn navigation | ~40% | GPS denial not handled; coverage baseline never reconciles with server; maneuver classification too simple |
| Optimal route generation | ~50% | Polling incomplete; custom greedy solver with no quality guarantees |
| Simulator mode | ~90% complete but hidden | Add UI entry point or document as developer tool |
| Auto-follow location | ~20% | Initialized but no UI toggle |
| Advanced layer reordering | ~10% | Drag-and-drop code present but not wired |
| Coverage layer switching | ~30% | Dropdown exists but switching logic incomplete |

### Not Yet Built (From Vision)
| Feature | Notes |
|---------|-------|
| "Just because you cross an intersection, the street isn't considered travelled" | Current 150ft segments + 40ft buffer partially handles this, but needs refinement |
| Real-time driving view with seamless Bouncie integration | Live tracking exists but is unreliable; needs WebSocket hardening |
| Wandrer-style "new streets" celebration/gamification | No gamification beyond progress percentage |
| Street-level navigation guidance | Turn-by-turn exists but incomplete |

---

## 6. Third-Party Opportunities

### Replace Custom Implementations

| Current Custom Code | Recommended Library | Benefit |
|--------------------|-------------------|---------|
| Custom greedy routing solver (`routing/core.py`, 620 lines) | **Google OR-Tools** (Chinese Postman / Route Inspection solver) | Proven algorithms with approximation guarantees; handles arc routing |
| Custom Dijkstra pathfinding (`routing/graph.py`) | **NetworkX built-in** `nx.shortest_path()` with weight | Already have NetworkX as dependency; their C-optimized Dijkstra is faster |
| Custom GPS gap detection (`core/coverage.py`) | **MovingPandas** `TrajectoryCollection` | Purpose-built for trajectory segmentation; handles gaps, stops, speed changes |
| Custom spatial index wrapping (`core/coverage.py`) | **MongoDB 2dsphere queries** or keep STRtree but pre-build once | MongoDB already has geospatial indexes on Streets; avoid loading all segments into memory |
| Custom retry logic (multiple files) | **tenacity** (already in requirements) | Already a dependency but underused; standardize all retries through it |
| Custom map-matching chunk management | **Valhalla's built-in `trace_attributes`** | Valhalla handles chunking internally for `trace_attributes`; only `trace_route` needs manual chunking |
| Custom progress tracking across 6 files | **tqdm** or **rich.progress** for server-side; single SSE emitter pattern for client | Simpler, battle-tested progress reporting |

### Add New Libraries

| Need | Library | Why |
|------|---------|-----|
| Coverage accuracy | **OSRM match service** (alternative to Valhalla) | OSRM's matching is sometimes more reliable for car GPS traces |
| Trip quality detection | **scikit-mobility** | Purpose-built for mobility data analysis; detects stops, compresses trajectories |
| Route optimization | **OR-Tools** | Industry-standard for vehicle routing problems |
| Frontend state management | **Zustand** or **nanostores** | Lightweight reactive state; replace scattered `store.js` pattern |
| Frontend map lifecycle | Shared `MapManager` singleton | One place for all map creation, destruction, and cleanup |

---

## 7. Frontend Consolidation Plan

### Current State: 156 JS Modules, No Build Step

The frontend uses vanilla ES modules loaded directly by the browser with `no-cache` headers. This is simple but leads to:
- No tree-shaking (dead code shipped to browser)
- No minification (69K lines of JS served as-is)
- No type checking
- Module duplication (same utilities in multiple files)

### Recommended Approach

**Phase 1 (No framework change):** Consolidate without adding a build step
1. Merge `map-base.js` into `map-core.js` — single map entry point
2. Create `utils/index.js` that re-exports all shared utilities
3. Remove duplicate implementations (visits, date formatting, table factories)
4. Add JSDoc type annotations to core modules

**Phase 2 (Optional):** Add a lightweight build step
1. **Vite** for bundling + HMR during development
2. TypeScript for core modules (gradual migration)
3. Tree-shaking to eliminate dead code
4. Code splitting per page

### Module Reduction Target
- Current: 156 JS modules
- Target: ~80-90 modules (remove duplicates, merge tiny files, consolidate related code)

---

## 8. Performance Bottlenecks

### Backend

| Bottleneck | Location | Impact | Fix |
|-----------|----------|--------|-----|
| Spatial index built per-area in memory | `core/coverage.py` AreaSegmentIndex | 100K+ segments loaded into RAM | Cache the STRtree; or use MongoDB geo queries |
| Backfill processes ALL historical trips | `core/coverage.py` | Minutes to hours for large histories | Track last-processed trip timestamp; process only new trips |
| Analytics aggregations uncached | `analytics/services/*.py` | Every dashboard load hits DB | Redis cache with TTL |
| County STRtree rebuilt per call | `county/services/county_service.py` | Expensive on every county lookup | Cache the index as module-level singleton |
| OSMnx graph loading | `street_coverage/preprocessing.py` | Memory-intensive for large areas | Already has memory limits; consider streaming processing |
| Trip history import window: 7 days | `trip_history_import_service_config.py` | Fixed window, not Bouncie API limit | Document the constraint; allow larger windows if API permits |

### Frontend

| Bottleneck | Location | Impact | Fix |
|-----------|----------|--------|-----|
| 15-20 preview maps per page | `visits/visits-manager.js` | ~50MB each = 750MB+ | Lazy-load; use static image preview instead |
| Chart instances not destroyed | `insights/charts.js` | Orphaned canvases accumulate | Track and destroy on navigation |
| No code splitting | All JS modules | Full 69K lines loaded | Add Vite build step with per-page chunks |
| WebSocket without backoff | `tracking/websocket.js` | Reconnection storms | Exponential backoff with jitter |

---

## 9. Recommended Action Plan

### Phase 1: Stabilize Core (Week 1-2)

**Goal:** Fix the critical issues that affect data accuracy and reliability.

1. **Use map-matched geometry for coverage** (`core/coverage.py`)
   - When `matchedGps` exists on a trip, use it instead of raw `gps`
   - Fall back to raw GPS only when `matchStatus != "matched"`
   - This single change will significantly improve coverage accuracy

2. **Fix map matching straight-line bug** (`trips/services/matching.py`)
   - Add overlap at chunk boundaries (2-3 points)
   - Add post-match validation: reject results with >500m jumps between consecutive points
   - Log and flag trips that fail validation for manual review

3. **Fix webhook auth race condition** (`tracking/api/webhooks.py`)
   - Reject webhooks when no `webhook_key` is configured
   - Add explicit "awaiting configuration" state

4. **Fix processing API ignoring options** (`processing/api.py`)
   - Use `options.map_match` instead of hardcoded `False`

### Phase 2: Reduce Complexity (Week 2-4)

**Goal:** Consolidate duplicated code and simplify the most complex subsystems.

5. **Refactor trip pipeline** (`trips/pipeline.py`)
   - Merge `process_raw_trip` and `process_raw_trip_insert_only` into single method
   - Extract `_validate_and_basic` shared logic
   - Target: reduce from 897 lines to ~500 lines

6. **Consolidate trip history import** (6 files → 2-3)
   - Create `ImportContext` dataclass to replace 17-parameter functions
   - Merge config + progress into one file
   - Merge fetch + processing into one file
   - Keep runtime as orchestrator

7. **Remove dead code**
   - ConnectionManager in live.py
   - Global tracking variables in tracking_service.py
   - spotlightPlugin in charts.js
   - map-base.js (merge into map-core.js)
   - require_* wrapper functions in config.py

8. **Standardize frontend map creation**
   - Single entry point through `mapCore`
   - Remove all direct `new mapboxgl.Map()` calls
   - Centralize Mapbox token

### Phase 3: Harden Features (Week 4-6)

**Goal:** Make partially-working features reliable.

9. **Harden live tracking**
   - Add exponential backoff to WebSocket reconnection
   - Proactive stale detection (not just reactive)
   - Test connection recovery scenarios

10. **Add analytics caching**
    - Redis cache for dashboard aggregations (5-min TTL)
    - Invalidate on trip insert via event bus
    - Reduces DB load significantly

11. **Improve coverage backfill**
    - Track last-processed trip per area
    - Only process new trips on subsequent runs
    - Add progress reporting to UI

12. **Complete turn-by-turn basics**
    - Handle GPS permission denial gracefully
    - Reconcile coverage baseline with server on navigation start
    - Clean up theme observer on destroy

### Phase 4: Enhance & Optimize (Week 6-8)

**Goal:** Add missing capabilities and optimize performance.

13. **Integrate OR-Tools for route optimization**
    - Replace custom greedy solver with Chinese Postman Problem solver
    - Better route quality with mathematical guarantees
    - Handles disconnected graph components properly

14. **Add frontend build step (Vite)**
    - Per-page code splitting
    - Tree-shaking dead code
    - Minification (est. 60-70% size reduction)
    - TypeScript for core modules

15. **Lazy-load visit preview maps**
    - Replace 15-20 eager Mapbox instances with static image thumbnails
    - Load interactive map only on click/hover
    - Reduces memory from ~750MB to ~50MB

16. **Add gamification elements**
    - "New streets driven today" counter
    - Milestone celebrations (25%, 50%, 75%, 100%)
    - Streak tracking (consecutive days with new streets)
    - Leaderboard against own historical progress

### Phase 5: Polish & Scale (Week 8+)

17. **Resolve visits system duplication** — Pick one implementation, remove the other
18. **Consolidate JS modules** — Target 80-90 from current 156
19. **Add integration tests** for critical flows (Bouncie webhook → coverage update)
20. **Improve recurring routes** — Validate fingerprinting algorithm, add tests
21. **Document simulator mode** or surface it in the UI
22. **Add circuit breaker** for Valhalla/Nominatim service calls

---

## Appendix: File Size Hotspots

### Largest Python Files (non-test)
| File | Lines | Concern |
|------|-------|---------|
| `routing/service.py` | 1,639 | Route optimization orchestration |
| `street_coverage/ingestion.py` | 1,299 | Area creation pipeline |
| `analytics/services/mobility_insights_service.py` | 1,186 | H3 mobility analysis |
| `tasks/map_data.py` | 1,115 | Valhalla/Nominatim management |
| `core/coverage.py` | 1,111 | **Core coverage matching** |
| `db/models.py` | 1,065 | All 21 Beanie models |
| `recurring_routes/services/place_pair_analysis.py` | 973 | O/D route analysis |
| `trips/pipeline.py` | 897 | **Trip processing pipeline** |
| `street_coverage/preprocessing.py` | 893 | OSM data extraction |

### Largest JS Files
| File | Lines | Concern |
|------|-------|---------|
| `features/routes/index.js` | 3,180 | Route visualization |
| `features/trips/index.js` | 2,702 | Trip list/detail view |
| `features/coverage-management/index.js` | 2,273 | Coverage area management |
| `features/map-matching/index.js` | 2,240 | Map matching UI |
| `features/tracking/index.js` | 1,651 | **Live tracking monolith** |
| `features/visits/visits-controller.js` | 1,618 | Visits management |
| `features/server-logs/index.js` | 1,606 | Log viewer |
| `layer-manager.js` | 1,404 | Map layer management |

---

## Appendix: Codebase Statistics

| Metric | Value |
|--------|-------|
| Total lines of code | ~175,000 |
| Python source (non-test) | ~50,700 |
| JavaScript | ~68,800 |
| CSS | ~32,800 |
| HTML templates | ~11,800 |
| Python tests | ~10,900 (81 files) |
| JS tests | 24 files |
| Beanie document models | 21 |
| API routers | 17+ |
| Background tasks | 17 registered |
| Cron jobs | 8 |
| Docker services | 7 |
| JS modules | 156 |
| Python packages | 30+ |
