# Migration Examples

This document provides concrete before/after examples for migrating to the new unified modules.

---

## API Client Migration

### Example 1: Simple GET Request

**Before:**
```javascript
async function loadTrips() {
  const response = await fetch('/api/trips');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}
```

**After:**
```javascript
import apiClient from './modules/api-client.js';

async function loadTrips() {
  return apiClient.get('/api/trips');
}
```

---

### Example 2: POST Request with Error Handling

**Before:**
```javascript
async function createTrip(data) {
  try {
    const response = await fetch('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('Failed to create trip:', error);
    throw error;
  }
}
```

**After:**
```javascript
import apiClient from './modules/api-client.js';

async function createTrip(data) {
  return apiClient.post('/api/trips', data);
  // Error handling is built-in!
}
```

---

### Example 3: Request with Retry Logic

**Before:**
```javascript
async function loadDataWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
      if (response.status < 500) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
}
```

**After:**
```javascript
import apiClient from './modules/api-client.js';

async function loadDataWithRetry(url) {
  return apiClient.get(url, { retry: true });
  // Automatic retry with exponential backoff!
}
```

---

### Example 4: Cached Request

**Before:**
```javascript
const cache = new Map();

async function loadCached(url, ttl = 300000) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.time < ttl) {
    return cached.data;
  }

  const response = await fetch(url);
  const data = await response.json();
  cache.set(url, { data, time: Date.now() });
  return data;
}
```

**After:**
```javascript
import apiClient from './modules/api-client.js';

async function loadCached(url) {
  return apiClient.get(url, {
    cache: true,
    cacheDuration: 300000
  });
}
```

---

### Example 5: File Upload with Progress

**Before:**
```javascript
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress((e.loaded / e.total) * 100);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed'));
    });

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  });
}
```

**After:**
```javascript
import apiClient from './modules/api-client.js';

async function uploadFile(file, onProgress) {
  const formData = new FormData();
  formData.append('file', file);

  return apiClient.uploadFile('/api/upload', formData, (percent) => {
    onProgress(percent);
  });
}
```

---

## Modal Manager Migration

### Example 1: Confirmation Dialog

**Before (utils.js):**
```javascript
async function deleteTrip(tripId) {
  const confirmed = await confirmationDialog(
    'Delete Trip?',
    'This action cannot be undone. Are you sure?'
  );

  if (confirmed) {
    await fetch(`/api/trips/${tripId}`, { method: 'DELETE' });
  }
}
```

**After:**
```javascript
import modalManager from './modules/modal-manager.js';
import apiClient from './modules/api-client.js';

async function deleteTrip(tripId) {
  const confirmed = await modalManager.showConfirm({
    title: 'Delete Trip?',
    message: 'This action cannot be undone. Are you sure?',
    confirmText: 'Delete',
    confirmClass: 'btn-danger'
  });

  if (confirmed) {
    await apiClient.delete(`/api/trips/${tripId}`);
  }
}
```

---

### Example 2: Prompt Dialog

**Before:**
```javascript
const dialog = new PromptDialog({
  title: 'Rename Trip',
  message: 'Enter new name',
  defaultValue: currentName
});

const newName = await dialog.show();
if (newName) {
  // Save new name
}
```

**After:**
```javascript
import modalManager from './modules/modal-manager.js';

const newName = await modalManager.showPrompt({
  title: 'Rename Trip',
  message: 'Enter new name',
  defaultValue: currentName,
  required: true
});

if (newName) {
  // Save new name
}
```

---

### Example 3: Error Display

**Before:**
```javascript
function showError(message) {
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-content bg-dark text-white">
        <div class="modal-header">
          <h5 class="modal-title">Error</h5>
          <button class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">${message}</div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}
```

**After:**
```javascript
import modalManager from './modules/modal-manager.js';

async function showError(message) {
  await modalManager.showError(message);
}
```

---

## Geolocation Service Migration

### Example 1: Get Current Position

