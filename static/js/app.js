/* global mapboxgl, DateUtils */
"use strict";

(() => {
  // Configuration
  const CONFIG = {
    MAP: {
      defaultCenter: [-95.7129, 37.0902],
      defaultZoom: 4,
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours
      debounceDelay: 100,
      styles: {
        dark: "mapbox://styles/mapbox/dark-v11",
        light: "mapbox://styles/mapbox/light-v11",
        satellite: "mapbox://styles/mapbox/satellite-v9",
        streets: "mapbox://styles/mapbox/streets-v12",
      },
    },
    STORAGE_KEYS: {
      startDate: "startDate",
      endDate: "endDate",
      selectedLocation: "selectedLocation",
      sidebarState: "sidebarCollapsed",
    },
    API: {
      cacheTime: 10000, // 10 seconds
      retryAttempts: 3,
      retryDelay: 1000,
    },
    LAYER_DEFAULTS: {
      trips: {
        order: 1,
        color: "#BB86FC",
        opacity: 0.6,
        visible: true,
        highlightColor: "#FFD700",
        name: "Trips",
        weight: 2,
      },
      matchedTrips: {
        order: 3,
        color: "#CF6679",
        opacity: 0.6,
        visible: false,
        highlightColor: "#40E0D0",
        name: "Matched Trips",
        weight: 2,
      },
      undrivenStreets: {
        order: 2,
        color: "#00BFFF",
        opacity: 0.8,
        visible: false,
        name: "Undriven Streets",
        weight: 1.5,
      },
    },
  };

  // Application state
  class AppState {
    constructor() {
      this.map = null;
      this.mapInitialized = false;
      this.mapLayers = { ...CONFIG.LAYER_DEFAULTS };
      this.mapSettings = { highlightRecentTrips: true };
      this.selectedTripId = null;
      this.liveTracker = null;
      this.dom = new Map();
      this.listeners = new WeakMap();
      this.apiCache = new Map();
      this.abortControllers = new Map();
      this.undrivenStreetsLoaded = false;
    }

    reset() {
      // Cleanup map resources
      if (this.map) {
        this.map.remove();
        this.map = null;
      }
      this.mapInitialized = false;
      this.selectedTripId = null;
      this.dom.clear();
      this.apiCache.clear();
      this.cancelAllRequests();
    }

    cancelAllRequests() {
      this.abortControllers.forEach((controller) => controller.abort());
      this.abortControllers.clear();
    }
  }

  const state = new AppState();

  // Utility functions
  const utils = {
    getElement(selector) {
      if (state.dom.has(selector)) return state.dom.get(selector);

      const element = document.querySelector(
        selector.startsWith("#") ||
          selector.includes(" ") ||
          selector.startsWith(".")
          ? selector
          : `#${selector}`,
      );

      if (element) state.dom.set(selector, element);
      return element;
    },

    debounce(func, wait) {
      let timeout;
      return function executedFunction(...args) {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
      };
    },

    throttle(func, limit) {
      let inThrottle;
      return function (...args) {
        if (!inThrottle) {
          func.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
      };
    },

    async fetchWithRetry(
      url,
      options = {},
      retries = CONFIG.API.retryAttempts,
    ) {
      const key = `${url}_${JSON.stringify(options)}`;

      // Check cache first
      const cached = state.apiCache.get(key);
      if (cached && Date.now() - cached.timestamp < CONFIG.API.cacheTime) {
        return cached.data;
      }

      // Create abort controller for this request
      const abortController = new AbortController();
      state.abortControllers.set(key, abortController);

      try {
        const response = await fetch(url, {
          ...options,
          signal: abortController.signal,
        });

        if (!response.ok) {
          if (retries > 0 && response.status >= 500) {
            await new Promise((resolve) =>
              setTimeout(resolve, CONFIG.API.retryDelay),
            );
            return utils.fetchWithRetry(url, options, retries - 1);
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        state.apiCache.set(key, { data, timestamp: Date.now() });
        return data;
      } catch (error) {
        if (error.name === "AbortError") {
          console.log("Request aborted:", url);
          return null;
        }
        throw error;
      } finally {
        state.abortControllers.delete(key);
      }
    },

    showNotification(message, type = "info") {
      window.notificationManager?.show?.(message, type) ||
        console.log(`[${type.toUpperCase()}] ${message}`);
    },

    formatDuration(seconds) {
      if (!seconds || isNaN(seconds)) return "--:--";
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      return hours > 0
        ? `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
        : `${minutes}:${secs.toString().padStart(2, "0")}`;
    },
  };

  // Storage utilities
  const storage = {
    get(key, defaultValue = null) {
      try {
        return (
          window.utils?.getStorage?.(key) ??
          localStorage.getItem(key) ??
          defaultValue
        );
      } catch {
        return defaultValue;
      }
    },

    set(key, value) {
      try {
        window.utils?.setStorage?.(key, String(value)) ??
          localStorage.setItem(key, String(value));
        return true;
      } catch {
        return false;
      }
    },
  };

  // Date utilities
  const dateUtils = {
    getStartDate: () =>
      storage.get(CONFIG.STORAGE_KEYS.startDate) || DateUtils.getCurrentDate(),
    getEndDate: () =>
      storage.get(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate(),

    formatTimeFromHours(hours) {
      const h = Math.floor(hours);
      const m = Math.round((hours - h) * 60);
      return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    },
  };

  // Map manager
  const mapManager = {
    async initialize() {
      try {
        const mapElement = utils.getElement("map");
        if (!mapElement || state.map) return state.mapInitialized;

        if (!window.MAPBOX_ACCESS_TOKEN) {
          throw new Error("Mapbox access token not configured");
        }

        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

        if (!mapboxgl.supported()) {
          mapElement.innerHTML =
            '<div class="webgl-unsupported-message p-4 text-center">WebGL is not supported by your browser.</div>';
          throw new Error("WebGL not supported");
        }

        // Disable telemetry
        mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;

        const theme =
          document.documentElement.getAttribute("data-bs-theme") || "dark";

        state.map = new mapboxgl.Map({
          container: "map",
          style: CONFIG.MAP.styles[theme],
          center: CONFIG.MAP.defaultCenter,
          zoom: CONFIG.MAP.defaultZoom,
          maxZoom: CONFIG.MAP.maxZoom,
          attributionControl: false,
          logoPosition: "bottom-right",
          collectResourceTiming: false,
          transformRequest: (url) => {
            if (typeof url === "string" && url.includes("events.mapbox.com")) {
              return null;
            }
            return { url };
          },
        });

        window.map = state.map;

        // Add controls
        state.map.addControl(new mapboxgl.NavigationControl(), "top-right");
        state.map.addControl(
          new mapboxgl.AttributionControl({ compact: true }),
          "bottom-right",
        );

        // Setup event handlers
        state.map.on(
          "moveend",
          utils.debounce(() => this.updateUrlState(), CONFIG.MAP.debounceDelay),
        );
        state.map.on("click", this.handleMapClick.bind(this));

        await new Promise((resolve) => state.map.on("load", resolve));

        state.mapInitialized = true;
        document.dispatchEvent(new CustomEvent("mapInitialized"));

        return true;
      } catch (error) {
        console.error("Map initialization error:", error);
        utils.showNotification(
          `Map initialization failed: ${error.message}`,
          "danger",
        );
        return false;
      }
    },

    updateUrlState() {
      if (!state.map || !window.history?.replaceState) return;

      try {
        const center = state.map.getCenter();
        const zoom = state.map.getZoom();
        const url = new URL(window.location.href);

        url.searchParams.set("zoom", zoom.toFixed(2));
        url.searchParams.set("lat", center.lat.toFixed(5));
        url.searchParams.set("lng", center.lng.toFixed(5));

        window.history.replaceState({}, "", url.toString());
      } catch (error) {
        console.warn("Failed to update URL:", error);
      }
    },

    handleMapClick(e) {
      const features = state.map.queryRenderedFeatures(e.point);

      if (features.length === 0) {
        if (state.selectedTripId) {
          state.selectedTripId = null;
          this.refreshTripStyles();
        }
      } else {
        const tripFeature = features.find(
          (f) => f.source?.includes("trips") || f.source?.includes("matched"),
        );
        if (tripFeature) {
          tripInteractions.handleTripClick(e, tripFeature);
        }
      }
    },

    refreshTripStyles() {
      if (!state.map || !state.mapInitialized) return;

      ["trips", "matchedTrips"].forEach((layerName) => {
        const layerInfo = state.mapLayers[layerName];
        if (!layerInfo?.visible) return;

        const layerId = `${layerName}-layer`;
        if (state.map.getLayer(layerId)) {
          // Update paint properties based on selection/recent state
          const baseStyle = {
            "line-color": layerInfo.color,
            "line-opacity": layerInfo.opacity,
            "line-width": layerInfo.weight,
          };

          Object.entries(baseStyle).forEach(([property, value]) => {
            state.map.setPaintProperty(layerId, property, value);
          });
        }
      });
    },

    fitBounds() {
      if (!state.map || !state.mapInitialized) return;

      const bounds = new mapboxgl.LngLatBounds();
      let hasFeatures = false;

      Object.values(state.mapLayers).forEach(({ visible, layer }) => {
        if (visible && layer?.features) {
          layer.features.forEach((feature) => {
            if (feature.geometry) {
              if (feature.geometry.type === "Point") {
                bounds.extend(feature.geometry.coordinates);
                hasFeatures = true;
              } else if (feature.geometry.type === "LineString") {
                feature.geometry.coordinates.forEach((coord) => {
                  bounds.extend(coord);
                  hasFeatures = true;
                });
              }
            }
          });
        }
      });

      if (hasFeatures && !bounds.isEmpty()) {
        state.map.fitBounds(bounds, {
          padding: 50,
          maxZoom: 15,
          duration: 1000,
        });
      }
    },

    zoomToLastTrip(targetZoom = 14) {
      if (!state.map || !state.mapLayers.trips?.layer?.features) return;

      const features = state.mapLayers.trips.layer.features;
      let lastTripFeature = null;
      let latestTime = 0;

      features.forEach((feature) => {
        const endTime = feature.properties?.endTime;
        if (endTime) {
          const time = new Date(endTime).getTime();
          if (!isNaN(time) && time > latestTime) {
            latestTime = time;
            lastTripFeature = feature;
          }
        }
      });

      if (!lastTripFeature?.geometry) return;

      let lastCoord = null;
      const { type, coordinates } = lastTripFeature.geometry;

      if (type === "LineString" && coordinates?.length > 0) {
        lastCoord = coordinates[coordinates.length - 1];
      } else if (type === "Point") {
        lastCoord = coordinates;
      }

      if (
        lastCoord?.length === 2 &&
        typeof lastCoord[0] === "number" &&
        typeof lastCoord[1] === "number"
      ) {
        state.map.flyTo({
          center: lastCoord,
          zoom: targetZoom,
          duration: 2000,
          essential: true,
        });
      }
    },
  };

  // Layer manager
  const layerManager = {
    initializeControls() {
      const container = utils.getElement("layer-toggles");
      if (!container) return;

      container.innerHTML = "";
      const fragment = document.createDocumentFragment();

      Object.entries(state.mapLayers).forEach(([name, info]) => {
        const div = document.createElement("div");
        div.className =
          "layer-control d-flex align-items-center mb-2 p-2 rounded";
        div.dataset.layerName = name;

        const checkboxId = `${name}-toggle`;
        div.innerHTML = `
          <div class="form-check form-switch me-auto">
            <input class="form-check-input" type="checkbox" id="${checkboxId}" ${info.visible ? "checked" : ""}>
            <label class="form-check-label" for="${checkboxId}">${info.name || name}</label>
          </div>
          ${
            name !== "customPlaces"
              ? `
            <input type="color" id="${name}-color" value="${info.color}" 
                   class="form-control form-control-color me-2" 
                   style="width: 30px; height: 30px; padding: 2px;" 
                   title="Layer color">
            <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" value="${info.opacity}"
                   class="form-range" style="width: 80px;" title="Layer opacity">
          `
              : ""
          }
        `;

        fragment.appendChild(div);
      });

      container.appendChild(fragment);
      this.setupEventListeners(container);
      this.updateLayerOrder();
    },

    setupEventListeners(container) {
      container.addEventListener("change", (e) => {
        const input = e.target;
        const layerName = input.closest(".layer-control")?.dataset.layerName;
        if (!layerName) return;

        if (input.type === "checkbox") {
          this.toggleLayer(layerName, input.checked);
        } else if (input.type === "color") {
          this.updateLayerStyle(layerName, "color", input.value);
        } else if (input.type === "range") {
          this.updateLayerStyle(layerName, "opacity", parseFloat(input.value));
        }
      });
    },

    toggleLayer(name, visible) {
      const layerInfo = state.mapLayers[name];
      if (!layerInfo) return;

      layerInfo.visible = visible;
      storage.set(`layer_visible_${name}`, visible);

      if (name === "undrivenStreets" && visible) {
        state.undrivenStreetsLoaded = false;
        dataManager.fetchUndrivenStreets();
      }

      const layerId = `${name}-layer`;
      if (state.map?.getLayer(layerId)) {
        state.map.setLayoutProperty(
          layerId,
          "visibility",
          visible ? "visible" : "none",
        );
      }
    },

    updateLayerStyle(name, property, value) {
      const layerInfo = state.mapLayers[name];
      if (!layerInfo) return;

      layerInfo[property] = value;

      const layerId = `${name}-layer`;
      if (state.map?.getLayer(layerId)) {
        const paintProperty =
          property === "color" ? "line-color" : "line-opacity";
        state.map.setPaintProperty(layerId, paintProperty, value);
      }
    },

    updateLayerOrder() {
      const container = utils.getElement("layer-order-list");
      if (!container) return;

      const sortedLayers = Object.entries(state.mapLayers).sort(
        ([, a], [, b]) => (a.order || 0) - (b.order || 0),
      );

      container.innerHTML = sortedLayers
        .map(
          ([name, info]) => `
        <li class="list-group-item d-flex justify-content-between align-items-center" data-layer-name="${name}">
          <span>${info.name || name}</span>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-secondary move-up" title="Move Up">
              <i class="fas fa-arrow-up"></i>
            </button>
            <button class="btn btn-outline-secondary move-down" title="Move Down">
              <i class="fas fa-arrow-down"></i>
            </button>
          </div>
        </li>
      `,
        )
        .join("");

      container.addEventListener("click", (e) => {
        const button = e.target.closest("button");
        if (!button) return;

        const li = button.closest("li");
        const layerName = li?.dataset.layerName;
        if (!layerName) return;

        if (button.classList.contains("move-up") && li.previousElementSibling) {
          container.insertBefore(li, li.previousElementSibling);
        } else if (
          button.classList.contains("move-down") &&
          li.nextElementSibling
        ) {
          container.insertBefore(li.nextElementSibling, li);
        }

        this.reorderLayers();
      });
    },

    reorderLayers() {
      const container = utils.getElement("layer-order-list");
      if (!container) return;

      Array.from(container.children).forEach((item, index) => {
        const layerName = item.dataset.layerName;
        if (state.mapLayers[layerName]) {
          state.mapLayers[layerName].order = index;
        }
      });

      if (state.map && state.mapInitialized) {
        const sortedLayers = Object.entries(state.mapLayers).sort(
          ([, a], [, b]) => (b.order || 0) - (a.order || 0),
        );

        let beforeLayer = null;
        sortedLayers.forEach(([name]) => {
          const layerId = `${name}-layer`;
          if (state.map.getLayer(layerId)) {
            if (beforeLayer) {
              state.map.moveLayer(layerId, beforeLayer);
            }
            beforeLayer = layerId;
          }
        });
      }
    },

    async updateMapLayer(layerName, data) {
      if (!state.map || !state.mapInitialized || !data) return;

      const sourceId = `${layerName}-source`;
      const layerId = `${layerName}-layer`;
      const layerInfo = state.mapLayers[layerName];

      try {
        // Add or update source
        if (state.map.getSource(sourceId)) {
          state.map.getSource(sourceId).setData(data);
        } else {
          state.map.addSource(sourceId, { type: "geojson", data });
        }

        // Add layer if it doesn't exist
        if (!state.map.getLayer(layerId)) {
          const layerConfig = {
            id: layerId,
            type: "line",
            source: sourceId,
            layout: {
              visibility: layerInfo.visible ? "visible" : "none",
            },
            paint: {
              "line-color": layerInfo.color,
              "line-opacity": layerInfo.opacity,
              "line-width": layerInfo.weight,
            },
          };

          if (layerName === "undrivenStreets") {
            layerConfig.paint["line-dasharray"] = [2, 2];
          }

          state.map.addLayer(layerConfig);

          // Add click handler for trips
          if (layerName === "trips" || layerName === "matchedTrips") {
            state.map.on("click", layerId, (e) => {
              if (e.features?.length > 0) {
                tripInteractions.handleTripClick(e, e.features[0]);
              }
            });

            state.map.on("mouseenter", layerId, () => {
              state.map.getCanvas().style.cursor = "pointer";
            });

            state.map.on("mouseleave", layerId, () => {
              state.map.getCanvas().style.cursor = "";
            });
          }
        }
      } catch (error) {
        console.error(`Error updating ${layerName} layer:`, error);
      }
    },
  };

  // Data manager
  const dataManager = {
    async fetchTrips() {
      if (!state.mapInitialized) return null;

      try {
        const params = new URLSearchParams({
          start_date: dateUtils.getStartDate(),
          end_date: dateUtils.getEndDate(),
          fmt: "geojson",
        });

        const data = await utils.fetchWithRetry(`/api/export/trips?${params}`);

        if (data?.type === "FeatureCollection") {
          state.mapLayers.trips.layer = data;
          metricsManager.updateTripsTable(data);
          await layerManager.updateMapLayer("trips", data);
          return data;
        }

        return null;
      } catch (error) {
        console.error("Error fetching trips:", error);
        utils.showNotification("Failed to load trips", "danger");
        return null;
      }
    },

    async fetchMatchedTrips() {
      if (!state.mapInitialized || !state.mapLayers.matchedTrips.visible)
        return null;

      try {
        const params = new URLSearchParams({
          start_date: dateUtils.getStartDate(),
          end_date: dateUtils.getEndDate(),
          format: "geojson",
        });

        const data = await utils.fetchWithRetry(`/api/matched_trips?${params}`);

        if (data?.type === "FeatureCollection") {
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
      const selectedLocationId = storage.get(
        CONFIG.STORAGE_KEYS.selectedLocation,
      );
      if (
        !selectedLocationId ||
        !state.mapInitialized ||
        state.undrivenStreetsLoaded
      )
        return null;

      try {
        const coverageAreas = await this.fetchCoverageAreas();
        const selectedLocation = coverageAreas.find(
          (area) => area._id === selectedLocationId,
        );

        if (!selectedLocation?.location) {
          console.warn("Selected location not found:", selectedLocationId);
          return null;
        }

        const data = await utils.fetchWithRetry("/api/undriven_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(selectedLocation.location),
        });

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

    async fetchCoverageAreas() {
      try {
        const data = await utils.fetchWithRetry("/api/coverage_areas");
        return data?.areas || data || [];
      } catch (error) {
        console.error("Error fetching coverage areas:", error);
        return [];
      }
    },

    async fetchMetrics() {
      try {
        const params = new URLSearchParams({
          start_date: dateUtils.getStartDate(),
          end_date: dateUtils.getEndDate(),
        });

        const data = await utils.fetchWithRetry(
          `/api/trip-analytics?${params}`,
        );

        if (data) {
          document.dispatchEvent(
            new CustomEvent("metricsUpdated", { detail: data }),
          );
        }

        return data;
      } catch (error) {
        console.error("Error fetching metrics:", error);
        return null;
      }
    },

    async updateMap(fitBounds = false) {
      if (!state.mapInitialized) return;

      try {
        window.loadingManager?.show("Updating map...");

        const promises = [];

        if (state.mapLayers.trips.visible) {
          promises.push(this.fetchTrips());
        }

        if (state.mapLayers.matchedTrips.visible) {
          promises.push(this.fetchMatchedTrips());
        }

        if (state.mapLayers.undrivenStreets.visible) {
          promises.push(this.fetchUndrivenStreets());
        }

        await Promise.all(promises);

        if (fitBounds) {
          mapManager.fitBounds();
        }
      } catch (error) {
        console.error("Error updating map:", error);
        utils.showNotification("Error updating map data", "danger");
      } finally {
        window.loadingManager?.hide();
      }
    },
  };

  // Metrics manager
  const metricsManager = {
    updateTripsTable(geojson) {
      const elements = {
        totalTrips: utils.getElement("total-trips"),
        totalDistance: utils.getElement("total-distance"),
        avgDistance: utils.getElement("avg-distance"),
        avgStartTime: utils.getElement("avg-start-time"),
        avgDrivingTime: utils.getElement("avg-driving-time"),
        avgSpeed: utils.getElement("avg-speed"),
        maxSpeed: utils.getElement("max-speed"),
      };

      if (!geojson?.features) {
        Object.values(elements).forEach((el) => {
          if (el) el.textContent = el.id.includes("time") ? "--:--" : "0";
        });
        return;
      }

      const metrics = this.calculateMetrics(geojson.features);

      if (elements.totalTrips)
        elements.totalTrips.textContent = metrics.totalTrips;
      if (elements.totalDistance)
        elements.totalDistance.textContent = metrics.totalDistance.toFixed(1);
      if (elements.avgDistance)
        elements.avgDistance.textContent = metrics.avgDistance.toFixed(1);
      if (elements.avgStartTime)
        elements.avgStartTime.textContent = metrics.avgStartTime;
      if (elements.avgDrivingTime)
        elements.avgDrivingTime.textContent = metrics.avgDrivingTime;
      if (elements.avgSpeed)
        elements.avgSpeed.textContent = metrics.avgSpeed.toFixed(1);
      if (elements.maxSpeed)
        elements.maxSpeed.textContent = metrics.maxSpeed.toFixed(0);
    },

    calculateMetrics(features) {
      const metrics = {
        totalTrips: features.length,
        totalDistance: 0,
        totalDrivingTime: 0,
        totalStartHours: 0,
        maxSpeed: 0,
        validDistanceCount: 0,
        validDrivingTimeCount: 0,
        validStartTimeCount: 0,
      };

      features.forEach((feature) => {
        const props = feature.properties || {};

        // Distance
        if (props.distance && !isNaN(props.distance)) {
          metrics.totalDistance += parseFloat(props.distance);
          metrics.validDistanceCount++;
        }

        // Driving time
        let drivingTime = props.duration || props.drivingTime;
        if (!drivingTime && props.startTime && props.endTime) {
          const start = new Date(props.startTime);
          const end = new Date(props.endTime);
          if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
            drivingTime = (end - start) / 1000;
          }
        }

        if (drivingTime && !isNaN(drivingTime)) {
          metrics.totalDrivingTime += parseFloat(drivingTime);
          metrics.validDrivingTimeCount++;
        }

        // Start time
        if (props.startTime) {
          const startTime = new Date(props.startTime);
          if (!isNaN(startTime.getTime())) {
            metrics.totalStartHours +=
              startTime.getHours() + startTime.getMinutes() / 60;
            metrics.validStartTimeCount++;
          }
        }

        // Max speed
        if (props.maxSpeed && !isNaN(props.maxSpeed)) {
          metrics.maxSpeed = Math.max(
            metrics.maxSpeed,
            parseFloat(props.maxSpeed),
          );
        }
      });

      return {
        totalTrips: metrics.totalTrips,
        totalDistance: metrics.totalDistance,
        avgDistance:
          metrics.validDistanceCount > 0
            ? metrics.totalDistance / metrics.validDistanceCount
            : 0,
        avgStartTime:
          metrics.validStartTimeCount > 0
            ? dateUtils.formatTimeFromHours(
                metrics.totalStartHours / metrics.validStartTimeCount,
              )
            : "--:--",
        avgDrivingTime:
          metrics.validDrivingTimeCount > 0
            ? utils.formatDuration(
                metrics.totalDrivingTime / metrics.validDrivingTimeCount,
              )
            : "--:--",
        avgSpeed:
          metrics.totalDrivingTime > 0
            ? (metrics.totalDistance / metrics.totalDrivingTime) * 3600
            : 0,
        maxSpeed: metrics.maxSpeed,
      };
    },
  };

  // Trip interactions
  const tripInteractions = {
    handleTripClick(e, feature) {
      if (!feature?.properties) return;

      const tripId = feature.properties.id || feature.properties.tripId;
      if (tripId) {
        state.selectedTripId = tripId;
        mapManager.refreshTripStyles();
      }

      const popup = new mapboxgl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "400px",
      })
        .setLngLat(e.lngLat)
        .setHTML(this.createPopupContent(feature))
        .addTo(state.map);

      popup.on("open", () => this.setupPopupEventListeners(popup, feature));
    },

    createPopupContent(feature) {
      const props = feature.properties || {};

      const formatValue = (value, formatter) =>
        value != null ? formatter(value) : "N/A";
      const formatNumber = (value, digits = 1) =>
        formatValue(value, (v) => parseFloat(v).toFixed(digits));
      const formatTime = (value) =>
        formatValue(value, (v) =>
          new Date(v).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }),
        );

      let duration = props.duration || props.drivingTime;
      if (!duration && props.startTime && props.endTime) {
        const start = new Date(props.startTime);
        const end = new Date(props.endTime);
        if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
          duration = (end - start) / 1000;
        }
      }

      return `
        <div class="coverage-popup-content">
          <div class="popup-title">Trip Details</div>
          <div class="popup-detail">
            <span class="popup-label">Start:</span>
            <span>${formatTime(props.startTime)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">End:</span>
            <span>${formatTime(props.endTime)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Distance:</span>
            <span>${formatNumber(props.distance)} mi</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Duration:</span>
            <span>${utils.formatDuration(duration)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Avg Speed:</span>
            <span>${formatNumber(props.averageSpeed)} mph</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Max Speed:</span>
            <span>${formatNumber(props.maxSpeed)} mph</span>
          </div>
          ${this.createActionButtons(feature)}
        </div>
      `;
    },

    createActionButtons(feature) {
      const props = feature.properties || {};
      const isMatched =
        props.source === "matched" || props.mapMatchingStatus === "success";
      const tripId = props.id || props.tripId;

      if (!tripId) return "";

      return `
        <div class="popup-actions mt-3 d-flex gap-2 flex-wrap">
          <button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-eye"></i> View
          </button>
          ${
            isMatched
              ? `
            <button class="btn btn-sm btn-warning rematch-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-redo"></i> Rematch
            </button>
            <button class="btn btn-sm btn-danger delete-matched-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-trash"></i> Delete Matched
            </button>
          `
              : `
            <button class="btn btn-sm btn-info map-match-btn" data-trip-id="${tripId}">
              <i class="fas fa-route"></i> Map Match
            </button>
            <button class="btn btn-sm btn-danger delete-trip-btn" data-trip-id="${tripId}">
              <i class="fas fa-trash"></i> Delete
            </button>
          `
          }
        </div>
      `;
    },

    setupPopupEventListeners(popup, feature) {
      const popupElement = popup.getElement();
      if (!popupElement) return;

      popupElement.addEventListener("click", async (e) => {
        const button = e.target.closest("button");
        if (!button) return;

        const tripId = button.dataset.tripId;
        if (!tripId) return;

        try {
          if (button.classList.contains("view-trip-btn")) {
            window.open(`/trips/${tripId}`, "_blank");
          } else if (button.classList.contains("delete-matched-trip-btn")) {
            await this.deleteMatchedTrip(tripId, popup);
          } else if (button.classList.contains("delete-trip-btn")) {
            await this.deleteTrip(tripId, popup);
          } else if (
            button.classList.contains("rematch-trip-btn") ||
            button.classList.contains("map-match-btn")
          ) {
            await this.rematchTrip(tripId, popup);
          }
        } catch (error) {
          console.error("Error handling popup action:", error);
          utils.showNotification("Error performing action", "danger");
        }
      });
    },

    async deleteMatchedTrip(tripId, popup) {
      if (!confirm("Are you sure you want to delete this matched trip?"))
        return;

      try {
        const response = await fetch(`/api/matched_trips/${tripId}`, {
          method: "DELETE",
        });

        if (response.ok) {
          popup.remove();
          utils.showNotification(
            "Matched trip deleted successfully",
            "success",
          );
          await dataManager.updateMap();
        } else {
          const error = await response.json();
          throw new Error(error.detail || "Failed to delete matched trip");
        }
      } catch (error) {
        console.error("Error deleting matched trip:", error);
        utils.showNotification(error.message, "danger");
      }
    },

    async deleteTrip(tripId, popup) {
      if (
        !confirm(
          "Are you sure you want to delete this trip? This action cannot be undone.",
        )
      )
        return;

      try {
        const response = await fetch(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (response.ok) {
          popup.remove();
          utils.showNotification("Trip deleted successfully", "success");
          await dataManager.updateMap();
        } else {
          const error = await response.json();
          throw new Error(error.detail || "Failed to delete trip");
        }
      } catch (error) {
        console.error("Error deleting trip:", error);
        utils.showNotification(error.message, "danger");
      }
    },

    async rematchTrip(tripId, popup) {
      try {
        utils.showNotification("Starting map matching...", "info");

        const response = await fetch(`/api/process_trip/${tripId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map_match: true }),
        });

        if (response.ok) {
          popup.remove();
          utils.showNotification("Trip map matching completed", "success");
          await dataManager.updateMap();
        } else {
          const error = await response.json();
          throw new Error(error.detail || "Failed to remap trip");
        }
      } catch (error) {
        console.error("Error remapping trip:", error);
        utils.showNotification(error.message, "danger");
      }
    },
  };

  // Main application controller
  const app = {
    async initialize() {
      try {
        // Initialize date inputs
        this.initializeDates();

        // Initialize map if on map page
        if (
          utils.getElement("map") &&
          !document.getElementById("visits-page")
        ) {
          const mapInitialized = await mapManager.initialize();
          if (!mapInitialized) return;

          // Initialize UI components
          layerManager.initializeControls();
          await this.initializeLocationDropdown();
          this.initializeLiveTracker();
          this.setupEventListeners();

          // Restore layer visibility
          this.restoreLayerVisibility();

          // Load initial data
          await Promise.all([
            dataManager.fetchTrips(),
            dataManager.fetchMetrics(),
          ]);

          // Zoom to last trip if available
          if (state.mapLayers.trips?.layer?.features?.length > 0) {
            mapManager.zoomToLastTrip();
          }

          document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        }

        document.dispatchEvent(new CustomEvent("appReady"));
      } catch (error) {
        console.error("Application initialization error:", error);
        utils.showNotification(
          `Initialization failed: ${error.message}`,
          "danger",
        );
      } finally {
        window.loadingManager?.finish();
      }
    },

    initializeDates() {
      const startDateInput = utils.getElement("start-date");
      const endDateInput = utils.getElement("end-date");

      if (startDateInput && !startDateInput.value) {
        startDateInput.value = dateUtils.getStartDate();
      }
      if (endDateInput && !endDateInput.value) {
        endDateInput.value = dateUtils.getEndDate();
      }
    },

    initializeLiveTracker() {
      if (window.LiveTripTracker && state.map && !state.liveTracker) {
        try {
          state.liveTracker = new window.LiveTripTracker(state.map);
        } catch (error) {
          console.error("LiveTripTracker initialization error:", error);
        }
      }
    },

    async initializeLocationDropdown() {
      const dropdown = utils.getElement("undriven-streets-location");
      if (!dropdown) return;

      try {
        const areas = await dataManager.fetchCoverageAreas();

        dropdown.innerHTML = '<option value="">Select a location...</option>';
        areas.forEach((area) => {
          const option = document.createElement("option");
          option.value = area._id || area.id;
          option.textContent =
            area.location?.display_name ||
            area.location?.city ||
            area.name ||
            area.city ||
            "Unknown Location";
          dropdown.appendChild(option);
        });

        const savedLocationId = storage.get(
          CONFIG.STORAGE_KEYS.selectedLocation,
        );
        if (savedLocationId) {
          dropdown.value = savedLocationId;
        }
      } catch (error) {
        console.error("Error populating location dropdown:", error);
        utils.showNotification("Failed to load coverage areas", "warning");
      }
    },

    restoreLayerVisibility() {
      Object.keys(state.mapLayers).forEach((layerName) => {
        const toggle = document.getElementById(`${layerName}-toggle`);

        if (layerName === "trips") {
          state.mapLayers[layerName].visible = true;
          if (toggle) toggle.checked = true;
        } else {
          const savedVisibility = storage.get(`layer_visible_${layerName}`);
          if (savedVisibility !== null) {
            const isVisible = savedVisibility === "true";
            state.mapLayers[layerName].visible = isVisible;
            if (toggle) toggle.checked = isVisible;
          }
        }
      });
    },

    setupEventListeners() {
      // Controls toggle
      const controlsToggle = utils.getElement("controls-toggle");
      if (controlsToggle) {
        controlsToggle.addEventListener("click", () => {
          const content = utils.getElement("controls-content");
          const icon = controlsToggle.querySelector("i");
          if (content && icon) {
            setTimeout(() => {
              const isCollapsed = !content.classList.contains("show");
              icon.className = isCollapsed
                ? "fas fa-chevron-down"
                : "fas fa-chevron-up";
            }, 350);
          }
        });
      }

      // Location dropdown
      const locationDropdown = utils.getElement("undriven-streets-location");
      if (locationDropdown) {
        locationDropdown.addEventListener("change", (e) => {
          storage.set(CONFIG.STORAGE_KEYS.selectedLocation, e.target.value);
          if (e.target.value && state.mapLayers.undrivenStreets.visible) {
            state.undrivenStreetsLoaded = false;
            dataManager.fetchUndrivenStreets();
          }
        });
      }

      // Center on location button
      const centerButton = utils.getElement("center-on-location");
      if (centerButton) {
        centerButton.addEventListener("click", () => {
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
              (position) => {
                const { latitude, longitude } = position.coords;
                state.map.flyTo({
                  center: [longitude, latitude],
                  zoom: 14,
                  duration: 1000,
                });
              },
              (error) => {
                console.error("Geolocation error:", error);
                utils.showNotification(
                  "Unable to get your location",
                  "warning",
                );
              },
            );
          } else {
            utils.showNotification("Geolocation is not supported", "warning");
          }
        });
      }

      // Highlight recent trips toggle
      const highlightToggle = utils.getElement("highlight-recent-trips");
      if (highlightToggle) {
        highlightToggle.addEventListener("change", (e) => {
          state.mapSettings.highlightRecentTrips = e.target.checked;
          mapManager.refreshTripStyles();
        });
      }

      // Listen for filter events
      document.addEventListener("filtersApplied", () => {
        if (state.mapInitialized) {
          dataManager.updateMap(true);
        }
      });

      // Keyboard shortcuts
      window.addEventListener("keydown", (e) => {
        if (
          !state.map ||
          document.activeElement.matches("input, textarea, select")
        )
          return;

        const keyActions = {
          "+": () => state.map.zoomIn(),
          "=": () => state.map.zoomIn(),
          "-": () => state.map.zoomOut(),
          _: () => state.map.zoomOut(),
          ArrowUp: () => state.map.panBy([0, -100]),
          ArrowDown: () => state.map.panBy([0, 100]),
          ArrowLeft: () => state.map.panBy([-100, 0]),
          ArrowRight: () => state.map.panBy([100, 0]),
        };

        if (keyActions[e.key]) {
          keyActions[e.key]();
          e.preventDefault();
        }
      });

      // Cleanup on page visibility change
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          state.apiCache.clear();
        }
      });

      // Cleanup on page unload
      window.addEventListener("beforeunload", () => {
        state.cancelAllRequests();
        state.apiCache.clear();
      });
    },

    // Public API methods
    async mapMatchTrips() {
      try {
        utils.showNotification("Starting map matching process...", "info");

        const response = await fetch("/api/map_match_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_date: dateUtils.getStartDate(),
            end_date: dateUtils.getEndDate(),
          }),
        });

        if (response.ok) {
          const result = await response.json();
          utils.showNotification(
            `Map matching completed: ${result.message}`,
            "success",
          );
          await dataManager.updateMap();
        } else {
          const error = await response.json();
          throw new Error(error.detail || "Map matching failed");
        }
      } catch (error) {
        console.error("Map matching error:", error);
        utils.showNotification(
          `Map matching error: ${error.message}`,
          "danger",
        );
      }
    },

    async fetchTripsInRange() {
      try {
        const response = await fetch("/api/fetch_trips_range", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_date: dateUtils.getStartDate(),
            end_date: dateUtils.getEndDate(),
          }),
        });

        if (response.ok) {
          const result = await response.json();
          utils.showNotification(
            `Fetched ${result.new_trips || 0} new trips`,
            "success",
          );
          await dataManager.updateMap();
        } else {
          const error = await response.json();
          throw new Error(error.detail || "Failed to fetch trips");
        }
      } catch (error) {
        console.error("Fetch trips error:", error);
        utils.showNotification(`Fetch error: ${error.message}`, "danger");
      }
    },
  };

  // Initialize application
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => app.initialize());
  } else {
    app.initialize();
  }

  // Export public API
  window.AppState = state;
  window.CONFIG = CONFIG;
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.App = {
    fetchTrips: dataManager.fetchTrips.bind(dataManager),
    updateMap: dataManager.updateMap.bind(dataManager),
    refreshTripStyles: mapManager.refreshTripStyles.bind(mapManager),
    updateTripsTable: metricsManager.updateTripsTable.bind(metricsManager),
    toggleLayer: layerManager.toggleLayer.bind(layerManager),
    fetchMetrics: dataManager.fetchMetrics.bind(dataManager),
    initializeMap: mapManager.initialize.bind(mapManager),
    getStartDate: dateUtils.getStartDate,
    getEndDate: dateUtils.getEndDate,
    fitMapBounds: mapManager.fitBounds.bind(mapManager),
    mapMatchTrips: app.mapMatchTrips.bind(app),
    fetchTripsInRange: app.fetchTripsInRange.bind(app),
    AppState: state,
    CONFIG,
  };
})();
