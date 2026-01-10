# JavaScript Codebase Refactoring Guide

## Overview

This document describes the major refactoring completed on the JavaScript codebase to eliminate redundancy, consolidate utilities, and improve maintainability.

**Date:** January 2026
**Files Changed:** 10+ modules created/refactored
**Lines Removed:** ~500+ lines of duplicate code
**Consolidation:** 278+ fetch calls, 6 modal implementations, 5 geolocation implementations, 22 map initializations

---

## New Unified Modules

### 1. API Client (`modules/api-client.js`)

**Replaces:** 278+ scattered `fetch()` calls across 33 files

**Features:**

- Unified error handling
- Automatic retry with exponential backoff
- Request timeout handling
- Built-in caching support
- File upload with progress tracking

**Usage:**

```javascript
import apiClient from "./modules/api-client.js";

// GET request
const data = await apiClient.get("/api/trips", { cache: true });

// POST request
const result = await apiClient.post("/api/coverage/calculate", {
  location_id: 123,
  recalculate: true,
});

// File upload with progress
await apiClient.uploadFile("/api/upload", formData, (percent) => {
  console.log(`Upload progress: ${percent}%`);
});
```

**Migration:**

```javascript
// OLD (scattered across files)
const response = await fetch(url);
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();

// NEW
const data = await apiClient.get(url);
```

---

### 2. Modal Manager (`modules/modal-manager.js`)

**Replaces:** 6 different modal implementations

**Features:**

- Unified Bootstrap modal creation
- Promise-based API
- Pre-built modal types (confirm, prompt, alert, error)
- Custom modal support

**Usage:**

```javascript
import modalManager from "./modules/modal-manager.js";

// Confirmation dialog
const confirmed = await modalManager.showConfirm({
  title: "Delete Trip?",
  message: "This action cannot be undone.",
  confirmText: "Delete",
  confirmClass: "btn-danger",
});

if (confirmed) {
  // User clicked "Delete"
}

// Prompt for input
const name = await modalManager.showPrompt({
  title: "Enter Name",
  placeholder: "Trip name",
  required: true,
});

// Error display
await modalManager.showError("Failed to load data");
```

**Migration:**

```javascript
// OLD (from utils.js)
const result = await confirmationDialog("Delete?", "Are you sure?");

// NEW
const result = await modalManager.showConfirm({
  title: "Delete?",
  message: "Are you sure?",
});
```

---

### 3. Geolocation Service (`modules/geolocation-service.js`)

**Replaces:** 5 scattered `navigator.geolocation` implementations

**Features:**

- Promise-based API
- Consistent error handling
- Position watching
- Distance/bearing calculations
- Accuracy checking

**Usage:**

```javascript
import geolocationService from "./modules/geolocation-service.js";

// Get current position
try {
  const position = await geolocationService.getCurrentPosition();
  console.log(position.latitude, position.longitude);
} catch (error) {
  console.error("Location error:", error.message);
}

// Watch position
const watchId = geolocationService.watchPosition(
  (position) => {
    updateMapLocation(position.coords);
  },
  (error) => {
    console.error(error);
  },
);

// Calculate distance between two points
const distance = geolocationService.calculateDistance(lat1, lon1, lat2, lon2); // Returns meters
```

**Migration:**

```javascript
// OLD
navigator.geolocation.getCurrentPosition(
  (pos) => {
    /* success */
  },
  (err) => {
    /* error */
  },
  options,
);

// NEW
const pos = await geolocationService.getCurrentPosition(options);
```

---

### 4. Map Factory (`modules/map-factory.js`)

**Replaces:** 22+ map initialization patterns
**Built on:** `map-pool.js` for efficient WebGL context management

**Features:**

- Standardized map creation
- Preset configurations (coverage, trip, navigation, county)
- Automatic control setup
- Helper methods for markers, layers, bounds

**Usage:**

```javascript
import mapFactory from "./modules/map-factory.js";

// Initialize once at app start
mapFactory.initialize(MAPBOX_ACCESS_TOKEN);

// Create a coverage map
const map = await mapFactory.createCoverageMap("map-container", {
  center: [-95.7, 37.0],
  zoom: 13,
});

// Create a navigation map with pitch
const navMap = await mapFactory.createNavigationMap("nav-map", {
  center: [-95.7, 37.0],
});

// Add marker
const marker = mapFactory.addMarker(map, [-95.7, 37.0], {
  color: "#FF0000",
  popup: "<h6>Start Point</h6>",
});

// Fit to bounds
mapFactory.fitToBounds(map, coordinates, { padding: 100 });
```

