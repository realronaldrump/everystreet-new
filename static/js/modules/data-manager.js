import { CONFIG } from "./config.js";
import dateUtils from "./date-utils.js";
import layerManager from "./layer-manager.js";
import mapManager from "./map-manager.js";
import metricsManager from "./metrics-manager.js";
import state from "./state.js";
import utils from "./utils.js";

const DEFAULT_HEATMAP_STOPS = CONFIG.LAYER_DEFAULTS?.trips?.heatmapStops || [
  [0, "#331107"],
  [0.08, "#651500"],
  [0.2, "#A23403"],
  [0.45, "#E04B12"],
  [0.7, "#F67E26"],
  [1, "#FFEFA0"],
];

const DEFAULT_HEATMAP_PRECISION =
  CONFIG.LAYER_DEFAULTS?.trips?.heatmapPrecision ?? 5;

// Web Worker for heatmap calculation (lazy initialized)
let heatmapWorker = null;
let workerMessageId = 0;
const pendingWorkerCallbacks = new Map();

/**
 * Initialize the heatmap Web Worker
 */
function initHeatmapWorker() {
  if (heatmapWorker) return heatmapWorker;
  if (!CONFIG.PERFORMANCE?.heatmapWorkerEnabled) return null;

  try {
    heatmapWorker = new Worker("/static/js/workers/heatmap-worker.js");
    heatmapWorker.onmessage = (e) => {
      const { type, id, features, stats, error } = e.data;
      const callback = pendingWorkerCallbacks.get(id);
      if (callback) {
        pendingWorkerCallbacks.delete(id);
        if (type === "error") {
          callback.reject(new Error(error));
        } else {
          callback.resolve({ features, stats });
        }
      }
    };
    heatmapWorker.onerror = (err) => {
      console.warn("Heatmap worker error:", err);
    };
    return heatmapWorker;
  } catch (err) {
    console.warn("Failed to initialize heatmap worker:", err);
    return null;
  }
}

/**
 * Calculate heatmap asynchronously using Web Worker
 */
function calculateHeatmapAsync(
  features,
  precision = DEFAULT_HEATMAP_PRECISION,
) {
  return new Promise((resolve, reject) => {
    const worker = initHeatmapWorker();
    if (!worker) {
      // Fallback to sync calculation if worker unavailable
      resolve(null);
      return;
    }

    const id = ++workerMessageId;
    pendingWorkerCallbacks.set(id, { resolve, reject });

    // Send features to worker (transferable would be better but complex with objects)
    worker.postMessage({
      type: "calculate",
      id,
      features,
      precision,
    });
  });
}

// Keep original helper functions for fallback sync calculation
const makeSegmentKey = (a, b, precision = DEFAULT_HEATMAP_PRECISION) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (a.length < 2 || b.length < 2) return null;
  const factor = 10 ** precision;
  const ax = Math.round(Number(a[0]) * factor) / factor;
  const ay = Math.round(Number(a[1]) * factor) / factor;
  const bx = Math.round(Number(b[0]) * factor) / factor;
  const by = Math.round(Number(b[1]) * factor) / factor;
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
  if (!Number.isFinite(bx) || !Number.isFinite(by)) return null;
  const keyA = `${ax.toFixed(precision)}:${ay.toFixed(precision)}`;
  const keyB = `${bx.toFixed(precision)}:${by.toFixed(precision)}`;
  return keyA <= keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
};

const getGeometryCoordinateSets = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === "LineString") {
    return [Array.isArray(geometry.coordinates) ? geometry.coordinates : []];
  }
  if (geometry.type === "MultiLineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }
  return [];
};

const normalizeHeatValue = (value, maxValue) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 0;
  if (maxValue === 1) return Math.min(1, value);
  const numerator = Math.log(value + 1);
  const denominator = Math.log(maxValue + 1);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return Math.min(1, value / maxValue);
  }
  return Math.min(1, numerator / denominator);
};

const buildHeatmapExpression = (stops) => {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  const sanitizedStops = stops
    .filter(
      (stop) =>
        Array.isArray(stop) &&
        stop.length >= 2 &&
        Number.isFinite(stop[0]) &&
        typeof stop[1] === "string",
    )
    .map(([value, color]) => [Math.max(0, Math.min(1, value)), color])
    .sort((a, b) => a[0] - b[0]);

  if (sanitizedStops.length < 2) return null;

  const flattenedStops = sanitizedStops.flat();

  return [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "heatIntensity"], 0],
    ...flattenedStops,
  ];
};

