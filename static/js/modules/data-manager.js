import { CONFIG } from "./config.js";
import dateUtils from "./date-utils.js";
import layerManager from "./layer-manager.js";
import mapManager from "./map-manager.js";
import metricsManager from "./metrics-manager.js";
import state from "./state.js";
import utils from "./utils.js";

const RECENCY_WINDOW_MS =
  CONFIG.MAP?.recencyWindowMs ?? 30 * 24 * 60 * 60 * 1000;

const deviceProfile =
  typeof utils.getDeviceProfile === "function"
    ? utils.getDeviceProfile()
    : {
        isMobile: false,
        lowMemory: false,
        saveData: false,
        isConstrained: false,
      };

const BASE_CHUNK_SIZE = CONFIG.PERFORMANCE?.tripChunkSize || 400;
const PROGRESSIVE_CHUNK_SIZE = deviceProfile.isConstrained
  ? Math.max(150, Math.floor(BASE_CHUNK_SIZE * 0.6))
  : BASE_CHUNK_SIZE;
const PROGRESSIVE_DELAY = deviceProfile.isConstrained
  ? Math.max(20, (CONFIG.PERFORMANCE?.progressiveLoadingDelay || 12) * 1.5)
  : CONFIG.PERFORMANCE?.progressiveLoadingDelay || 12;

const mapLoadingIndicator = (() => {
  let indicatorEl = null;
  let textEl = null;

  const ensureElements = () => {
    if (!indicatorEl) {
      indicatorEl = document.getElementById("map-loading-indicator");
      textEl = indicatorEl?.querySelector(".map-loading-text") || indicatorEl;
    }
    return indicatorEl;
  };

  return {
    show(message = "Loading map data...") {
      if (!ensureElements()) return;
      indicatorEl.classList.remove("d-none");
      indicatorEl.setAttribute("aria-busy", "true");
      indicatorEl.setAttribute("aria-live", "polite");
      this.update(message);
    },
    update(message) {
      if (!ensureElements()) return;
      if (textEl) textEl.textContent = message;
    },
    hide() {
      if (!ensureElements()) return;
      indicatorEl.classList.add("d-none");
      indicatorEl.removeAttribute("aria-busy");
    },
  };
})();

const computeRecencyScore = (endTimestamp, now = Date.now()) => {
  if (!Number.isFinite(endTimestamp)) return 0;
  const ageMs = Math.max(0, now - endTimestamp);
  if (ageMs === 0) return 1;
  const normalized = 1 - Math.min(1, ageMs / RECENCY_WINDOW_MS);
  return Number.isFinite(normalized) ? Number(normalized.toFixed(3)) : 0;
};

const dataManager = {
  async fetchTrips() {
    if (!state.mapInitialized) return null;

    const dataStage = window.loadingManager.startStage(
      "data",
      "Loading trips...",
      {
        blocking: false,
        compact: true,
      },
    );
    mapLoadingIndicator.show("Loading trips...");

    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });
      dataStage.update(20, `Loading trips from ${start} to ${end}...`);
      mapLoadingIndicator.update(`Loading trips from ${start} to ${end}...`);

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
      const chunkSize = PROGRESSIVE_CHUNK_SIZE;
      const delay = PROGRESSIVE_DELAY;
      const incrementalCollection = {
        type: "FeatureCollection",
        features: [],
      };
      const appendChunk = (startIdx, endIdx) => {
        for (let i = startIdx; i < endIdx; i += 1) {
          const feature = features[i];
          if (feature) incrementalCollection.features.push(feature);
        }
      };

      dataStage.update(40, `Processing ${totalCount} trips...`);
      mapLoadingIndicator.update(
        `Processing ${totalCount.toLocaleString()} trips for display...`,
      );

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
          f.properties.recencyScore = computeRecencyScore(endTs, now);
        }
      } catch (err) {
        console.warn("Failed to tag recent trips:", err);
      }

      // Progressive rendering: show trips immediately in chunks
      if (totalCount > chunkSize) {
        dataStage.update(50, `Rendering ${totalCount} trips progressively...`);
        mapLoadingIndicator.update(
          `Rendering ${totalCount.toLocaleString()} trips... (0%)`,
        );

        // Render first chunk immediately for fast visual feedback
        appendChunk(0, chunkSize);
        await layerManager.updateMapLayer("trips", incrementalCollection);

        // Schedule remaining chunks to yield to browser
        let loadedCount = chunkSize;
        const renderChunk = async (startIdx) => {
          const endIdx = Math.min(startIdx + chunkSize, totalCount);
          appendChunk(startIdx, endIdx);
          await layerManager.updateMapLayer("trips", incrementalCollection);
          loadedCount = endIdx;

          const progress = 50 + Math.round((loadedCount / totalCount) * 30);
          dataStage.update(
            progress,
            `Rendered ${loadedCount} of ${totalCount} trips...`,
          );
          const percent = Math.min(
            99,
            Math.round((loadedCount / totalCount) * 100),
          );
          mapLoadingIndicator.update(
            `Rendering ${loadedCount.toLocaleString()} of ${totalCount.toLocaleString()} trips... (${percent}%)`,
          );
        };

        // Progressive chunk loading with browser yielding
        for (let i = chunkSize; i < totalCount; i += chunkSize) {
          await utils.yieldToBrowser(delay);
          await renderChunk(i);
        }
      } else {
        // Small dataset - render directly
        await layerManager.updateMapLayer("trips", fullCollection);
      }

      dataStage.update(85, "Applying trip styling...");
      mapLoadingIndicator.update("Applying trip styling...");
      mapManager.refreshTripStyles();

      metricsManager.updateTripsTable(fullCollection);
      dataStage.complete();
      mapLoadingIndicator.update("Trips loaded");
      setTimeout(() => mapLoadingIndicator.hide(), 300);
      return fullCollection;
    } catch (error) {
      dataStage.error(error.message);
      window.notificationManager.show("Failed to load trips", "danger");
      return null;
    } finally {
      setTimeout(() => mapLoadingIndicator.hide(), 300);
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