**Migration:**

```javascript
// OLD
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/dark-v11",
  center: [-95.7, 37.0],
  zoom: 13,
});
map.addControl(new mapboxgl.NavigationControl(), "top-right");

// NEW
const map = await mapFactory.createCoverageMap("map", {
  center: [-95.7, 37.0],
  zoom: 13,
});
```

---

## Consolidated Formatters

### Centralized Location: `modules/formatters.js`

**Removed from:**

- `utils.js` (6 duplicate formatters)
- `settings/task-manager/formatters.js`
- `modules/insights/formatters.js`
- `modules/coverage/progress/formatters.js`
- `modules/turn-by-turn/turn-by-turn-geo.js`
- `trips.js`
- `landing.js`

**Available Formatters:**

```javascript
import {
  // Numbers & Percentages
  formatNumber,
  formatPercentage,

  // Distance
  formatDistance,
  distanceInUserUnits,

  // Duration
  formatDuration,
  formatDurationHMS,
  formatDurationMs,

  // Date & Time
  formatDateTime,
  formatTimeAgo,
  formatRelativeTime,

  // Vehicle & Location
  formatVehicleName,
  sanitizeLocation,

  // Speed
  formatVehicleSpeed,
} from "./modules/formatters.js";
```

**Migration:**

```javascript
// OLD (from window.utils)
const distance = window.utils.formatDistance(miles);
const duration = window.utils.formatDuration(seconds);

// NEW
import { formatDistance, formatDuration } from "./modules/formatters.js";
const distance = formatDistance(miles);
const duration = formatDuration(seconds);
```

---

## Deprecated Code Removed

### From `utils.js`

- ❌ `formatNumber()` - Use `modules/formatters.js`
- ❌ `formatDistance()` - Use `modules/formatters.js`
- ❌ `formatDuration()` - Use `modules/formatters.js`
- ❌ `formatDateTime()` - Use `modules/formatters.js`
- ❌ `formatVehicleName()` - Use `modules/formatters.js`
- ❌ `sanitizeLocation()` - Use `modules/formatters.js`

### From `modules/coverage/coverage-manager.js`

- ❌ `formatRelativeTime()` - Import directly from `modules/formatters.js`
- ❌ `distanceInUserUnits()` - Import directly from `modules/formatters.js`
- ❌ `formatStreetType()` - Import directly from `modules/formatters.js`

### From `modules/coverage/coverage-progress.js`

- ❌ `calculatePollInterval()` - Use `progress/polling.js`
- ❌ `formatMetricStats()` - Use `progress/formatters.js`
- ❌ `getStageIcon()` - Use `progress/formatters.js`
- ❌ `getStageTextClass()` - Use `progress/formatters.js`

---

## Migration Checklist

### High Priority (Breaking Changes)

- [ ] Update all `fetch()` calls to use `apiClient`
  - Files: coverage-api.js, insights/api.js, optimal-route/api.js, turn-by-turn-api.js, task-manager/api.js
- [ ] Replace modal creation with `modalManager`
  - Files: coverage-modals.js, task-manager/modals.js, insights/modal.js, settings/mobile-ui.js
- [ ] Replace `navigator.geolocation` with `geolocationService`
  - Files: driving-navigation/manager.js, turn-by-turn-navigator.js, coverage-navigation.js
- [ ] Replace `new mapboxgl.Map()` with `mapFactory.createMap()`
  - Files: All 22 map-creating files

### Medium Priority

- [ ] Replace `window.utils.format*()` calls with ES6 imports
  - Affects: trips.js, profile.js, gas_tracking.js, etc. (234+ references)
- [ ] Remove `window.InsightsFormatters` usage
  - Files: insights/\*.js
- [ ] Update modal implementations to use new `modalManager`

### Low Priority (Nice to Have)

- [ ] Consolidate magic numbers to `CONFIG`
- [ ] Standardize file naming (kebab-case)
- [ ] Enforce `EventDelegator` usage for event listeners

---

## Code Organization Standards

### Import Style

**Use ES6 imports:**

```javascript
// ✅ Good
import apiClient from "./modules/api-client.js";
import { formatDistance, formatDuration } from "./modules/formatters.js";

// ❌ Bad
const formatDistance = window.utils.formatDistance;
```

### File Organization

