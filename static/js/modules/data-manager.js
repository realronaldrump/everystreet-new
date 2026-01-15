/**
 * Data Manager Module
 * Handles all API data fetching with proper caching and abort handling
 */
import { CONFIG } from "./config.js";
import layerManager from "./layer-manager.js";
import mapManager from "./map-manager.js";
import metricsManager from "./metrics-manager.js";
import state from "./state.js";
import { utils } from "./utils.js";

const dateUtils = window.DateUtils;

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

const parseNumber = (value) => {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseTimestamp = (value) => {
  if (!value) {
    return null;
  }
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
};

const decorateTripFeatures = (data) => {
  if (!data?.features?.length) {
    return;
  }

  const now = Date.now();
  const recentThresholdHours = CONFIG.MAP.recentTripThreshold / (60 * 60 * 1000);

  data.features.forEach((feature) => {
    const props = feature.properties || {};

    const startTs = parseTimestamp(props.es_startTs || props.startTime || props.start_time);
    const endTs = parseTimestamp(props.es_endTs || props.endTime || props.end_time);

    let durationSec = parseNumber(props.es_durationSec || props.duration || props.drivingTime);
    if (!durationSec && startTs && endTs) {
      durationSec = (endTs - startTs) / 1000;
    }

    const distanceMiles = parseNumber(
      props.es_distanceMiles || props.distance || props.distance_miles
    );
    let avgSpeed = parseNumber(
      props.es_avgSpeed || props.averageSpeed || props.avgSpeed || props.avg_speed
    );
    if (!avgSpeed && distanceMiles && durationSec) {
      avgSpeed = distanceMiles / (durationSec / 3600);
    }

    const recencyHours = endTs ? (now - endTs) / (60 * 60 * 1000) : null;

    props.es_startTs = startTs;
    props.es_endTs = endTs;
    props.es_durationSec = durationSec;
    props.es_distanceMiles = distanceMiles;
    props.es_avgSpeed = avgSpeed;
    props.es_recencyHours = recencyHours;
    props.es_recencyDays = recencyHours != null ? recencyHours / 24 : null;
    props.es_isRecent = recencyHours != null ? recencyHours <= recentThresholdHours : false;
    props.isRecent = props.isRecent ?? props.es_isRecent;

    feature.properties = props;
  });
};

const dataManager = {
  async fetchTrips() {
    if (!state.mapInitialized) {
      return null;
    }

    const { loadingManager } = window;
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
        window.notificationManager?.show("Failed to load valid trip data", "danger");
        return null;
      }

      decorateTripFeatures(tripData);

      loadingManager?.updateMessage(`Rendering ${tripData.features.length} trips...`);
      mapLoadingIndicator.update(`Rendering ${tripData.features.length} trips...`);

      await layerManager.updateMapLayer("trips", tripData);
      state.mapLayers.trips.layer = tripData;
      if (document.body) {
        document.body.classList.toggle(
          "map-has-trips",
          tripData.features.length > 0
        );
      }

      loadingManager?.updateMessage("Finalizing...");
      mapManager.refreshTripStyles();
      metricsManager.updateTripsTable(tripData);
      document.dispatchEvent(
        new CustomEvent("tripsUpdated", { detail: { trips: tripData } })
      );

      return tripData;
    } catch (error) {
      if (error?.name === "AbortError") {
        return null;
      }
      loadingManager?.hide();
      window.notificationManager?.show("Failed to load trips", "danger");
      return null;
    } finally {
      loadingManager?.hide();
      mapLoadingIndicator.hide();
    }
  },

  async fetchMatchedTrips() {
    if (!state.mapInitialized) {
      return null;
    }
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
          decorateTripFeatures(data);
        } catch (err) {
          console.warn("Failed to tag recent matched trips:", err);
        }

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

  async fetchUndrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.undrivenStreetsLoaded) {
      return null;
    }

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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching undriven streets:", error);
      state.undrivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchDrivenStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.drivenStreetsLoaded) {
      return null;
    }

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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching driven streets:", error);
      state.drivenStreetsLoaded = false;
      return null;
    }
  },

  async fetchAllStreets() {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !state.mapInitialized || state.allStreetsLoaded) {
      return null;
    }

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
      if (error?.name === "AbortError") {
        return null;
      }
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
      if (error?.name === "AbortError") {
        return null;
      }
      console.error("Error fetching metrics:", error);
      return null;
    }
  },

  async updateMap(fitBounds = false) {
    if (!state.mapInitialized) {
      return;
    }

    const { loadingManager } = window;
    loadingManager?.show("Updating map...");

    try {
      loadingManager?.updateMessage("Fetching map data...");
      state.cancelAllRequests();

      const promises = [];

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

      if (fitBounds) {
        await mapManager.fitBounds();
      }

      state.metrics.renderTime = Date.now() - state.metrics.loadStartTime;
    } catch (_error) {
      window.notificationManager?.show("Error updating map data", "danger");
    } finally {
      loadingManager?.hide();
    }
  },
};

export default dataManager;
