/**
 * DataManager - API Data Fetching Module
 *
 * This module handles:
 * - Fetching trip, street, and metrics data from APIs
 * - Caching and abort handling
 * - Loading indicator management
 * - Triggering layer updates after data loads
 *
 * Data flow:
 * 1. Fetch data from API
 * 2. Store in state.mapLayers[layerName].layer
 * 3. Call layerManager.updateMapLayer() to render
 * 4. Emit events for other modules to respond
 */

import { CONFIG } from "./core/config.js";
import state from "./core/store.js";
import layerManager from "./layer-manager.js";
import metricsManager from "./metrics-manager.js";
import loadingManager from "./ui/loading-manager.js";
import notificationManager from "./ui/notifications.js";
import { DateUtils, utils } from "./utils.js";

const dateUtils = DateUtils;

// ============================================================
// Loading Indicator
// ============================================================

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
      if (!ensureElements()) {
        return;
      }
      indicatorEl.classList.remove("d-none");
      indicatorEl.setAttribute("aria-busy", "true");
      indicatorEl.setAttribute("aria-live", "polite");
      this.update(message);
    },

    update(message) {
      if (!ensureElements()) {
        return;
      }
      if (textEl) {
        textEl.textContent = message;
      }
    },

    hide() {
      if (!ensureElements()) {
        return;
      }
      indicatorEl.classList.add("d-none");
      indicatorEl.removeAttribute("aria-busy");
    },
  };
})();

// ============================================================
// Data Manager
// ============================================================