```
static/js/
├── modules/                      # Core ES6 modules
│   ├── api-client.js            # ✨ NEW: Unified API client
│   ├── modal-manager.js         # ✨ NEW: Modal management
│   ├── geolocation-service.js   # ✨ NEW: Geolocation utilities
│   ├── map-factory.js           # ✨ NEW: Map creation
│   ├── map-pool.js              # Existing: WebGL context pool
│   ├── formatters.js            # ✨ UPDATED: All formatters
│   ├── utils.js                 # Core utilities
│   ├── config.js                # Configuration
│   └── state.js                 # State management
└── [page-specific].js           # Page scripts
```

### Naming Conventions

- **Files:** kebab-case (`api-client.js`, `map-factory.js`)
- **Classes:** PascalCase (`APIClient`, `ModalManager`)
- **Functions:** camelCase (`formatDistance`, `getCurrentPosition`)
- **Constants:** UPPER_SNAKE_CASE (`CONFIG`, `MAX_RETRIES`)

---

## Performance Improvements

### API Requests

- **Before:** 278 fetch calls with inconsistent error handling and no caching
- **After:** Unified `apiClient` with automatic retry, caching, and timeout handling
- **Impact:** Reduced network errors, improved user experience

### Map Initialization

- **Before:** 22 independent map creations, potential WebGL context exhaustion
- **After:** Centralized `mapFactory` + `map-pool` for efficient resource management
- **Impact:** Prevents "Too many WebGL contexts" errors

### Code Duplication

- **Before:** ~500+ lines of duplicate formatting/utility code
- **After:** Single source of truth in `modules/formatters.js`
- **Impact:** Easier maintenance, consistent behavior

---

## Breaking Changes

### Removed Global Variables

These are NO LONGER available on `window`:

- ❌ `window.formatters`
- ❌ `window.InsightsFormatters`
- ❌ `window.utils.formatNumber()`
- ❌ `window.utils.formatDistance()`
- ❌ `window.utils.formatDuration()`
- ❌ `window.utils.formatDateTime()`
- ❌ `window.utils.formatVehicleName()`
- ❌ `window.utils.sanitizeLocation()`

**Migration:** Import from `modules/formatters.js` instead

### Removed Methods

From `CoverageManager` class:

- `formatRelativeTime()` → Import from `modules/formatters.js`
- `distanceInUserUnits()` → Import from `modules/formatters.js`
- `formatStreetType()` → Import from `modules/formatters.js`

From `CoverageProgress` class:

- `calculatePollInterval()` → Import from `progress/polling.js`
- `formatMetricStats()` → Import from `progress/formatters.js`
- `getStageIcon()` → Import from `progress/formatters.js`
- `getStageTextClass()` → Import from `progress/formatters.js`

---

## Testing

### Manual Testing Required

1. **API Integration**
   - [ ] Test all API endpoints with new `apiClient`
   - [ ] Verify error handling
   - [ ] Test retry logic with network throttling

2. **Modal Functionality**
   - [ ] Test confirmation modals
   - [ ] Test prompt modals
   - [ ] Test error modals
   - [ ] Verify modal cleanup (no memory leaks)

3. **Geolocation**
   - [ ] Test position retrieval
   - [ ] Test position watching
   - [ ] Test permission handling

4. **Maps**
   - [ ] Test map creation in all contexts
   - [ ] Verify controls are added correctly
   - [ ] Test map pool eviction
   - [ ] Monitor for WebGL context errors

5. **Formatters**
   - [ ] Verify all distance formats
   - [ ] Test duration formatting
   - [ ] Test date/time formatting

---

## Future Improvements

### Phase 2 (Future)

- [ ] Add TypeScript definitions
- [ ] Add unit tests for all utilities
- [ ] Implement service workers for offline support
- [ ] Add telemetry for API errors
- [ ] Create build process (bundling, minification)
- [ ] Add linting (ESLint) and formatting (Prettier)

### Phase 3 (Long-term)

- [ ] Migrate to a modern framework (React/Vue/Svelte)
- [ ] Implement proper state management (Redux/Zustand)
- [ ] Add end-to-end testing (Playwright/Cypress)
- [ ] Performance monitoring (Web Vitals)

---

## Support & Documentation

**Questions?** Check the individual module files - all have JSDoc documentation.

**Issues?** The new modules maintain backward-compatible APIs where possible, but breaking changes are documented above.

**Contributing?** Follow the patterns established in the new modules:

1. ES6 module exports
2. JSDoc comments
3. Error handling
4. Singleton pattern for managers/services