**Before:**
```javascript
function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude
        });
      },
      (error) => {
        if (error.code === 1) {
          reject(new Error('Location permission denied'));
        } else {
          reject(new Error('Failed to get location'));
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}
```

**After:**
```javascript
import geolocationService from './modules/geolocation-service.js';

async function getCurrentLocation() {
  const position = await geolocationService.getCurrentPosition();
  return position.coords; // { lat, lng }
}
```

---

### Example 2: Watch Position

**Before:**
```javascript
let watchId = null;

function startTracking(callback) {
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      callback({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      });
    },
    (error) => {
      console.error('Tracking error:', error);
    },
    { enableHighAccuracy: true }
  );
}

function stopTracking() {
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
  }
}
```

**After:**
```javascript
import geolocationService from './modules/geolocation-service.js';

function startTracking(callback) {
  geolocationService.watchPosition(
    (position) => {
      callback(position.coords);
    },
    (error) => {
      console.error('Tracking error:', error);
    }
  );
}

function stopTracking() {
  geolocationService.clearWatch();
}
```

---

### Example 3: Calculate Distance

**Before:**
```javascript
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
           Math.cos(φ1) * Math.cos(φ2) *
           Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // in meters
}
```

**After:**
```javascript
import geolocationService from './modules/geolocation-service.js';

function calculateDistance(lat1, lon1, lat2, lon2) {
  return geolocationService.calculateDistance(lat1, lon1, lat2, lon2);
}
```

---

## Map Factory Migration

### Example 1: Basic Map Creation

**Before:**
```javascript
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/dark-v11',
  center: [-95.7, 37.0],
  zoom: 4
});

map.addControl(new mapboxgl.NavigationControl(), 'top-right');
```

**After:**
```javascript
import mapFactory from './modules/map-factory.js';

// Initialize once at app start
mapFactory.initialize(MAPBOX_ACCESS_TOKEN);

// Create map
const map = await mapFactory.createMap('map', {
  center: [-95.7, 37.0],
  zoom: 4
});
```

---

### Example 2: Map with Geolocation

**Before:**
```javascript
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/dark-v11',
  center: [-95.7, 37.0],
  zoom: 13
});

map.addControl(new mapboxgl.NavigationControl(), 'top-right');
map.addControl(new mapboxgl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true
}), 'top-right');
```

**After:**
```javascript
import mapFactory from './modules/map-factory.js';

mapFactory.initialize(MAPBOX_ACCESS_TOKEN);

const map = await mapFactory.createCoverageMap('map', {
  center: [-95.7, 37.0],
  zoom: 13
});
// Geolocate control is automatically added!
```

---

### Example 3: Add Markers

**Before:**
```javascript
const marker = new mapboxgl.Marker({ color: '#FF0000' })
  .setLngLat([-95.7, 37.0])
  .setPopup(new mapboxgl.Popup().setHTML('<h6>Start</h6>'))
  .addTo(map);
```

**After:**
```javascript
import mapFactory from './modules/map-factory.js';

const marker = mapFactory.addMarker(map, [-95.7, 37.0], {
  color: '#FF0000',
  popup: '<h6>Start</h6>'
});
```

---

## Formatter Migration

### Example 1: Format Distance

**Before:**
```javascript
const distance = window.utils.formatDistance(miles);
```

**After:**
```javascript
import { formatDistance } from './modules/formatters.js';

const distance = formatDistance(miles);
```

---

### Example 2: Format Duration

**Before:**
```javascript
const duration = window.utils.formatDuration(seconds);
```

**After:**
```javascript
import { formatDuration } from './modules/formatters.js';

const duration = formatDuration(seconds);
```

---

### Example 3: Multiple Formatters

**Before:**
```javascript
// In your file
const formatNumber = (n) => window.utils.formatNumber(n);
const formatDistance = (m) => window.utils.formatDistance(m);
const formatDuration = (s) => window.utils.formatDuration(s);

// Usage
const stats = {
  trips: formatNumber(tripCount),
  distance: formatDistance(totalMiles),
  duration: formatDuration(totalSeconds)
};
```