const ensureFeatureProperties = (feature) => {
  if (!feature) return {};
  if (!feature.properties || typeof feature.properties !== "object") {
    feature.properties = {};
  }
  return feature.properties;
};

const dataManager = {
  applyTripHeatmap(collection) {
    const features = Array.isArray(collection?.features)
      ? collection.features
      : Array.isArray(collection)
        ? collection
        : [];

    if (!features.length) return null;

    const precision =
      state.mapLayers?.trips?.heatmapPrecision ?? DEFAULT_HEATMAP_PRECISION;

    const segmentCounts = new Map();

    features.forEach((feature) => {
      const coordinateSets = getGeometryCoordinateSets(feature.geometry);
      coordinateSets.forEach((coords) => {
        if (!Array.isArray(coords) || coords.length < 2) return;
        for (let i = 0; i < coords.length - 1; i += 1) {
          const key = makeSegmentKey(coords[i], coords[i + 1], precision);
          if (!key) continue;
          segmentCounts.set(key, (segmentCounts.get(key) || 0) + 1);
        }
      });
    });

    if (segmentCounts.size === 0) {
      features.forEach((feature) => {
        const props = ensureFeatureProperties(feature);
        props.heatIntensity = 0;
        props.heatWeight = 0;
      });
      return null;
    }

    let maxCount = 0;
    let minCount = Number.POSITIVE_INFINITY;

    segmentCounts.forEach((count) => {
      if (!Number.isFinite(count)) return;
      if (count > maxCount) maxCount = count;
      if (count < minCount) minCount = count;
    });

    if (!Number.isFinite(maxCount) || maxCount <= 0) {
      features.forEach((feature) => {
        const props = ensureFeatureProperties(feature);
        props.heatIntensity = 0;
        props.heatWeight = 0;
      });
      return null;
    }

    features.forEach((feature) => {
      const coordinateSets = getGeometryCoordinateSets(feature.geometry);
      let featureMax = 0;
      let featureSum = 0;
      let segmentCounter = 0;

      coordinateSets.forEach((coords) => {
        if (!Array.isArray(coords) || coords.length < 2) return;
        for (let i = 0; i < coords.length - 1; i += 1) {
          const key = makeSegmentKey(coords[i], coords[i + 1], precision);
          if (!key) continue;
          const value = segmentCounts.get(key) || 0;
          featureMax = Math.max(featureMax, value);
          featureSum += value;
          segmentCounter += 1;
        }
      });

      const average = segmentCounter > 0 ? featureSum / segmentCounter : 0;
      const intensitySource = featureMax || average;
      const normalized = normalizeHeatValue(intensitySource, maxCount);
      const props = ensureFeatureProperties(feature);
      props.heatIntensity = Number.isFinite(normalized)
        ? Number(normalized.toFixed(4))
        : 0;
      props.heatWeight = intensitySource;
    });

    const stops =
      state.mapLayers?.trips?.heatmapStops &&
      state.mapLayers.trips.heatmapStops.length > 0
        ? state.mapLayers.trips.heatmapStops
        : DEFAULT_HEATMAP_STOPS;
    const colorExpression = buildHeatmapExpression(stops);

    if (colorExpression && state.mapLayers?.trips) {
      state.mapLayers.trips.color = colorExpression;
      state.mapLayers.trips.colorStops = stops;
    }

    const stats = {
      maxCount,
      minCount: Number.isFinite(minCount) ? minCount : 0,
      totalSegments: segmentCounts.size,
      precision,
    };

    if (state.mapLayers?.trips) {
      state.mapLayers.trips.heatmapStats = stats;
    }

    return stats;
  },
  async fetchTrips() {
    if (!state.mapInitialized) return null;

    const dataStage = window.loadingManager.startStage(
      "data",
      "Loading trips...",
    );

    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });
      dataStage.update(20, `Loading trips from ${start} to ${end}...`);

      const fullCollection = await utils.fetchWithRetry(`/api/trips?${params}`);
      if (fullCollection?.type !== "FeatureCollection") {
        dataStage.error("Invalid trip data received from server.");
        window.notificationManager.show(
          "Failed to load valid trip data",
          "danger",
        );
        return null;
      }

      const { features } = fullCollection;
      const totalCount = features.length;
      const chunkSize = CONFIG.PERFORMANCE?.tripChunkSize || 500;
      const delay = CONFIG.PERFORMANCE?.progressiveLoadingDelay || 16;

      dataStage.update(40, `Processing ${totalCount} trips...`);

      // Mark recent trips for styling (fast operation, do synchronously)
      try {
        const now = Date.now();
        const threshold = CONFIG.MAP.recentTripThreshold;
        for (const f of features) {
          const endTime = f?.properties?.endTime;
          const endTs = endTime ? new Date(endTime).getTime() : null;
          f.properties = f.properties || {};
          f.properties.isRecent =
            typeof endTs === "number" && !Number.isNaN(endTs)
              ? now - endTs <= threshold
              : false;
        }
      } catch (err) {
        console.warn("Failed to tag recent trips:", err);
      }

      // Progressive rendering: show trips immediately in chunks
      if (totalCount > chunkSize) {
        dataStage.update(50, `Rendering ${totalCount} trips progressively...`);

        // Render first chunk immediately for fast visual feedback
        const firstChunk = {
          type: "FeatureCollection",
          features: features.slice(0, chunkSize),
        };
        await layerManager.updateMapLayer("trips", firstChunk);

        // Schedule remaining chunks to yield to browser
        let loadedCount = chunkSize;
        const renderChunk = async (startIdx) => {
          const endIdx = Math.min(startIdx + chunkSize, totalCount);
          const partialCollection = {
            type: "FeatureCollection",
            features: features.slice(0, endIdx), // Cumulative to update source
          };
          await layerManager.updateMapLayer("trips", partialCollection);
          loadedCount = endIdx;

          const progress = 50 + Math.round((loadedCount / totalCount) * 30);
          dataStage.update(
            progress,
            `Rendered ${loadedCount} of ${totalCount} trips...`,
          );
        };

        // Progressive chunk loading with browser yielding
        for (let i = chunkSize; i < totalCount; i += chunkSize) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          await renderChunk(i);
        }
      } else {
        // Small dataset - render directly
        await layerManager.updateMapLayer("trips", fullCollection);
      }

      dataStage.update(85, "Computing heatmap...");

      // Apply heatmap asynchronously (via Web Worker if available)
      try {
        const workerResult = await calculateHeatmapAsync(features);
        if (workerResult?.features) {
          // Worker returned enriched features - update collection
          fullCollection.features = workerResult.features;

          // Apply heatmap color expression
          const stops =
            state.mapLayers?.trips?.heatmapStops || DEFAULT_HEATMAP_STOPS;
          const colorExpression = buildHeatmapExpression(stops);
          if (colorExpression && state.mapLayers?.trips) {
            state.mapLayers.trips.color = colorExpression;
            state.mapLayers.trips.colorStops = stops;
            state.mapLayers.trips.heatmapStats = workerResult.stats;
          }

          // Final update with heatmap colors
          await layerManager.updateMapLayer("trips", fullCollection);
        } else {
          // Fallback to synchronous heatmap
          this.applyTripHeatmap(fullCollection);
          await layerManager.updateMapLayer("trips", fullCollection);
        }
      } catch (err) {
        console.warn("Async heatmap failed, using sync fallback:", err);
        this.applyTripHeatmap(fullCollection);
        await layerManager.updateMapLayer("trips", fullCollection);
      }

      metricsManager.updateTripsTable(fullCollection);
      dataStage.complete();
      return fullCollection;
    } catch (error) {
      dataStage.error(error.message);
      window.notificationManager.show("Failed to load trips", "danger");
      return null;
    }
  },

  async fetchMatchedTrips() {
    if (!state.mapInitialized) return null;
    window.loadingManager.pulse("Loading matched trips...");

    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({
        start_date: start,
        end_date: end,
        format: "geojson",
      });
      const data = await utils.fetchWithRetry(`/api/matched_trips?${params}`);
      if (data?.type === "FeatureCollection") {
        // Tag recent matched trips as well
        try {
          const now = Date.now();
          const threshold = CONFIG.MAP.recentTripThreshold;
          data.features.forEach((f) => {
            const end = f?.properties?.endTime;
            const endTs = end ? new Date(end).getTime() : null;
            f.properties = f.properties || {};
            f.properties.isRecent =
              typeof endTs === "number" && !Number.isNaN(endTs)
                ? now - endTs <= threshold
                : false;
          });
        } catch (err) {
          console.warn("Failed to tag recent matched trips:", err);
        }

        state.mapLayers.matchedTrips.layer = data;
        await layerManager.updateMapLayer("matchedTrips", data);
        return data;
      }
      return null;
    } catch (error) {
      console.error("Error fetching matched trips:", error);
      return null;
    }
  },

  async fetchUndrivenStreets() {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (
      !selectedLocationId ||
      !state.mapInitialized ||
      state.undrivenStreetsLoaded
    )
      return null;

    window.loadingManager.pulse("Loading undriven streets...");
    try {
      const data = await utils.fetchWithRetry(
        `/api/coverage_areas/${selectedLocationId}/streets?undriven=true`,
      );
      if (data?.type === "FeatureCollection") {
        state.mapLayers.undrivenStreets.layer = data;
        state.undrivenStreetsLoaded = true;
        await layerManager.updateMapLayer("undrivenStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      state.undrivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchDrivenStreets() {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (
      !selectedLocationId ||
      !state.mapInitialized ||
      state.drivenStreetsLoaded
    )
      return null;

    window.loadingManager.pulse("Loading driven streets...");
    try {
      const data = await utils.fetchWithRetry(
        `/api/coverage_areas/${selectedLocationId}/streets?driven=true`,
      );
      if (data?.type === "FeatureCollection") {
        state.mapLayers.drivenStreets.layer = data;
        state.drivenStreetsLoaded = true;
        await layerManager.updateMapLayer("drivenStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      console.error("Error fetching driven streets:", error);
      state.drivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchAllStreets() {
    const selectedLocationId = utils.getStorage(
      CONFIG.STORAGE_KEYS.selectedLocation,
    );
    if (!selectedLocationId || !state.mapInitialized || state.allStreetsLoaded)
      return null;

    window.loadingManager.pulse("Loading all streets...");
    try {
      const data = await utils.fetchWithRetry(
        `/api/coverage_areas/${selectedLocationId}/streets`,
      );
      if (data?.type === "FeatureCollection") {
        state.mapLayers.allStreets.layer = data;
        state.allStreetsLoaded = true;
        await layerManager.updateMapLayer("allStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      console.error("Error fetching all streets:", error);
      state.allStreetsLoaded = false;
      return null;
    }
  },

  async fetchMetrics() {
    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });
      const data = await utils.fetchWithRetry(`/api/trip-analytics?${params}`);
      if (data)
        document.dispatchEvent(
          new CustomEvent("metricsUpdated", { detail: data }),
        );
      return data;
    } catch (error) {
      console.error("Error fetching metrics:", error);
      return null;
    }
  },

  async updateMap(fitBounds = false) {
    if (!state.mapInitialized) return;

    const renderStage = window.loadingManager.startStage(
      "render",
      "Updating map...",
    );

    try {
      renderStage.update(20, "Fetching map data...");
      state.cancelAllRequests();

      const promises = [];
      // Always fetch visible trip layers (they may need refresh after date range changes)
      if (state.mapLayers.trips.visible) promises.push(this.fetchTrips());
      if (state.mapLayers.matchedTrips.visible)
        promises.push(this.fetchMatchedTrips());
      // Street layers only fetch if not already loaded (they're location-specific)
      if (
        state.mapLayers.undrivenStreets.visible &&
        !state.undrivenStreetsLoaded
      )
        promises.push(this.fetchUndrivenStreets());
      if (state.mapLayers.drivenStreets.visible && !state.drivenStreetsLoaded)
        promises.push(this.fetchDrivenStreets());
      if (state.mapLayers.allStreets.visible && !state.allStreetsLoaded)
        promises.push(this.fetchAllStreets());

      renderStage.update(50, "Loading layer data...");
      await Promise.allSettled(promises);

      renderStage.update(80, "Rendering layers...");

      // Ensure visibility is correctly applied for all layers after refresh
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          Object.entries(state.mapLayers).forEach(([name, info]) => {
            if (info.layer) {
              const layerId = `${name}-layer`;
              if (state.map?.getLayer(layerId)) {
                state.map.setLayoutProperty(
                  layerId,
                  "visibility",
                  info.visible ? "visible" : "none",
                );
              }
            }
          });
          resolve();
        });
      });

      if (fitBounds) await mapManager.fitBounds();

      renderStage.complete();
      state.metrics.renderTime = Date.now() - state.metrics.loadStartTime;
    } catch (error) {
      renderStage.error(error.message);
      window.notificationManager.show("Error updating map data", "danger");
    } finally {
      window.loadingManager.finish();
    }
  },
};

if (!window.EveryStreet) window.EveryStreet = {};
window.EveryStreet.DataManager = dataManager;

export default dataManager;
