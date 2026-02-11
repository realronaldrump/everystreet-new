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

// ============================================================
// Data Manager
// ============================================================

const dataManager = {
  // Cache-buster version for vector tiles (fetched from backend).
  _tripTilesVersion: null,
  _tripTilesVersionCheckedAt: 0,

  async _getTripTilesVersion() {
    const now = Date.now();
    // Avoid a version fetch for every updateMap() call.
    if (this._tripTilesVersion && now - this._tripTilesVersionCheckedAt < 2000) {
      return this._tripTilesVersion;
    }
    this._tripTilesVersionCheckedAt = now;
    try {
      const data = await utils.fetchWithRetry(
        CONFIG.API.tripTilesVersion,
        {},
        0,
        0,
        "fetchTripTilesVersion"
      );
      const version = data?.version != null ? String(data.version) : null;
      if (version) {
        this._tripTilesVersion = version;
        return version;
      }
    } catch (err) {
      // Non-fatal: tiles will still render, but HTTP caches may serve stale content longer.
      console.warn("Failed to fetch trip tiles version:", err);
    }
    return this._tripTilesVersion;
  },

  /**
   * Convert app-local API paths to absolute URLs for map worker requests.
   * Some worker contexts cannot resolve relative request URLs reliably.
   * @private
   */
  _toAbsoluteApiUrl(url) {
    if (typeof url !== "string" || !url) {
      return url;
    }

    if (/^[a-z][a-z\d+\-.]*:/i.test(url) || url.startsWith("//")) {
      return url;
    }

    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : null;

    if (!origin) {
      return url;
    }

    try {
      return new URL(url, origin).toString();
    } catch {
      return url;
    }
  },

  /**
   * Fetch trips data and update the trips layer
   * @returns {Promise<Object|null>} Vector config or GeoJSON FeatureCollection (legacy) or null
   */
  async fetchTrips() {
    if (!state.mapInitialized) {
      return null;
    }

    loadingManager.show("Loading trips...", { blocking: false, compact: true });

    try {
      const { start, end } = DateUtils.getCachedDateRange();
      const imei = utils.getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
      const params = new URLSearchParams({ start_date: start, end_date: end });
      if (imei) {
        params.set("imei", imei);
      }
      loadingManager.updateMessage(`Loading trips from ${start} to ${end}...`);

      if (CONFIG.MAP.useVectorTripTiles) {
        const version = await this._getTripTilesVersion();
        if (version) {
          params.set("v", version);
        }
        const tileBase = this._toAbsoluteApiUrl(CONFIG.API.tripTiles);
        const tileTemplate = `${tileBase}/{z}/{x}/{y}.pbf?${params.toString()}`;
        const vectorConfig = {
          kind: "vector",
          tiles: [tileTemplate],
          sourceLayer: "trips",
          minzoom: 0,
          maxzoom: CONFIG.MAP.maxZoom,
        };

        loadingManager.updateMessage("Rendering trips...");
        await layerManager.updateMapLayer("trips", vectorConfig);

        document.dispatchEvent(
          new CustomEvent("tripsDataLoaded", {
            detail: {
              kind: "vector",
              featureCount: null,
              tileTemplate,
              start,
              end,
              imei: imei || null,
            },
          })
        );

        return vectorConfig;
      }

      // Legacy fallback (GeoJSON) for deployments that disable vector tiles.
      const rawTripData = await utils.fetchWithRetry(
        `${CONFIG.API.trips}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchTrips"
      );

      const tripData = this._coerceFeatureCollection(rawTripData);
      if (!tripData) {
        console.error("Trip data validation failed:", typeof rawTripData);
        notificationManager.show("Failed to load valid trip data", "danger");
        return null;
      }

      loadingManager.updateMessage(`Rendering ${tripData.features.length} trips...`);
      await layerManager.updateMapLayer("trips", tripData);

      document.dispatchEvent(
        new CustomEvent("tripsDataLoaded", {
          detail: { featureCount: tripData.features.length, geojson: tripData },
        })
      );

      metricsManager.updateTripsTable(tripData);
      return tripData;
    } catch (error) {
      if (error?.name === "AbortError") {
        return null;
      }
      notificationManager.show("Failed to load trips", "danger");
      return null;
    } finally {
      loadingManager.hide();
    }
  },

  /**
   * Fetch matched trips data and update the layer
   * @returns {Promise<Object|null>} Vector config or GeoJSON FeatureCollection (legacy) or null
   */
  async fetchMatchedTrips() {
    if (!state.mapInitialized) {
      return null;
    }

    loadingManager.pulse("Loading matched trips...");

    try {
      const { start, end } = DateUtils.getCachedDateRange();
      const imei = utils.getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
      const params = new URLSearchParams({ start_date: start, end_date: end });
      if (imei) {
        params.set("imei", imei);
      }

      if (CONFIG.MAP.useVectorTripTiles) {
        const version = await this._getTripTilesVersion();
        if (version) {
          params.set("v", version);
        }
        const tileBase = this._toAbsoluteApiUrl(CONFIG.API.matchedTripTiles);
        const tileTemplate = `${tileBase}/{z}/{x}/{y}.pbf?${params.toString()}`;
        const vectorConfig = {
          kind: "vector",
          tiles: [tileTemplate],
          sourceLayer: "trips",
          minzoom: 0,
          maxzoom: CONFIG.MAP.maxZoom,
        };

        state.mapLayers.matchedTrips.layer = vectorConfig;
        await layerManager.updateMapLayer("matchedTrips", vectorConfig);
        return vectorConfig;
      }

      // Legacy fallback (GeoJSON)
      const legacyParams = new URLSearchParams({
        start_date: start,
        end_date: end,
        format: "geojson",
        ...(imei ? { imei } : {}),
      });

      const rawData = await utils.fetchWithRetry(
        `${CONFIG.API.matchedTrips}?${legacyParams}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchMatchedTrips"
      );

      const data = this._coerceFeatureCollection(rawData);
      if (!data) {
        return null;
      }

      // Tag recent matched trips
      this._tagRecentTrips(data);

      state.mapLayers.matchedTrips.layer = data;
      await layerManager.updateMapLayer("matchedTrips", data);
      return data;
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
        f.properties.isRecent =
          typeof endTs === "number" && !Number.isNaN(endTs)
            ? now - endTs <= threshold
            : false;
      });
    } catch (err) {
      console.warn("Failed to tag recent matched trips:", err);
    }
  },

  /**
   * Normalize a layer name to match known map layer keys.
   * @private
   */
  _normalizeLayerName(layerName) {
    if (!layerName) {
      return null;
    }
    const name = String(layerName).trim();
    if (state.mapLayers?.[name]) {
      return name;
    }
    return null;
  },

  /**
   * Normalize GeoJSON FeatureCollection payloads.
   * @private
   */
  _coerceFeatureCollection(data) {
    if (!data) {
      return null;
    }

    const type = typeof data?.type === "string" ? data.type.toLowerCase() : "";
    const hasFeatures = Array.isArray(data?.features);

    if (type === "featurecollection" && hasFeatures) {
      return data;
    }

    if (hasFeatures) {
      return { ...data, type: "FeatureCollection" };
    }

    if (Array.isArray(data)) {
      return { type: "FeatureCollection", features: data };
    }

    return null;
  },

  /**
   * Generic street data fetcher to avoid duplication.
   * Uses a loading flag on state to prevent concurrent duplicate requests.
   * @private
   */
  async _fetchStreets(layerKey, loadedFlag, status, label) {
    const selectedLocationId = utils.getStorage(CONFIG.STORAGE_KEYS.selectedLocation);

    if (!selectedLocationId || !state.mapInitialized || state[loadedFlag]) {
      return null;
    }

    // Set flag immediately to prevent concurrent duplicate calls (race condition fix)
    state[loadedFlag] = true;

    loadingManager.pulse(`Loading ${label}...`);

    try {
      const params = status ? new URLSearchParams({ status }).toString() : "";
      const data = await utils.fetchWithRetry(
        CONFIG.API.coverageAreaAllStreets(selectedLocationId, params),
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        `fetch${layerKey.charAt(0).toUpperCase() + layerKey.slice(1)}`
      );

      if (data?.type === "FeatureCollection") {
        state.mapLayers[layerKey].layer = data;
        await layerManager.updateMapLayer(layerKey, data);
        return data;
      }

      // Data was invalid, reset flag
      state[loadedFlag] = false;
      return null;
    } catch (error) {
      state[loadedFlag] = false;
      if (error?.name === "AbortError") {
        return null;
      }
      console.error(`Error fetching ${label}:`, error);
      return null;
    }
  },

  fetchUndrivenStreets() {
    return this._fetchStreets(
      "undrivenStreets",
      "undrivenStreetsLoaded",
      "undriven",
      "undriven streets"
    );
  },

  fetchDrivenStreets() {
    return this._fetchStreets(
      "drivenStreets",
      "drivenStreetsLoaded",
      "driven",
      "driven streets"
    );
  },

  fetchAllStreets() {
    return this._fetchStreets(
      "allStreets",
      "allStreetsLoaded",
      undefined,
      "all streets"
    );
  },

  /**
   * Fetch metrics/analytics data
   * @returns {Promise<Object|null>}
   */
  async fetchMetrics() {
    try {
      const { start, end } = DateUtils.getCachedDateRange();
      const imei = utils.getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
      const params = new URLSearchParams({ start_date: start, end_date: end });
      if (imei) {
        params.set("imei", imei);
      }

      const data = await utils.fetchWithRetry(
        `${CONFIG.API.tripMetrics}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "fetchMetrics"
      );

      // `/api/metrics` returns strings for some numeric fields. Normalize for UI consumers.
      const totalTrips =
        Number.parseInt(data?.total_trips ?? data?.totalTrips ?? 0, 10) || 0;
      const totalDistanceMiles =
        Number.parseFloat(data?.total_distance ?? data?.totalDistance ?? 0) || 0;
      const avgSpeed = Number.parseFloat(data?.avg_speed ?? data?.avgSpeed ?? 0) || 0;
      const maxSpeed = Number.parseFloat(data?.max_speed ?? data?.maxSpeed ?? 0) || 0;
      const avgDistanceMiles =
        Number.parseFloat(data?.avg_distance ?? data?.avgDistance ?? 0) || 0;
      const avgStartTime = data?.avg_start_time ?? data?.avgStartTime ?? "--:--";
      const avgDrivingTime = data?.avg_driving_time ?? data?.avgDrivingTime ?? "--:--";

      // Update the legacy metrics table on the map page if it exists.
      metricsManager.updateTripsTableFromApi?.({
        totalTrips,
        totalDistanceMiles,
        avgDistanceMiles,
        avgStartTime,
        avgDrivingTime,
        avgSpeed,
        maxSpeed,
      });

      const detail = {
        source: "dataManager",
        updatedAt: Date.now(),
        totals: { totalTrips, totalDistanceMiles, avgSpeed, maxSpeed },
        metrics: {
          totalTrips,
          totalDistanceMiles,
          avgDistanceMiles,
          avgStartTime,
          avgDrivingTime,
          avgSpeed,
          maxSpeed,
        },
      };
      document.dispatchEvent(new CustomEvent("metricsUpdated", { detail }));

      // Store a copy for other modules (e.g. heatmap styling) to use without extra fetches.
      state.tripTotals = detail.totals;

      return detail;
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
      // Metrics are needed for the map stats widget regardless of which layers are toggled.
      promises.push(this.fetchMetrics());
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
    const normalizedLayerName = this._normalizeLayerName(layerName);
    if (!normalizedLayerName) {
      console.warn(`Unknown layer data requested: "${layerName}"`);
      return;
    }
    const fetchMap = {
      trips: () => this.fetchTrips(),
      matchedTrips: () => this.fetchMatchedTrips(),
      undrivenStreets: () => this.fetchUndrivenStreets(),
      drivenStreets: () => this.fetchDrivenStreets(),
      allStreets: () => this.fetchAllStreets(),
    };
    const fetcher = fetchMap[normalizedLayerName];
    if (fetcher) {
      await fetcher();
    } else {
      console.warn(`No fetcher for layer: "${normalizedLayerName}"`);
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