const dataManager = {
  /**
   * Fetch trips data and update the trips layer
   * @returns {Promise<Object|null>} GeoJSON FeatureCollection or null
   */
  async fetchTrips() {
    if (!state.mapInitialized) {
      return null;
    }

    loadingManager?.show("Loading trips...", { blocking: false, compact: true });
    mapLoadingIndicator.show("Loading trips...");

    try {
      const { start, end } = dateUtils.getCachedDateRange();
      const params = new URLSearchParams({ start_date: start, end_date: end });
      loadingManager?.updateMessage(`Loading trips from ${start} to ${end}...`);

      const tripData = await utils.fetchWithRetry(
        `${CONFIG.API.trips}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchTrips"
      );

      if (!tripData || tripData?.type !== "FeatureCollection") {
        loadingManager?.hide();
        notificationManager.show("Failed to load valid trip data", "danger");
        return null;
      }

      loadingManager?.updateMessage(`Rendering ${tripData.features.length} trips...`);
      mapLoadingIndicator.update(`Rendering ${tripData.features.length} trips...`);

      // Update map layer
      await layerManager.updateMapLayer("trips", tripData);

      loadingManager?.updateMessage("Finalizing...");

      // Emit event for trip styles refresh (handled by app-controller)
      document.dispatchEvent(
        new CustomEvent("tripsDataLoaded", {
          detail: { featureCount: tripData.features.length },
        })
      );

      // Update metrics table
      metricsManager.updateTripsTable(tripData);

      return tripData;
    } catch (error) {
      if (error?.name === "AbortError") {
        return null;
      }
      loadingManager?.hide();
      notificationManager.show("Failed to load trips", "danger");
      return null;
    } finally {
      loadingManager?.hide();
      mapLoadingIndicator.hide();
    }
  },

  /**
   * Fetch matched trips data and update the layer
   * @returns {Promise<Object|null>} GeoJSON FeatureCollection or null
   */
  async fetchMatchedTrips() {
    if (!state.mapInitialized) {
      return null;
    }

    loadingManager.pulse("Loading matched trips...");

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
        this._tagRecentTrips(data);

        state.mapLayers.matchedTrips.layer = data;
        await layerManager.updateMapLayer("matchedTrips", data);
        return data;
      }

      return null;
    } catch (error) {
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching matched trips:", error);
      return null;
    }
  },

  /**
   * Tag trips as recent based on threshold
   * @private
   */
  _tagRecentTrips(data) {
    try {
      const now = Date.now();
      const threshold = CONFIG.MAP.recentTripThreshold;

      data.features.forEach((f) => {
        const endTime = f?.properties?.endTime;
        const endTs = endTime ? new Date(endTime).getTime() : null;
        f.properties = f.properties || {};
        f.properties.isRecent
          = typeof endTs === "number" && !Number.isNaN(endTs)
            ? now - endTs <= threshold
            : false;
      });
    } catch (err) {
      console.warn("Failed to tag recent matched trips:", err);
    }
  },

  /**
   * Fetch undriven streets for selected coverage area
   * @returns {Promise<Object|null>}
   */
  async fetchUndrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);

    if (!selectedLocationId || !state.mapInitialized || state.undrivenStreetsLoaded) {
      return null;
    }

    loadingManager.pulse("Loading undriven streets...");

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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching undriven streets:", error);
      state.undrivenStreetsLoaded = false;
      return null;
    }
  },

  /**
   * Fetch driven streets for selected coverage area
   * @returns {Promise<Object|null>}
   */
  async fetchDrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);

    if (!selectedLocationId || !state.mapInitialized || state.drivenStreetsLoaded) {
      return null;
    }

    loadingManager.pulse("Loading driven streets...");

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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching driven streets:", error);
      state.drivenStreetsLoaded = false;
      return null;
    }
  },

  /**
   * Fetch all streets for selected coverage area
   * @returns {Promise<Object|null>}
   */
  async fetchAllStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);

    if (!selectedLocationId || !state.mapInitialized || state.allStreetsLoaded) {
      return null;
    }

    loadingManager.pulse("Loading all streets...");

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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching all streets:", error);
      state.allStreetsLoaded = false;
      return null;
    }
  },

  /**
   * Fetch metrics/analytics data
   * @returns {Promise<Object|null>}
   */
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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching metrics:", error);
      return null;
    }
  },

  /**
   * Update all map data (refresh visible layers)
   * @param {boolean} fitBounds - Whether to fit bounds after loading
   */
  async updateMap(fitBounds = false) {
    if (!state.mapInitialized) {
      return;
    }

    loadingManager?.show("Updating map...");

    try {
      loadingManager?.updateMessage("Fetching map data...");
      state.cancelAllRequests();

      const promises = [];

      // Fetch data for visible layers
      if (state.mapLayers.trips.visible) {
        promises.push(this.fetchTrips());
      }
      if (state.mapLayers.matchedTrips.visible) {
        promises.push(this.fetchMatchedTrips());
      }
      if (state.mapLayers.undrivenStreets.visible && !state.undrivenStreetsLoaded) {
        promises.push(this.fetchUndrivenStreets());
      }
      if (state.mapLayers.drivenStreets.visible && !state.drivenStreetsLoaded) {
        promises.push(this.fetchDrivenStreets());
      }
      if (state.mapLayers.allStreets.visible && !state.allStreetsLoaded) {
        promises.push(this.fetchAllStreets());
      }

      loadingManager?.updateMessage("Loading layer data...");
      await Promise.allSettled(promises);

      loadingManager?.updateMessage("Rendering layers...");

      // Ensure visibility is applied after data loads
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

      // Emit event for fit bounds (handled by app-controller)
      if (fitBounds) {
        document.dispatchEvent(
          new CustomEvent("mapDataLoaded", {
            detail: { fitBounds: true },
          })
        );
      }

      state.metrics.renderTime = Date.now() - state.metrics.loadStartTime;
    } catch (error) {
      console.error("Error updating map:", error);
      notificationManager.show("Error updating map data", "danger");
    } finally {
      loadingManager?.hide();
    }
  },

  /**
   * Handle layer data needed event (from layer-manager)
   * @param {string} layerName - Name of layer needing data
   */
  async handleLayerDataNeeded(layerName) {
    switch (layerName) {
      case "matchedTrips":
        await this.fetchMatchedTrips();
        break;
      case "undrivenStreets":
        await this.fetchUndrivenStreets();
        break;
      case "drivenStreets":
        await this.fetchDrivenStreets();
        break;
      case "allStreets":
        await this.fetchAllStreets();
        break;
      default:
        console.warn(`Unknown layer data requested: ${layerName}`);
    }
  },
};

// Listen for layer data needed events
document.addEventListener("layerDataNeeded", (e) => {
  const { layerName } = e.detail || {};
  if (layerName) {
    dataManager.handleLayerDataNeeded(layerName);
  }
});

export default dataManager;
