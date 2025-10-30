import utils from "./utils.js";
import state from "./state.js";
import dateUtils from "./date-utils.js";
import layerManager from "./layer-manager.js";
import metricsManager from "./metrics-manager.js";
import mapManager from "./map-manager.js";
import { CONFIG } from "./config.js";

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
      dataStage.update(30, `Loading trips from ${start} to ${end}...`);

      const fullCollection = await utils.fetchWithRetry(`/api/trips?${params}`);
      if (fullCollection?.type !== "FeatureCollection") {
        dataStage.error("Invalid trip data received from server.");
        window.notificationManager.show(
          "Failed to load valid trip data",
          "danger",
        );
        return null;
      }

      dataStage.update(
        75,
        `Processing ${fullCollection.features.length} trips...`,
      );

      // Mark recent trips for styling later
      try {
        const now = Date.now();
        const threshold = CONFIG.MAP.recentTripThreshold;
        fullCollection.features.forEach((f) => {
          const end = f?.properties?.endTime;
          const endTs = end ? new Date(end).getTime() : null;
          f.properties = f.properties || {};
          f.properties.isRecent =
            typeof endTs === "number" && !isNaN(endTs)
              ? now - endTs <= threshold
              : false;
        });
      } catch (err) {
        console.warn("Failed to tag recent trips:", err);
      }

      try {
        this.applyTripHeatmap(fullCollection);
      } catch (err) {
        console.warn("Failed to apply trip heatmap:", err);
      }

      metricsManager.updateTripsTable(fullCollection);
      await layerManager.updateMapLayer("trips", fullCollection);

      dataStage.complete();
      return fullCollection;
    } catch (error) {
      dataStage.error(error.message);
      window.notificationManager.show("Failed to load trips", "danger");
      return null;
    }
  },

  async fetchMatchedTrips() {
    if (!state.mapInitialized || !state.mapLayers.matchedTrips.visible)
      return null;
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
              typeof endTs === "number" && !isNaN(endTs)
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
      if (state.mapLayers.trips.visible) promises.push(this.fetchTrips());
      if (state.mapLayers.matchedTrips.visible)
        promises.push(this.fetchMatchedTrips());
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
