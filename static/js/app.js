/* global mapboxgl, DateUtils */
"use strict";

(() => {
  // Configuration with performance optimizations
  const CONFIG = {
    MAP: {
      defaultCenter: [-95.7129, 37.0902],
      defaultZoom: 4,
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours
      debounceDelay: 150,
      throttleDelay: 50,
      styles: {
        dark: "mapbox://styles/mapbox/dark-v11",
        light: "mapbox://styles/mapbox/light-v11",
        satellite: "mapbox://styles/mapbox/satellite-v9",
        streets: "mapbox://styles/mapbox/streets-v12",
      },
      // Performance options
      performanceOptions: {
        trackResize: false,
        refreshExpiredTiles: false,
        fadeDuration: 300,
        antialias: false,
      },
    },
    STORAGE_KEYS: {
      startDate: "startDate",
      endDate: "endDate",
      selectedLocation: "selectedLocation",
      sidebarState: "sidebarCollapsed",
      layerVisibility: "layerVisibility",
      layerSettings: "layerSettings",
    },
    API: {
      cacheTime: 30000, // 30 seconds
      retryAttempts: 3,
      retryDelay: 1000,
      timeout: 30000,
      batchSize: 100, // For batched operations
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
        minzoom: 0,
        maxzoom: 22,
      },
      matchedTrips: {
        order: 3,
        color: "#CF6679",
        opacity: 0.6,
        visible: false,
        highlightColor: "#40E0D0",
        name: "Matched Trips",
        weight: 2,
        minzoom: 0,
        maxzoom: 22,
      },
      undrivenStreets: {
        order: 2,
        color: "#00BFFF",
        opacity: 0.8,
        visible: false,
        name: "Undriven Streets",
        weight: 1.5,
        minzoom: 10,
        maxzoom: 22,
      },
    },
    PERFORMANCE: {
      enableWebGL: true,
      enableWorkers: true,
      workerCount: navigator.hardwareConcurrency || 4,
      maxParallelRequests: 6,
    },
  };

  // Application state with better structure
  class AppState {
    constructor() {
      this.map = null;
      this.mapInitialized = false;
      this.mapLayers = JSON.parse(JSON.stringify(CONFIG.LAYER_DEFAULTS)); // Deep clone
      this.mapSettings = {
        highlightRecentTrips: true,
        autoRefresh: false,
        clusterTrips: false,
      };
      this.selectedTripId = null;
      this.liveTracker = null;
      this.dom = new Map();
      this.listeners = new WeakMap();
      this.apiCache = new Map();
      this.abortControllers = new Map();
      this.loadingStates = new Map();
      this.pendingRequests = new Set();
      this.layerLoadPromises = new Map();

      // Performance tracking
      this.metrics = {
        loadStartTime: Date.now(),
        mapLoadTime: null,
        dataLoadTime: null,
        renderTime: null,
      };
    }

    reset() {
      this.cancelAllRequests();

      if (this.map) {
        // Properly cleanup map resources
        this.map.off();
        this.map.remove();
        this.map = null;
      }

      this.mapInitialized = false;
      this.selectedTripId = null;
      this.dom.clear();
      this.apiCache.clear();
      this.loadingStates.clear();
      this.pendingRequests.clear();
      this.layerLoadPromises.clear();
    }

    cancelAllRequests() {
      this.abortControllers.forEach((controller) => {
        try {
          controller.abort();
        } catch (e) {
          console.warn("Error aborting request:", e);
        }
      });
      this.abortControllers.clear();
      this.pendingRequests.clear();
    }

    trackRequest(url) {
      this.pendingRequests.add(url);
    }

    completeRequest(url) {
      this.pendingRequests.delete(url);
    }

    hasPendingRequests() {
      return this.pendingRequests.size > 0;
    }
  }

  const state = new AppState();

  // Enhanced utility functions
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
      let lastCallTime = 0;

      return function executedFunction(...args) {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        const later = () => {
          clearTimeout(timeout);
          lastCallTime = Date.now();
          func(...args);
        };

        clearTimeout(timeout);

        // Execute immediately if enough time has passed
        if (timeSinceLastCall >= wait) {
          lastCallTime = now;
          func(...args);
        } else {
          timeout = setTimeout(later, wait);
        }
      };
    },

    throttle(func, limit) {
      let inThrottle;
      let lastResult;

      return function (...args) {
        if (!inThrottle) {
          lastResult = func.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
        return lastResult;
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

      // Create abort controller
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        CONFIG.API.timeout,
      );

      state.abortControllers.set(key, abortController);
      state.trackRequest(url);

      try {
        const response = await fetch(url, {
          ...options,
          signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (retries > 0 && response.status >= 500) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                CONFIG.API.retryDelay *
                  (CONFIG.API.retryAttempts - retries + 1),
              ),
            );
            return utils.fetchWithRetry(url, options, retries - 1);
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache successful response
        state.apiCache.set(key, { data, timestamp: Date.now() });

        return data;
      } catch (error) {
        if (error.name === "AbortError") {
          console.log("Request aborted or timed out:", url);
          throw new Error("Request timeout");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        state.abortControllers.delete(key);
        state.completeRequest(url);
      }
    },

    showNotification(message, type = "info", duration = 5000) {
      window.notificationManager?.show?.(message, type, duration) ||
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

    async measurePerformance(name, fn) {
      const startTime = performance.now();
      try {
        const result = await fn();
        const duration = performance.now() - startTime;
        console.log(`Performance: ${name} took ${duration.toFixed(2)}ms`);
        return result;
      } catch (error) {
        const duration = performance.now() - startTime;
        console.error(
          `Performance: ${name} failed after ${duration.toFixed(2)}ms`,
          error,
        );
        throw error;
      }
    },

    // Batch DOM updates for better performance
    batchDOMUpdates(updates) {
      requestAnimationFrame(() => {
        updates.forEach((update) => update());
      });
    },
  };

  // Enhanced storage utilities with compression
  const storage = {
    get(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(key);
        if (value === null) return defaultValue;

        // Try to parse JSON
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      } catch {
        return defaultValue;
      }
    },

    set(key, value) {
      try {
        const stringValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);

        localStorage.setItem(key, stringValue);
        return true;
      } catch (e) {
        console.warn("Storage quota exceeded:", e);
        // Try to clear old cache entries
        this.clearOldCache();
        try {
          localStorage.setItem(key, stringValue);
          return true;
        } catch {
          return false;
        }
      }
    },

    clearOldCache() {
      const cacheKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("cache_")) {
          cacheKeys.push(key);
        }
      }

      // Remove oldest cache entries
      cacheKeys
        .slice(0, Math.floor(cacheKeys.length / 2))
        .forEach((key) => localStorage.removeItem(key));
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

    // Cache date range to avoid repeated calculations
    getCachedDateRange() {
      const cacheKey = "cached_date_range";
      const cached = storage.get(cacheKey);
      const currentStart = this.getStartDate();
      const currentEnd = this.getEndDate();

      if (
        cached &&
        cached.start === currentStart &&
        cached.end === currentEnd
      ) {
        return cached;
      }

      const range = {
        start: currentStart,
        end: currentEnd,
        startDate: new Date(currentStart),
        endDate: new Date(currentEnd),
        days:
          Math.ceil(
            (new Date(currentEnd) - new Date(currentStart)) /
              (1000 * 60 * 60 * 24),
          ) + 1,
      };

      storage.set(cacheKey, range);
      return range;
    },
  };

  // Enhanced map manager
  const mapManager = {
    async initialize() {
      try {
        const initStage = window.loadingManager.startStage(
          "init",
          "Initializing map...",
        );

        const mapElement = utils.getElement("map");
        if (!mapElement || state.map) {
          initStage.complete();
          return state.mapInitialized;
        }

        if (!window.MAPBOX_ACCESS_TOKEN) {
          throw new Error("Mapbox access token not configured");
        }

        mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

        if (!mapboxgl.supported()) {
          mapElement.innerHTML =
            '<div class="webgl-unsupported-message p-4 text-center">WebGL is not supported by your browser.</div>';
          throw new Error("WebGL not supported");
        }

        initStage.update(30, "Configuring map...");

        // Disable telemetry for performance
        mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;
        mapboxgl.config.COLLECT_RESOURCE_TIMING = false;

        const theme =
          document.documentElement.getAttribute("data-bs-theme") || "dark";

        // Get saved map position
        const savedView = storage.get("mapView");
        const center = savedView?.center || CONFIG.MAP.defaultCenter;
        const zoom = savedView?.zoom || CONFIG.MAP.defaultZoom;

        initStage.update(60, "Creating map instance...");

        state.map = new mapboxgl.Map({
          container: "map",
          style: CONFIG.MAP.styles[theme],
          center,
          zoom,
          maxZoom: CONFIG.MAP.maxZoom,
          attributionControl: false,
          logoPosition: "bottom-right",
          ...CONFIG.MAP.performanceOptions,
          transformRequest: (url) => {
            if (typeof url === "string" && url.includes("events.mapbox.com")) {
              return null;
            }
            return { url };
          },
        });

        window.map = state.map;

        initStage.update(80, "Adding controls...");

        // Add controls
        state.map.addControl(new mapboxgl.NavigationControl(), "top-right");
        state.map.addControl(
          new mapboxgl.AttributionControl({ compact: true }),
          "bottom-right",
        );

        // Setup event handlers
        const saveViewState = utils.debounce(() => {
          if (!state.map) return;
          const center = state.map.getCenter();
          const zoom = state.map.getZoom();
          storage.set("mapView", { center: [center.lng, center.lat], zoom });
          this.updateUrlState();
        }, CONFIG.MAP.debounceDelay);

        state.map.on("moveend", saveViewState);
        state.map.on("click", this.handleMapClick.bind(this));

        // Wait for map to load
        await new Promise((resolve) => {
          state.map.on("load", () => {
            initStage.complete();
            resolve();
          });
        });

        state.mapInitialized = true;
        state.metrics.mapLoadTime = Date.now() - state.metrics.loadStartTime;

        document.dispatchEvent(new CustomEvent("mapInitialized"));

        return true;
      } catch (error) {
        console.error("Map initialization error:", error);
        window.loadingManager.stageError("init", error.message);
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
      const features = state.map.queryRenderedFeatures(e.point, {
        layers: ["trips-layer", "matchedTrips-layer"],
      });

      if (features.length === 0) {
        if (state.selectedTripId) {
          state.selectedTripId = null;
          this.refreshTripStyles();
        }
      } else {
        const tripFeature = features[0];
        if (tripFeature) {
          tripInteractions.handleTripClick(e, tripFeature);
        }
      }
    },

    refreshTripStyles: utils.throttle(function () {
      if (!state.map || !state.mapInitialized) return;

      ["trips", "matchedTrips"].forEach((layerName) => {
        const layerInfo = state.mapLayers[layerName];
        if (!layerInfo?.visible) return;

        const layerId = `${layerName}-layer`;
        if (state.map.getLayer(layerId)) {
          // Batch paint property updates
          const updates = {
            "line-color": layerInfo.color,
            "line-opacity": layerInfo.opacity,
            "line-width": layerInfo.weight,
          };

          Object.entries(updates).forEach(([property, value]) => {
            state.map.setPaintProperty(layerId, property, value);
          });
        }
      });
    }, CONFIG.MAP.throttleDelay),

    async fitBounds(animate = true) {
      if (!state.map || !state.mapInitialized) return;

      await utils.measurePerformance("fitBounds", async () => {
        const bounds = new mapboxgl.LngLatBounds();
        let hasFeatures = false;

        // Collect all visible features
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
            duration: animate ? 1000 : 0,
          });
        }
      });
    },

    zoomToLastTrip(targetZoom = 14) {
      if (!state.map || !state.mapLayers.trips?.layer?.features) return;

      const features = state.mapLayers.trips.layer.features;

      // Find the most recent trip
      const lastTripFeature = features.reduce((latest, feature) => {
        const endTime = feature.properties?.endTime;
        if (!endTime) return latest;

        const time = new Date(endTime).getTime();
        const latestTime = latest?.properties?.endTime
          ? new Date(latest.properties.endTime).getTime()
          : 0;

        return time > latestTime ? feature : latest;
      }, null);

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
        !isNaN(lastCoord[0]) &&
        !isNaN(lastCoord[1])
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

  // Enhanced layer manager
  const layerManager = {
    initializeControls() {
      const container = utils.getElement("layer-toggles");
      if (!container) return;

      // Load saved layer settings
      const savedSettings =
        storage.get(CONFIG.STORAGE_KEYS.layerSettings) || {};
      Object.entries(savedSettings).forEach(([name, settings]) => {
        if (state.mapLayers[name]) {
          Object.assign(state.mapLayers[name], settings);
        }
      });

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
            <input class="form-check-input" type="checkbox" id="${checkboxId}" 
                   ${info.visible ? "checked" : ""} role="switch">
            <label class="form-check-label" for="${checkboxId}">
              ${info.name || name}
              <span class="layer-loading d-none" id="${name}-loading"></span>
            </label>
          </div>
          ${
            name !== "customPlaces"
              ? `
            <input type="color" id="${name}-color" value="${info.color}" 
                   class="form-control form-control-color me-2" 
                   style="width: 30px; height: 30px; padding: 2px;" 
                   title="Layer color">
            <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" 
                   value="${info.opacity}" class="form-range" style="width: 80px;" 
                   title="Layer opacity">
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
      container.addEventListener(
        "change",
        utils.debounce((e) => {
          const input = e.target;
          const layerName = input.closest(".layer-control")?.dataset.layerName;
          if (!layerName) return;

          if (input.type === "checkbox") {
            this.toggleLayer(layerName, input.checked);
          } else if (input.type === "color") {
            this.updateLayerStyle(layerName, "color", input.value);
          } else if (input.type === "range") {
            this.updateLayerStyle(
              layerName,
              "opacity",
              parseFloat(input.value),
            );
          }

          // Save layer settings
          this.saveLayerSettings();
        }, 200),
      );
    },

    async toggleLayer(name, visible) {
      const layerInfo = state.mapLayers[name];
      if (!layerInfo) return;

      layerInfo.visible = visible;

      // Show loading indicator
      const loadingEl = document.getElementById(`${name}-loading`);
      if (loadingEl) loadingEl.classList.remove("d-none");

      if (visible) {
        // Load layer data if needed
        if (name === "matchedTrips" && !layerInfo.layer) {
          await dataManager.fetchMatchedTrips();
        } else if (name === "undrivenStreets" && !state.undrivenStreetsLoaded) {
          await dataManager.fetchUndrivenStreets();
        }
      }

      const layerId = `${name}-layer`;
      if (state.map?.getLayer(layerId)) {
        state.map.setLayoutProperty(
          layerId,
          "visibility",
          visible ? "visible" : "none",
        );
      }

      // Hide loading indicator
      if (loadingEl) loadingEl.classList.add("d-none");
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

    saveLayerSettings() {
      const settings = {};
      Object.entries(state.mapLayers).forEach(([name, info]) => {
        settings[name] = {
          visible: info.visible,
          color: info.color,
          opacity: info.opacity,
          order: info.order,
        };
      });
      storage.set(CONFIG.STORAGE_KEYS.layerSettings, settings);
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
          <li class="list-group-item d-flex justify-content-between align-items-center" 
              data-layer-name="${name}" draggable="true">
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

      // Add drag and drop support
      this.setupDragAndDrop(container);

      // Button click handlers
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

    setupDragAndDrop(container) {
      let draggedElement = null;

      container.addEventListener("dragstart", (e) => {
        draggedElement = e.target.closest("li");
        if (draggedElement) {
          draggedElement.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
        }
      });

      container.addEventListener("dragend", (e) => {
        if (draggedElement) {
          draggedElement.classList.remove("dragging");
          draggedElement = null;
          this.reorderLayers();
        }
      });

      container.addEventListener("dragover", (e) => {
        e.preventDefault();
        const afterElement = this.getDragAfterElement(container, e.clientY);
        if (afterElement == null) {
          container.appendChild(draggedElement);
        } else {
          container.insertBefore(draggedElement, afterElement);
        }
      });
    },

    getDragAfterElement(container, y) {
      const draggableElements = [
        ...container.querySelectorAll("li:not(.dragging)"),
      ];

      return draggableElements.reduce(
        (closest, child) => {
          const box = child.getBoundingClientRect();
          const offset = y - box.top - box.height / 2;

          if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
          } else {
            return closest;
          }
        },
        { offset: Number.NEGATIVE_INFINITY },
      ).element;
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

        // Reorder layers on the map
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

      this.saveLayerSettings();
    },

    async updateMapLayer(layerName, data) {
      if (!state.map || !state.mapInitialized || !data) return;

      const sourceId = `${layerName}-source`;
      const layerId = `${layerName}-layer`;
      const layerInfo = state.mapLayers[layerName];

      try {
        // Update or add source
        const source = state.map.getSource(sourceId);
        if (source) {
          source.setData(data);
        } else {
          state.map.addSource(sourceId, {
            type: "geojson",
            data,
            tolerance: 0.5, // Simplify geometry for performance
            buffer: 128, // Tile buffer size
            maxzoom: 14, // Don't over-zoom vector tiles
            generateId: true, // Generate feature IDs for better performance
          });
        }

        // Add layer if it doesn't exist
        if (!state.map.getLayer(layerId)) {
          const layerConfig = {
            id: layerId,
            type: "line",
            source: sourceId,
            minzoom: layerInfo.minzoom || 0,
            maxzoom: layerInfo.maxzoom || 22,
            layout: {
              visibility: layerInfo.visible ? "visible" : "none",
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": layerInfo.color,
              "line-opacity": layerInfo.opacity,
              "line-width": [
                "interpolate",
                ["linear"],
                ["zoom"],
                10,
                layerInfo.weight * 0.5,
                15,
                layerInfo.weight,
                20,
                layerInfo.weight * 2,
              ],
            },
          };

          if (layerName === "undrivenStreets") {
            layerConfig.paint["line-dasharray"] = [2, 2];
          }

          state.map.addLayer(layerConfig);

          // Add interactivity for trips
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

        // Store layer data
        layerInfo.layer = data;
      } catch (error) {
        console.error(`Error updating ${layerName} layer:`, error);
        utils.showNotification(
          `Failed to update ${layerName} layer`,
          "warning",
        );
      }
    },
  };

  // Enhanced data manager with better performance
  const dataManager = {
    async fetchTrips() {
      if (!state.mapInitialized) return null;

      const dataStage = window.loadingManager.startStage(
        "data",
        "Loading trips...",
      );

      try {
        const dateRange = dateUtils.getCachedDateRange();
        const params = new URLSearchParams({
          start_date: dateRange.start,
          end_date: dateRange.end,
          fmt: "geojson",
        });

        dataStage.update(30, `Loading trips for ${dateRange.days} days...`);

        const data = await utils.fetchWithRetry(`/api/export/trips?${params}`);

        if (data?.type === "FeatureCollection") {
          dataStage.update(70, `Processing ${data.features.length} trips...`);

          state.mapLayers.trips.layer = data;
          metricsManager.updateTripsTable(data);
          await layerManager.updateMapLayer("trips", data);

          dataStage.complete();
          return data;
        }

        dataStage.error("Invalid trip data received");
        return null;
      } catch (error) {
        dataStage.error(error.message);
        console.error("Error fetching trips:", error);
        utils.showNotification("Failed to load trips", "danger");
        return null;
      }
    },

    async fetchMatchedTrips() {
      if (!state.mapInitialized || !state.mapLayers.matchedTrips.visible)
        return null;

      window.loadingManager.pulse("Loading matched trips...");

      try {
        const dateRange = dateUtils.getCachedDateRange();
        const params = new URLSearchParams({
          start_date: dateRange.start,
          end_date: dateRange.end,
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

      window.loadingManager.pulse("Loading undriven streets...");

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
        // Cache coverage areas as they don't change often
        const cacheKey = "coverage_areas";
        const cached = storage.get(cacheKey);
        if (cached && cached.timestamp > Date.now() - 3600000) {
          // 1 hour cache
          return cached.data;
        }

        const data = await utils.fetchWithRetry("/api/coverage_areas");
        const areas = data?.areas || data || [];

        storage.set(cacheKey, { data: areas, timestamp: Date.now() });
        return areas;
      } catch (error) {
        console.error("Error fetching coverage areas:", error);
        return [];
      }
    },

    async fetchMetrics() {
      try {
        const dateRange = dateUtils.getCachedDateRange();
        const params = new URLSearchParams({
          start_date: dateRange.start,
          end_date: dateRange.end,
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

      const renderStage = window.loadingManager.startStage(
        "render",
        "Updating map...",
      );

      try {
        renderStage.update(20, "Fetching map data...");

        // Cancel any pending requests
        state.cancelAllRequests();

        const promises = [];

        if (state.mapLayers.trips.visible) {
          promises.push(this.fetchTrips());
        }

        if (state.mapLayers.matchedTrips.visible) {
          promises.push(this.fetchMatchedTrips());
        }

        if (
          state.mapLayers.undrivenStreets.visible &&
          !state.undrivenStreetsLoaded
        ) {
          promises.push(this.fetchUndrivenStreets());
        }

        renderStage.update(50, "Loading layer data...");

        await Promise.allSettled(promises);

        renderStage.update(80, "Rendering layers...");

        if (fitBounds) {
          await mapManager.fitBounds();
        }

        renderStage.complete();

        state.metrics.renderTime = Date.now() - state.metrics.loadStartTime;
        console.log("Render metrics:", state.metrics);
      } catch (error) {
        renderStage.error(error.message);
        console.error("Error updating map:", error);
        utils.showNotification("Error updating map data", "danger");
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
        utils.batchDOMUpdates([
          () =>
            Object.values(elements).forEach((el) => {
              if (el) el.textContent = el.id.includes("time") ? "--:--" : "0";
            }),
        ]);
        return;
      }

      const metrics = this.calculateMetrics(geojson.features);

      utils.batchDOMUpdates([
        () => {
          if (elements.totalTrips)
            elements.totalTrips.textContent = metrics.totalTrips;
          if (elements.totalDistance)
            elements.totalDistance.textContent =
              metrics.totalDistance.toFixed(1);
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
      ]);
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

  // Trip interactions with performance improvements
  const tripInteractions = {
    handleTripClick(e, feature) {
      if (!feature?.properties) return;

      e.originalEvent?.stopPropagation?.();

      const tripId =
        feature.properties.transactionId ||
        feature.properties.id ||
        feature.properties.tripId;

      if (tripId) {
        state.selectedTripId = tripId;
        mapManager.refreshTripStyles();
      }

      const popup = new mapboxgl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "400px",
        anchor: "bottom",
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
            <span>${formatNumber(props.averageSpeed || props.avgSpeed)} mph</span>
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
        props.source === "matched" ||
        props.mapMatchingStatus === "success" ||
        feature.source?.includes("matched");
      const tripId = props.transactionId || props.id || props.tripId;

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

        // Disable button to prevent double clicks
        button.disabled = true;
        button.classList.add("btn-loading");

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
        } finally {
          button.disabled = false;
          button.classList.remove("btn-loading");
        }
      });
    },

    async deleteMatchedTrip(tripId, popup) {
      if (
        !(await window.confirmationDialog.show({
          title: "Delete Matched Trip",
          message: "Are you sure you want to delete this matched trip?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        }))
      )
        return;

      try {
        const response = await utils.fetchWithRetry(
          `/api/matched_trips/${tripId}`,
          {
            method: "DELETE",
          },
        );

        if (response) {
          popup.remove();
          utils.showNotification(
            "Matched trip deleted successfully",
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Error deleting matched trip:", error);
        utils.showNotification(error.message, "danger");
      }
    },

    async deleteTrip(tripId, popup) {
      if (
        !(await window.confirmationDialog.show({
          title: "Delete Trip",
          message:
            "Are you sure you want to delete this trip? This action cannot be undone.",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        }))
      )
        return;

      try {
        const response = await utils.fetchWithRetry(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (response) {
          popup.remove();
          utils.showNotification("Trip deleted successfully", "success");
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Error deleting trip:", error);
        utils.showNotification(error.message, "danger");
      }
    },

    async rematchTrip(tripId, popup) {
      try {
        utils.showNotification("Starting map matching...", "info");

        const response = await utils.fetchWithRetry(
          `/api/process_trip/${tripId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ map_match: true }),
          },
        );

        if (response) {
          popup.remove();
          utils.showNotification("Trip map matching completed", "success");
          await dataManager.updateMap();
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
        window.loadingManager.show("Initializing application...");

        // Initialize date inputs
        this.initializeDates();

        // Check if we're on the map page
        if (
          utils.getElement("map") &&
          !document.getElementById("visits-page")
        ) {
          // Initialize map
          const mapInitialized = await mapManager.initialize();
          if (!mapInitialized) {
            throw new Error("Failed to initialize map");
          }

          // Initialize UI components
          layerManager.initializeControls();
          await this.initializeLocationDropdown();
          this.initializeLiveTracker();
          this.setupEventListeners();

          // Restore layer visibility
          this.restoreLayerVisibility();

          // Start loading data
          const mapStage = window.loadingManager.startStage(
            "map",
            "Loading map data...",
          );

          try {
            // Load initial data with progress tracking
            await Promise.all([
              dataManager.fetchTrips(),
              dataManager.fetchMetrics(),
            ]);

            mapStage.complete();

            // Zoom to last trip if available
            if (state.mapLayers.trips?.layer?.features?.length > 0) {
              requestAnimationFrame(() => mapManager.zoomToLastTrip());
            }

            document.dispatchEvent(new CustomEvent("initialDataLoaded"));
          } catch (error) {
            mapStage.error(error.message);
            throw error;
          }
        }

        document.dispatchEvent(new CustomEvent("appReady"));

        // Hide loading overlay after a short delay to ensure smooth transition
        setTimeout(() => {
          window.loadingManager.finish();
        }, 300);
      } catch (error) {
        console.error("Application initialization error:", error);
        window.loadingManager.error(`Initialization failed: ${error.message}`);
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

        const fragment = document.createDocumentFragment();
        areas.forEach((area) => {
          const option = document.createElement("option");
          option.value = area._id || area.id;
          option.textContent =
            area.location?.display_name ||
            area.location?.city ||
            area.name ||
            area.city ||
            "Unknown Location";
          fragment.appendChild(option);
        });

        dropdown.appendChild(fragment);

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
      const savedVisibility =
        storage.get(CONFIG.STORAGE_KEYS.layerVisibility) || {};

      Object.keys(state.mapLayers).forEach((layerName) => {
        const toggle = document.getElementById(`${layerName}-toggle`);

        if (layerName === "trips") {
          // Trips layer is always visible by default
          state.mapLayers[layerName].visible = true;
          if (toggle) toggle.checked = true;
        } else if (savedVisibility[layerName] !== undefined) {
          state.mapLayers[layerName].visible = savedVisibility[layerName];
          if (toggle) toggle.checked = savedVisibility[layerName];
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
            content.addEventListener(
              "transitionend",
              () => {
                const isCollapsed = !content.classList.contains("show");
                icon.className = isCollapsed
                  ? "fas fa-chevron-down"
                  : "fas fa-chevron-up";
              },
              { once: true },
            );
          }
        });
      }

      // Location dropdown
      const locationDropdown = utils.getElement("undriven-streets-location");
      if (locationDropdown) {
        locationDropdown.addEventListener("change", async (e) => {
          storage.set(CONFIG.STORAGE_KEYS.selectedLocation, e.target.value);
          if (e.target.value && state.mapLayers.undrivenStreets.visible) {
            state.undrivenStreetsLoaded = false;
            await dataManager.fetchUndrivenStreets();
          }
        });
      }

      // Center on location button
      const centerButton = utils.getElement("center-on-location");
      if (centerButton) {
        centerButton.addEventListener("click", () => {
          if (!navigator.geolocation) {
            utils.showNotification("Geolocation is not supported", "warning");
            return;
          }

          centerButton.disabled = true;
          centerButton.classList.add("btn-loading");

          navigator.geolocation.getCurrentPosition(
            (position) => {
              const { latitude, longitude } = position.coords;
              state.map.flyTo({
                center: [longitude, latitude],
                zoom: 14,
                duration: 1000,
              });
              centerButton.disabled = false;
              centerButton.classList.remove("btn-loading");
            },
            (error) => {
              console.error("Geolocation error:", error);
              utils.showNotification(
                `Error getting location: ${error.message}`,
                "danger",
              );
              centerButton.disabled = false;
              centerButton.classList.remove("btn-loading");
            },
          );
        });
      }

      // Listen for map style changes to re-apply layers
      document.addEventListener("mapStyleLoaded", async () => {
        if (!state.map || !state.mapInitialized) return;

        console.log("Map style reloaded, re-applying layers...");
        window.loadingManager.pulse("Applying new map style...");

        for (const [layerName, layerInfo] of Object.entries(state.mapLayers)) {
          if (layerInfo.visible && layerInfo.layer) {
            try {
              // Ensure source and layer are correctly re-added or updated
              // updateMapLayer will add if not present, or update data if present
              await layerManager.updateMapLayer(layerName, layerInfo.layer);

              // Explicitly set visibility again, as updateMapLayer might only set it on creation
              // or if the layer config is re-applied. Best to be sure.
              const layerId = `${layerName}-layer`;
              if (state.map.getLayer(layerId)) {
                state.map.setLayoutProperty(layerId, "visibility", "visible");
              } else {
                // If the layer somehow didn't get added by updateMapLayer, log an error
                console.warn(
                  `Layer ${layerId} not found after attempting to re-add.`,
                );
              }
            } catch (error) {
              console.error(
                `Error re-applying layer ${layerName} after style change:`,
                error,
              );
            }
          }
        }
        window.loadingManager.hide();
        console.log("Finished re-applying layers.");
      });

      // Refresh map button
      const refreshButton = utils.getElement("refresh-map");
      if (refreshButton) {
        refreshButton.addEventListener("click", async () => {
          refreshButton.disabled = true;
          refreshButton.classList.add("btn-loading");

          try {
            // Clear cache
            state.apiCache.clear();
            await dataManager.updateMap(false);
          } finally {
            refreshButton.disabled = false;
            refreshButton.classList.remove("btn-loading");
          }
        });
      }

      // Fit bounds button
      const fitBoundsButton = utils.getElement("fit-bounds");
      if (fitBoundsButton) {
        fitBoundsButton.addEventListener("click", () => {
          mapManager.fitBounds();
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
      document.addEventListener("filtersApplied", async () => {
        if (state.mapInitialized) {
          // Clear date range cache
          storage.set("cached_date_range", null);
          await dataManager.updateMap(true);
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
          f: () => mapManager.fitBounds(),
          r: () => document.getElementById("refresh-map")?.click(),
          l: () => document.getElementById("center-on-location")?.click(),
        };

        if (keyActions[e.key]) {
          keyActions[e.key]();
          e.preventDefault();
        } else if (
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight"
        ) {
          const panDistance = e.shiftKey ? 200 : 100;
          const panMap = {
            ArrowUp: [0, -panDistance],
            ArrowDown: [0, panDistance],
            ArrowLeft: [-panDistance, 0],
            ArrowRight: [panDistance, 0],
          };
          state.map.panBy(panMap[e.key]);
          e.preventDefault();
        }
      });

      // Performance monitoring
      if ("PerformanceObserver" in window) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === "measure") {
              console.log(
                `Performance: ${entry.name} - ${entry.duration.toFixed(2)}ms`,
              );
            }
          }
        });
        observer.observe({ entryTypes: ["measure"] });
      }

      // Cleanup on page visibility change
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          // Pause expensive operations when page is hidden
          state.mapSettings.autoRefresh = false;
        } else {
          // Resume when visible
          if (state.hasPendingRequests()) {
            utils.showNotification("Refreshing data...", "info", 2000);
            dataManager.updateMap(false);
          }
        }
      });

      // Cleanup on page unload
      window.addEventListener("beforeunload", () => {
        state.cancelAllRequests();

        // Save current layer visibility
        const visibility = {};
        Object.entries(state.mapLayers).forEach(([name, info]) => {
          visibility[name] = info.visible;
        });
        storage.set(CONFIG.STORAGE_KEYS.layerVisibility, visibility);
      });

      // Error boundary
      window.addEventListener("error", (e) => {
        console.error("Global error:", e.error);
        if (e.error?.message?.includes("WebGL")) {
          utils.showNotification(
            "WebGL error detected. Map may not render correctly.",
            "danger",
          );
        }
      });

      window.addEventListener("unhandledrejection", (e) => {
        console.error("Unhandled promise rejection:", e.reason);
        if (e.reason?.message?.includes("fetch")) {
          utils.showNotification(
            "Network error. Please check your connection.",
            "warning",
          );
        }
      });
    },

    // Public API methods
    async mapMatchTrips() {
      try {
        const confirmed = await window.confirmationDialog.show({
          title: "Map Match Trips",
          message:
            "This will process all trips in the selected date range. This may take several minutes for large date ranges. Continue?",
          confirmText: "Start Map Matching",
          confirmButtonClass: "btn-primary",
        });

        if (!confirmed) return;

        window.loadingManager.show("Starting map matching process...");

        const response = await utils.fetchWithRetry("/api/map_match_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_date: dateUtils.getStartDate(),
            end_date: dateUtils.getEndDate(),
          }),
        });

        if (response) {
          utils.showNotification(
            `Map matching completed: ${response.message}`,
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Map matching error:", error);
        utils.showNotification(
          `Map matching error: ${error.message}`,
          "danger",
        );
      } finally {
        window.loadingManager.hide();
      }
    },
  };

  // Initialize application
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => app.initialize());
  } else {
    // Small delay to ensure all scripts are loaded
    setTimeout(() => app.initialize(), 100);
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
    AppState: state,
    CONFIG,
    utils,
  };
})();
