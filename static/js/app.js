/* global mapboxgl, DateUtils */
"use strict";

(() => {
  // Consolidated configuration
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
      cacheTime: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      timeout: 120000,
      batchSize: 100,
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

  // Application state management
  class AppState {
    constructor() {
      this.map = null;
      this.mapInitialized = false;
      this.mapLayers = JSON.parse(JSON.stringify(CONFIG.LAYER_DEFAULTS));
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

  // Date utilities using global DateUtils
  const dateUtils = {
    getStartDate: () =>
      window.utils.getStorage(CONFIG.STORAGE_KEYS.startDate) ||
      DateUtils.getCurrentDate(),
    getEndDate: () =>
      window.utils.getStorage(CONFIG.STORAGE_KEYS.endDate) ||
      DateUtils.getCurrentDate(),

    formatTimeFromHours(hours) {
      return DateUtils.formatTimeFromHours(hours);
    },

    getCachedDateRange() {
      const cacheKey = "cached_date_range";
      const cached = window.utils.getStorage(cacheKey);
      const currentStart = this.getStartDate();
      const currentEnd = this.getEndDate();

      if (
        cached &&
        cached.start === currentStart &&
        cached.end === currentEnd
      ) {
        // Ensure startDate and endDate are Date objects when retrieved from cache
        return {
          ...cached,
          startDate: new Date(cached.start),
          endDate: new Date(cached.end),
        };
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

      window.utils.setStorage(cacheKey, range);
      return range;
    },
  };

  // Map manager
  const mapManager = {
    async initialize() {
      try {
        const initStage = window.loadingManager.startStage(
          "init",
          "Initializing map...",
        );

        const mapElement = window.utils.getElement("map");
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

        // Determine initial map view
        const urlParams = new URLSearchParams(window.location.search);
        const latParam = parseFloat(urlParams.get("lat"));
        const lngParam = parseFloat(urlParams.get("lng"));
        const zoomParam = parseFloat(urlParams.get("zoom"));
        const savedView = window.utils.getStorage("mapView");
        const center =
          !isNaN(latParam) && !isNaN(lngParam)
            ? [lngParam, latParam]
            : savedView?.center || CONFIG.MAP.defaultCenter;
        const zoom = !isNaN(zoomParam)
          ? zoomParam
          : savedView?.zoom || CONFIG.MAP.defaultZoom;

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
        const saveViewState = window.utils.debounce(() => {
          if (!state.map) return;
          const center = state.map.getCenter();
          const zoom = state.map.getZoom();
          window.utils.setStorage("mapView", {
            center: [center.lng, center.lat],
            zoom,
          });
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
        window.notificationManager.show(
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
      // This is a general click handler for the entire map.
      // Its primary job is to clear selections when clicking on an empty area.
      // The layer-specific click handlers are responsible for opening popups on features.

      // Query for features at the click point from our interactive layers.
      const features = state.map.queryRenderedFeatures(e.point, {
        layers: ["trips-layer", "matchedTrips-layer"],
      });

      // If no features are found under the click point, it means the user clicked on the map background.
      // In this case, we deselect any currently selected trip.
      if (features.length === 0) {
        if (state.selectedTripId) {
          state.selectedTripId = null;
          this.refreshTripStyles();
        }
      }
      // If features *are* found, we do nothing. The click is on a feature, and the
      // layer's own click handler will manage it. This prevents this general handler
      // from interfering and causing a loop.
    },

    refreshTripStyles: window.utils.throttle(function () {
      if (!state.map || !state.mapInitialized) return;

      ["trips", "matchedTrips"].forEach((layerName) => {
        const layerInfo = state.mapLayers[layerName];
        if (!layerInfo?.visible) return;

        const layerId = `${layerName}-layer`;
        if (state.map.getLayer(layerId)) {
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

      await window.utils.measurePerformance("fitBounds", async () => {
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
            duration: animate ? 1000 : 0,
          });
        }
      });
    },

    zoomToLastTrip(targetZoom = 14) {
      if (!state.map || !state.mapLayers.trips?.layer?.features) return;

      const features = state.mapLayers.trips.layer.features;

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

  // Layer manager
  const layerManager = {
    // Add cleanup tracking
    _layerCleanupMap: new Map(),

    initializeControls() {
      const container = window.utils.getElement("layer-toggles");
      if (!container) return;

      // Load saved layer settings
      const savedSettings =
        window.utils.getStorage(CONFIG.STORAGE_KEYS.layerSettings) || {};
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
        window.utils.debounce((e) => {
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

          this.saveLayerSettings();
        }, 200),
      );
    },

    async toggleLayer(name, visible) {
      const layerInfo = state.mapLayers[name];
      if (!layerInfo) return;

      layerInfo.visible = visible;

      const loadingEl = document.getElementById(`${name}-loading`);
      if (loadingEl) loadingEl.classList.remove("d-none");

      if (visible) {
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
      window.utils.setStorage(CONFIG.STORAGE_KEYS.layerSettings, settings);
    },

    updateLayerOrder() {
      const container = window.utils.getElement("layer-order-list");
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

      this.setupDragAndDrop(container);

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
      const container = window.utils.getElement("layer-order-list");
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

      this.saveLayerSettings();
    },

    async updateMapLayer(layerName, data) {
      if (!state.map || !state.mapInitialized || !data) return;

      const sourceId = `${layerName}-source`;
      const layerId = `${layerName}-layer`;
      const layerInfo = state.mapLayers[layerName];

      try {
        // Clean up existing layer and source completely
        if (state.map.getLayer(layerId)) {
          // Remove all event listeners first
          const events = ["click", "mouseenter", "mouseleave"];
          events.forEach((event) => {
            state.map.off(event, layerId);
          });
          state.map.removeLayer(layerId);
        }

        if (state.map.getSource(sourceId)) {
          state.map.removeSource(sourceId);
        }

        // Wait for next frame to ensure cleanup
        await new Promise((resolve) => requestAnimationFrame(resolve));

        // Add new source
        state.map.addSource(sourceId, {
          type: "geojson",
          data,
          tolerance: 0.5,
          buffer: 128,
          maxzoom: 14,
          generateId: true,
        });

        // Add new layer
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

        // Add event listeners with cleanup tracking
        if (layerName === "trips" || layerName === "matchedTrips") {
          const clickHandler = (e) => {
            // Stop the event from bubbling up to the map's general click handler.
            // This is a robust way to ensure that clicking on a feature
            // doesn't also trigger actions meant for clicking on the map background.
            e.originalEvent.stopPropagation();

            if (e.features?.length > 0) {
              tripInteractions.handleTripClick(e, e.features[0]);
            }
          };

          const mouseEnterHandler = () => {
            state.map.getCanvas().style.cursor = "pointer";
          };

          const mouseLeaveHandler = () => {
            state.map.getCanvas().style.cursor = "";
          };

          state.map.on("click", layerId, clickHandler);
          state.map.on("mouseenter", layerId, mouseEnterHandler);
          state.map.on("mouseleave", layerId, mouseLeaveHandler);

          // Store handlers for cleanup using a regular Map instead of WeakMap
          if (!this._layerCleanupMap) {
            this._layerCleanupMap = new Map();
          }
          this._layerCleanupMap.set(layerId, {
            click: clickHandler,
            mouseenter: mouseEnterHandler,
            mouseleave: mouseLeaveHandler,
          });
        }

        layerInfo.layer = data;
      } catch (error) {
        console.error(`Error updating ${layerName} layer:`, error);
        window.notificationManager.show(
          `Failed to update ${layerName} layer`,
          "warning",
        );
      }
    },

    // Update cleanup method to use regular Map
    cleanup() {
      if (!state.map) return;

      // Clean up all tracked layers
      if (this._layerCleanupMap) {
        for (const [layerId, handlers] of this._layerCleanupMap) {
          if (state.map.getLayer(layerId)) {
            // Remove event listeners
            Object.entries(handlers).forEach(([event, handler]) => {
              state.map.off(event, layerId, handler);
            });
            state.map.removeLayer(layerId);
          }

          const sourceId = layerId.replace("-layer", "-source");
          if (state.map.getSource(sourceId)) {
            state.map.removeSource(sourceId);
          }
        }

        this._layerCleanupMap.clear();
      }
    },
  };

  // Data manager
  const dataManager = {
    async fetchTrips() {
      if (!state.mapInitialized) return null;

      const dataStage = window.loadingManager.startStage(
        "data",
        "Loading trips...",
      );

      try {
        const dateRange = dateUtils.getCachedDateRange();
        const { startDate, endDate, start, end, days } = dateRange;
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const thresholdDays = 7;
        let fullCollection = { type: "FeatureCollection", features: [] };

        if (days <= thresholdDays) {
          const params = new URLSearchParams({
            start_date: start,
            end_date: end,
          });
          dataStage.update(30, `Loading ${days} days of trips...`);
          const data = await window.utils.fetchWithRetry(
            `/api/trips?${params}`,
          );
          if (data?.type === "FeatureCollection") {
            fullCollection = data;
          } else {
            dataStage.error("Invalid trip data received");
            return null;
          }
        } else {
          const segments = Math.ceil(days / thresholdDays);
          for (let i = 0; i < segments; i++) {
            const segStartDate = new Date(
              startDate.getTime() + i * thresholdDays * MS_PER_DAY,
            );
            const segEndDate = new Date(
              Math.min(
                segStartDate.getTime() + (thresholdDays - 1) * MS_PER_DAY,
                endDate.getTime(),
              ),
            );
            const segStart = segStartDate.toISOString().split("T")[0];
            const segEnd = segEndDate.toISOString().split("T")[0];
            const paramsChunk = new URLSearchParams({
              start_date: segStart,
              end_date: segEnd,
            });
            dataStage.update(
              30 + Math.floor(((i + 1) / segments) * 40),
              `Loading trips ${segStart} to ${segEnd}...`,
            );
            const chunk = await window.utils.fetchWithRetry(
              `/api/trips?${paramsChunk}`,
            );
            if (chunk?.type === "FeatureCollection") {
              fullCollection.features.push(...chunk.features);
              state.mapLayers.trips.layer = fullCollection;
              await layerManager.updateMapLayer("trips", fullCollection);
            }
          }
        }

        dataStage.update(
          75,
          `Processing ${fullCollection.features.length} trips...`,
        );
        metricsManager.updateTripsTable(fullCollection);
        await layerManager.updateMapLayer("trips", fullCollection);
        dataStage.complete();
        return fullCollection;
      } catch (error) {
        dataStage.error(error.message);
        console.error("Error fetching trips:", error);
        window.notificationManager.show("Failed to load trips", "danger");
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

        const data = await window.utils.fetchWithRetry(
          `/api/matched_trips?${params}`,
        );

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
      const selectedLocationId = window.utils.getStorage(
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
        const data = await window.utils.fetchWithRetry(
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
        const dateRange = dateUtils.getCachedDateRange();
        const params = new URLSearchParams({
          start_date: dateRange.start,
          end_date: dateRange.end,
        });

        const data = await window.utils.fetchWithRetry(
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
        window.notificationManager.show("Error updating map data", "danger");
      } finally {
        window.loadingManager.finish();
      }
    },
  };

  // Metrics manager
  const metricsManager = {
    updateTripsTable(geojson) {
      const elements = {
        totalTrips: window.utils.getElement("total-trips"),
        totalDistance: window.utils.getElement("total-distance"),
        avgDistance: window.utils.getElement("avg-distance"),
        avgStartTime: window.utils.getElement("avg-start-time"),
        avgDrivingTime: window.utils.getElement("avg-driving-time"),
        avgSpeed: window.utils.getElement("avg-speed"),
        maxSpeed: window.utils.getElement("max-speed"),
      };

      if (!geojson?.features) {
        window.utils.batchDOMUpdates([
          () =>
            Object.values(elements).forEach((el) => {
              if (el) el.textContent = el.id.includes("time") ? "--:--" : "0";
            }),
        ]);
        return;
      }

      const metrics = this.calculateMetrics(geojson.features);

      window.utils.batchDOMUpdates([
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

        if (props.distance && !isNaN(props.distance)) {
          metrics.totalDistance += parseFloat(props.distance);
          metrics.validDistanceCount++;
        }

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

        if (props.startTime) {
          const startTime = new Date(props.startTime);
          if (!isNaN(startTime.getTime())) {
            metrics.totalStartHours +=
              startTime.getHours() + startTime.getMinutes() / 60;
            metrics.validStartTimeCount++;
          }
        }

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
            ? this.formatDuration(
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

  // Trip interactions
  const tripInteractions = {
    handleTripClick(e, feature) {
      if (!feature?.properties) return;

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
            <span>${metricsManager.formatDuration(duration)}</span>
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

      if (!tripId) {
        console.warn("No trip ID found in feature:", feature);
        return "";
      }

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

      // Add event listener to the popup element
      popupElement.addEventListener("click", async (e) => {
        const button = e.target.closest("button");
        if (!button) return;

        const tripId = button.dataset.tripId;
        if (!tripId) {
          console.warn("No trip ID found on button:", button);
          return;
        }

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
          window.notificationManager.show("Error performing action", "danger");
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
        const response = await window.utils.fetchWithRetry(
          `/api/matched_trips/${tripId}`,
          {
            method: "DELETE",
          },
        );

        if (response) {
          popup.remove();
          window.notificationManager.show(
            "Matched trip deleted successfully",
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Error deleting matched trip:", error);
        window.notificationManager.show(error.message, "danger");
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
        const response = await window.utils.fetchWithRetry(
          `/api/trips/${tripId}`,
          {
            method: "DELETE",
          },
        );

        if (response) {
          popup.remove();
          window.notificationManager.show(
            "Trip deleted successfully",
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Error deleting trip:", error);
        window.notificationManager.show(error.message, "danger");
      }
    },

    async rematchTrip(tripId, popup) {
      try {
        window.notificationManager.show("Starting map matching...", "info");

        const response = await window.utils.fetchWithRetry(
          `/api/process_trip/${tripId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ map_match: true }),
          },
        );

        if (response) {
          popup.remove();
          window.notificationManager.show(
            "Trip map matching completed",
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Error remapping trip:", error);
        window.notificationManager.show(error.message, "danger");
      }
    },
  };

  // Main application controller
  const app = {
    async initialize() {
      try {
        window.loadingManager.show("Initializing application...");

        this.initializeDates();

        if (
          window.utils.getElement("map") &&
          !document.getElementById("visits-page")
        ) {
          const mapInitialized = await mapManager.initialize();
          if (!mapInitialized) {
            throw new Error("Failed to initialize map");
          }

          layerManager.initializeControls();
          await this.initializeLocationDropdown();
          this.initializeLiveTracker();
          this.setupEventListeners();

          this.restoreLayerVisibility();

          const mapStage = window.loadingManager.startStage(
            "map",
            "Loading map data...",
          );

          try {
            await Promise.all([
              dataManager.fetchTrips(),
              dataManager.fetchMetrics(),
            ]);

            mapStage.complete();

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

        setTimeout(() => {
          window.loadingManager.finish();
        }, 300);
      } catch (error) {
        console.error("Application initialization error:", error);
        window.loadingManager.error(`Initialization failed: ${error.message}`);
      }
    },

    initializeDates() {
      const startDateInput = window.utils.getElement("start-date");
      const endDateInput = window.utils.getElement("end-date");

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
      const dropdown = window.utils.getElement("undriven-streets-location");
      if (!dropdown) return;

      try {
        const response = await window.utils.fetchWithRetry(
          "/api/coverage_areas",
        );
        const areas = response.areas || [];

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

        const savedLocationId = window.utils.getStorage(
          CONFIG.STORAGE_KEYS.selectedLocation,
        );
        if (savedLocationId) {
          dropdown.value = savedLocationId;
        }
      } catch (error) {
        console.error("Error populating location dropdown:", error);
        window.notificationManager.show(
          "Failed to load coverage areas",
          "warning",
        );
      }
    },

    restoreLayerVisibility() {
      const savedVisibility =
        window.utils.getStorage(CONFIG.STORAGE_KEYS.layerVisibility) || {};

      Object.keys(state.mapLayers).forEach((layerName) => {
        const toggle = document.getElementById(`${layerName}-toggle`);

        if (layerName === "trips") {
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
      const controlsToggle = window.utils.getElement("controls-toggle");
      if (controlsToggle) {
        controlsToggle.addEventListener("click", () => {
          const content = window.utils.getElement("controls-content");
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
      const locationDropdown = window.utils.getElement(
        "undriven-streets-location",
      );
      if (locationDropdown) {
        locationDropdown.addEventListener("change", async (e) => {
          window.utils.setStorage(
            CONFIG.STORAGE_KEYS.selectedLocation,
            e.target.value,
          );
          if (e.target.value && state.mapLayers.undrivenStreets.visible) {
            state.undrivenStreetsLoaded = false;
            await dataManager.fetchUndrivenStreets();
          }
        });
      }

      // Center on location button
      const centerButton = window.utils.getElement("center-on-location");
      if (centerButton) {
        centerButton.addEventListener("click", () => {
          if (!navigator.geolocation) {
            window.notificationManager.show(
              "Geolocation is not supported",
              "warning",
            );
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
              window.notificationManager.show(
                `Error getting location: ${error.message}`,
                "danger",
              );
              centerButton.disabled = false;
              centerButton.classList.remove("btn-loading");
            },
          );
        });
      }

      // Map style changes
      document.addEventListener("mapStyleLoaded", async () => {
        if (!state.map || !state.mapInitialized) return;

        console.log("Map style reloaded, re-applying layers...");
        window.loadingManager.pulse("Applying new map style...");

        for (const [layerName, layerInfo] of Object.entries(state.mapLayers)) {
          if (layerInfo.visible && layerInfo.layer) {
            try {
              await layerManager.updateMapLayer(layerName, layerInfo.layer);

              const layerId = `${layerName}-layer`;
              if (state.map.getLayer(layerId)) {
                state.map.setLayoutProperty(layerId, "visibility", "visible");
              } else {
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
      const refreshButton = window.utils.getElement("refresh-map");
      if (refreshButton) {
        refreshButton.addEventListener("click", async () => {
          refreshButton.disabled = true;
          refreshButton.classList.add("btn-loading");

          try {
            state.apiCache.clear();
            await dataManager.updateMap(false);
          } finally {
            refreshButton.disabled = false;
            refreshButton.classList.remove("btn-loading");
          }
        });
      }

      // Fit bounds button
      const fitBoundsButton = window.utils.getElement("fit-bounds");
      if (fitBoundsButton) {
        fitBoundsButton.addEventListener("click", () => {
          mapManager.fitBounds();
        });
      }

      // Highlight recent trips toggle
      const highlightToggle = window.utils.getElement("highlight-recent-trips");
      if (highlightToggle) {
        highlightToggle.addEventListener("change", (e) => {
          state.mapSettings.highlightRecentTrips = e.target.checked;
          mapManager.refreshTripStyles();
        });
      }

      // Filter events
      document.addEventListener("filtersApplied", async () => {
        if (state.mapInitialized) {
          window.utils.setStorage("cached_date_range", null);
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
          state.mapSettings.autoRefresh = false;
        } else {
          if (state.hasPendingRequests()) {
            window.notificationManager.show("Refreshing data...", "info", 2000);
            dataManager.updateMap(false);
          }
        }
      });

      // Cleanup on page unload
      window.addEventListener("beforeunload", () => {
        state.cancelAllRequests();

        const visibility = {};
        Object.entries(state.mapLayers).forEach(([name, info]) => {
          visibility[name] = info.visible;
        });
        window.utils.setStorage(
          CONFIG.STORAGE_KEYS.layerVisibility,
          visibility,
        );
        layerManager.cleanup();
      });

      // Error boundary
      window.addEventListener("error", (e) => {
        console.error("Global error:", e.error);
        if (e.error?.message?.includes("WebGL")) {
          window.notificationManager.show(
            "WebGL error detected. Map may not render correctly.",
            "danger",
          );
        }
      });

      window.addEventListener("unhandledrejection", (e) => {
        console.error("Unhandled promise rejection:", e.reason);
        if (e.reason?.message?.includes("fetch")) {
          window.notificationManager.show(
            "Network error. Please check your connection.",
            "warning",
          );
        }
      });
    },

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

        const response = await window.utils.fetchWithRetry(
          "/api/map_match_trips",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start_date: dateUtils.getStartDate(),
              end_date: dateUtils.getEndDate(),
            }),
          },
        );

        if (response) {
          window.notificationManager.show(
            `Map matching completed: ${response.message}`,
            "success",
          );
          await dataManager.updateMap();
        }
      } catch (error) {
        console.error("Map matching error:", error);
        window.notificationManager.show(
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
    utils: window.utils,
  };
})();