**After:**
```javascript
import { formatNumber, formatDistance, formatDuration } from './modules/formatters.js';

// Usage (no wrapper functions needed!)
const stats = {
  trips: formatNumber(tripCount),
  distance: formatDistance(totalMiles),
  duration: formatDuration(totalSeconds)
};
```

---

## Complete File Migration Example

### Before: insights/index.js

```javascript
/* global bootstrap */

// Wrapper functions for formatters
const formatDuration = (s) => window.utils.formatDuration(s);
const formatNumber = (n) => window.utils.formatNumber(n);

async function loadData() {
  // Manual fetch with error handling
  const response = await fetch('/api/insights');
  if (!response.ok) {
    throw new Error('Failed to load data');
  }
  return response.json();
}

function showError(message) {
  // Manual modal creation
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.innerHTML = `...modal HTML...`;
  document.body.appendChild(modal);
  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}

async function initialize() {
  try {
    const data = await loadData();
    renderCharts(data);
  } catch (error) {
    showError(error.message);
  }
}
```

### After: insights/index.js

```javascript
import apiClient from './modules/api-client.js';
import modalManager from './modules/modal-manager.js';
import { formatDuration, formatNumber } from './modules/formatters.js';

async function loadData() {
  return apiClient.get('/api/insights', { cache: true });
}

async function initialize() {
  try {
    const data = await loadData();
    renderCharts(data);
  } catch (error) {
    await modalManager.showError(error.message);
  }
}
```

**Lines saved:** 25+
**Improvements:**
- ✅ No global dependencies
- ✅ Automatic error handling
- ✅ Built-in caching
- ✅ No manual modal cleanup
- ✅ Cleaner, more maintainable code

---

## Migration Checklist

When migrating a file, follow these steps:

1. **Add imports at the top:**
   ```javascript
   import apiClient from './modules/api-client.js';
   import modalManager from './modules/modal-manager.js';
   import geolocationService from './modules/geolocation-service.js';
   import mapFactory from './modules/map-factory.js';
   import { formatDistance, formatDuration } from './modules/formatters.js';
   ```

2. **Replace `fetch()` calls:**
   - `fetch(url)` → `apiClient.get(url)`
   - `fetch(url, {method: 'POST', ...})` → `apiClient.post(url, body)`

3. **Replace modal creation:**
   - Custom modal HTML → `modalManager.showConfirm/showPrompt/showError`

4. **Replace geolocation:**
   - `navigator.geolocation.*` → `geolocationService.*`

5. **Replace map creation:**
   - `new mapboxgl.Map(...)` → `mapFactory.createMap(...)`

6. **Replace formatters:**
   - `window.utils.format*()` → Import from `modules/formatters.js`

7. **Test thoroughly:**
   - Verify all API calls work
   - Test error handling
   - Check modal functionality
   - Verify formatting output

---

## Common Pitfalls

### 1. Forgetting async/await

❌ **Wrong:**
```javascript
const map = mapFactory.createMap('map'); // Returns Promise!
```

✅ **Correct:**
```javascript
const map = await mapFactory.createMap('map');
```

### 2. Incorrect import paths

❌ **Wrong:**
```javascript
import apiClient from './api-client.js'; // Wrong path!
```

✅ **Correct:**
```javascript
import apiClient from './modules/api-client.js';
```

### 3. Not cleaning up map resources

❌ **Wrong:**
```javascript
// Creating map without cleanup
const map = await mapFactory.createMap('map');
// Later, create another without releasing
const map2 = await mapFactory.createMap('map'); // Potential memory leak!
```

✅ **Correct:**
```javascript
const map = await mapFactory.createMap('map', {}, 'my-map-key');
// When done:
mapFactory.releaseMap('my-map-key');
```

---

## Questions?

See [REFACTORING.md](./REFACTORING.md) for complete documentation.
