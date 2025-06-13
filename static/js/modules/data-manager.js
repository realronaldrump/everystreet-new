import utils from "./utils.js";
import state from "./state.js";
import dateUtils from "./date-utils.js";
import layerManager from "./layer-manager.js";
import metricsManager from "./metrics-manager.js";
import mapManager from "./map-manager.js";
import { CONFIG } from "./config.js";

const dataManager = {
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
