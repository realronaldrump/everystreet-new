/**
 * Data Manager Module
 * Handles all API data fetching with proper caching and abort handling
 */
import { CONFIG } from "./config.js";
import dateUtils from "./date-utils.js";
import layerManager from "./layer-manager.js";
import mapManager from "./map-manager.js";
import metricsManager from "./metrics-manager.js";
import state from "./state.js";
import utils from "./utils.js";

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

const dataManager = {
  async fetchTrips() {
    if (!state.mapInitialized) return null;

    const dataStage = window.loadingManager.startStage("data", "Loading trips...", {
      blocking: false,
      compact: true,
    });
    mapLoadingIndicator.show("Loading trips...");

    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });
      dataStage.update(30, `Loading trips from ${start} to ${end}...`);

      const tripData = await utils.fetchWithRetry(
        `${CONFIG.API.trips}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchTrips"
      );

      if (!tripData || tripData?.type !== "FeatureCollection") {
        dataStage.error("Invalid trip data received from server.");
        window.notificationManager?.show("Failed to load valid trip data", "danger");
        return null;
      }

      dataStage.update(70, `Rendering ${tripData.features.length} trips...`);
      mapLoadingIndicator.update(`Rendering ${tripData.features.length} trips...`);

      await layerManager.updateMapLayer("trips", tripData);

      dataStage.update(90, "Finalizing...");
      mapManager.refreshTripStyles();
      metricsManager.updateTripsTable(tripData);

      dataStage.complete();
      mapLoadingIndicator.hide();
      return tripData;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      dataStage.error(error.message);
      window.notificationManager?.show("Failed to load trips", "danger");
      return null;
    } finally {
      mapLoadingIndicator.hide();
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

      const data = await utils.fetchWithRetry(
        `${CONFIG.API.matchedTrips}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchMatchedTrips"
      );

      if (data?.type === "FeatureCollection") {
        // Tag recent matched trips
        try {
          const now = Date.now();
          const threshold = CONFIG.MAP.recentTripThreshold;
          data.features.forEach((f) => {
            const endTime = f?.properties?.endTime;
            const endTs = endTime ? new Date(endTime).getTime() : null;
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
      if (error?.name === "AbortError") return null;
      console.error("Error fetching matched trips:", error);
      return null;
    }
  },

  async fetchUndrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.undrivenStreetsLoaded)
      return null;

    window.loadingManager.pulse("Loading undriven streets...");
    try {
      const data = await utils.fetchWithRetry(
        CONFIG.API.coverageAreaStreets(selectedLocationId, "undriven=true"),
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchUndrivenStreets"
      );

      if (data?.type === "FeatureCollection") {
        state.mapLayers.undrivenStreets.layer = data;
        state.undrivenStreetsLoaded = true;
        await layerManager.updateMapLayer("undrivenStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error("Error fetching undriven streets:", error);
      state.undrivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchDrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.drivenStreetsLoaded)
      return null;

    window.loadingManager.pulse("Loading driven streets...");
    try {
      const data = await utils.fetchWithRetry(
        CONFIG.API.coverageAreaStreets(selectedLocationId, "driven=true"),
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchDrivenStreets"
      );

      if (data?.type === "FeatureCollection") {
        state.mapLayers.drivenStreets.layer = data;
        state.drivenStreetsLoaded = true;
        await layerManager.updateMapLayer("drivenStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error("Error fetching driven streets:", error);
      state.drivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchAllStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.allStreetsLoaded)
      return null;

    window.loadingManager.pulse("Loading all streets...");
    try {
      const data = await utils.fetchWithRetry(
        CONFIG.API.coverageAreaStreets(selectedLocationId),
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchAllStreets"
      );

      if (data?.type === "FeatureCollection") {
        state.mapLayers.allStreets.layer = data;
        state.allStreetsLoaded = true;
        await layerManager.updateMapLayer("allStreets", data);
        return data;
      }
      return null;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error("Error fetching all streets:", error);
      state.allStreetsLoaded = false;
      return null;
    }
  },

  async fetchMetrics() {
    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });

      const data = await utils.fetchWithRetry(
        `${CONFIG.API.tripAnalytics}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchMetrics"
      );

      if (data) {
        document.dispatchEvent(new CustomEvent("metricsUpdated", { detail: data }));
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") return null;
      console.error("Error fetching metrics:", error);
      return null;
    }
  },

  async updateMap(fitBounds = false) {
    if (!state.mapInitialized) return;

    const renderStage = window.loadingManager.startStage("render", "Updating map...");

    try {
      renderStage.update(20, "Fetching map data...");
      state.cancelAllRequests();

      const promises = [];

      if (state.mapLayers.trips.visible) promises.push(this.fetchTrips());
      if (state.mapLayers.matchedTrips.visible) promises.push(this.fetchMatchedTrips());
      if (state.mapLayers.undrivenStreets.visible && !state.undrivenStreetsLoaded)
        promises.push(this.fetchUndrivenStreets());
      if (state.mapLayers.drivenStreets.visible && !state.drivenStreetsLoaded)
        promises.push(this.fetchDrivenStreets());
      if (state.mapLayers.allStreets.visible && !state.allStreetsLoaded)
        promises.push(this.fetchAllStreets());

      renderStage.update(50, "Loading layer data...");
      await Promise.allSettled(promises);

      renderStage.update(80, "Rendering layers...");

      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          Object.entries(state.mapLayers).forEach(([name, info]) => {
            if (info.layer) {
              const layerId = `${name}-layer`;
              if (state.map?.getLayer(layerId)) {
                state.map.setLayoutProperty(
                  layerId,
                  "visibility",
                  info.visible ? "visible" : "none"
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
      window.notificationManager?.show("Error updating map data", "danger");
    } finally {
      window.loadingManager.finish();
    }
  },
};

export default dataManager;
