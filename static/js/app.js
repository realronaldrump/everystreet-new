/* eslint-disable complexity */
/* global handleError , DateUtils, L, $ */
/* eslint-disable no-unused-vars */

"use strict";

if (window.L?.Path) {
  L.Path.prototype.options.clickTolerance = 8;
}

(function () {
  // Consolidated configuration
  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129],
      defaultZoom: 4,
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000,
      debounceDelay: 100,
      tileLayerUrls: {
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        streets: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      }
    },
    STORAGE_KEYS: {
      startDate: "startDate",
      endDate: "endDate",
      selectedLocation: "selectedLocation",
      sidebarState: "sidebarCollapsed",
    },
    ERROR_MESSAGES: {
      mapInitFailed: "Failed to initialize map. Please refresh the page.",
      fetchTripsFailed: "Error loading trips. Please try again.",
      locationValidationFailed: "Location not found. Please check your input.",
    },
  };

  const LAYER_DEFAULTS = {
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
  };

  // Simplified application state
  const AppState = {
    map: null,
    layerGroup: null,
    mapLayers: { ...LAYER_DEFAULTS },
    mapInitialized: false,
    mapSettings: { highlightRecentTrips: true },
    selectedTripId: null,
    baseLayer: null,
    geoJsonLayers: {},
    liveTracker: null,
    dom: new Map(), // Use Map for better performance
  };

  // Simple cache for API responses
  const apiCache = new Map();
  let undrivenStreetsLoaded = false;

  // Utility functions - consolidated and optimized
  const getElement = (selector) => {
    if (AppState.dom.has(selector)) return AppState.dom.get(selector);
    
    const normalizedSelector = selector.startsWith("#") || selector.includes(" ") || selector.startsWith(".") 
      ? selector : `#${selector}`;
    
    try {
      const element = document.querySelector(normalizedSelector);
      if (element) AppState.dom.set(selector, element);
      return element;
    } catch (e) {
      console.error(`Error finding element: ${normalizedSelector}`, e);
      return null;
    }
  };

  const showNotification = (message, type = "info") => {
    if (window.notificationManager?.show) {
      window.notificationManager.show(message, type);
      return true;
    }
    console.warn("Notification Manager not found. Message:", message);
    return false;
  };

  // Consolidated storage utilities
  const storage = {
    get: (key, defaultValue = null) => {
      try {
        const value = window.utils?.getStorage(key);
        return value !== null ? value : defaultValue;
      } catch (e) {
        console.warn(`Error reading from localStorage: ${e.message}`);
        return defaultValue;
      }
    },
    set: (key, value) => {
      try {
        window.utils?.setStorage(key, String(value));
        return true;
      } catch (e) {
        console.warn(`Error writing to localStorage: ${e.message}`);
        return false;
      }
    }
  };

  // Optimized event listener management
  const eventManager = {
    listeners: new WeakMap(),
    
    add(element, eventType, handler) {
      const el = typeof element === "string" ? getElement(element) : element;
      if (!el) return false;

      if (!this.listeners.has(el)) {
        this.listeners.set(el, new Map());
      }

      const key = `${eventType}_${handler.name || 'anonymous'}`;
      const elementListeners = this.listeners.get(el);
      
      if (elementListeners.has(key)) return false;

      const wrappedHandler = eventType === "click" 
        ? (e) => { if (e.button === 0) handler(e); }
        : handler;

      el.addEventListener(eventType, wrappedHandler);
      elementListeners.set(key, wrappedHandler);
      return true;
    },

    remove(element, eventType, handlerName) {
      const el = typeof element === "string" ? getElement(element) : element;
      if (!el || !this.listeners.has(el)) return false;

      const key = `${eventType}_${handlerName}`;
      const elementListeners = this.listeners.get(el);
      const handler = elementListeners.get(key);
      
      if (handler) {
        el.removeEventListener(eventType, handler);
        elementListeners.delete(key);
        return true;
      }
      return false;
    }
  };

  // Debounce utility
  const debounce = (func, wait) => {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  };

  // Cached fetch with improved error handling
  const cachedFetch = async (url, options = {}, cacheTime = 10000) => {
    const key = url + JSON.stringify(options);
    const now = Date.now();

    if (apiCache.has(key)) {
      const cached = apiCache.get(key);
      if (now - cached.timestamp < cacheTime) {
        return cached.data;
      }
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      const errorMsg = `API request failed for ${url} (Status: ${response.status})`;
      throw new Error(errorMsg);
    }
    
    const data = await response.json();
    apiCache.set(key, { data, timestamp: now });
    return data;
  };

  // Date utilities
  const getStartDate = () => storage.get(CONFIG.STORAGE_KEYS.startDate) || DateUtils.getCurrentDate();
  const getEndDate = () => storage.get(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

  // Optimized trip styling
  const getTripFeatureStyle = (feature, layerInfo) => {
    const { properties = {} } = feature;
    const { transactionId, startTime } = properties;
    
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const tripStartTime = new Date(startTime).getTime();
    const isRecent = AppState.mapSettings.highlightRecentTrips && 
                     !isNaN(tripStartTime) && 
                     tripStartTime > sixHoursAgo;
    const isSelected = transactionId === AppState.selectedTripId;
    
    const isMatchedPair = isSelected || 
      (AppState.selectedTripId && transactionId && 
       (AppState.selectedTripId.replace("MATCHED-", "") === transactionId ||
        transactionId.replace("MATCHED-", "") === AppState.selectedTripId));

    let color = layerInfo.color;
    let weight = layerInfo.weight || 2;
    let opacity = layerInfo.opacity;

    if (isSelected) {
      color = layerInfo.highlightColor || "#FFD700";
      weight = 3;
      opacity = 1;
    } else if (isMatchedPair) {
      color = "#03DAC6";
      weight = 2.5;
      opacity = 0.8;
    } else if (isRecent) {
      color = "#FFA500";
      weight = 2.5;
      opacity = 0.9;
    }

    return {
      color,
      weight,
      opacity,
      lineCap: "round",
      lineJoin: "round",
      className: isRecent ? "recent-trip" : "",
    };
  };

  // Optimized style refresh
  const refreshTripStyles = () => {
    if (!AppState.layerGroup) return;

    AppState.layerGroup.eachLayer((layer) => {
      if (layer.feature?.properties && typeof layer.setStyle === "function") {
        const isMatched = layer.feature.properties.isMatched ||
                         layer.feature.properties.transactionId?.startsWith("MATCHED-");
        const layerInfo = isMatched ? AppState.mapLayers.matchedTrips : AppState.mapLayers.trips;
        
        layer.setStyle(getTripFeatureStyle(layer.feature, layerInfo));
        
        if (layer.feature.properties.transactionId === AppState.selectedTripId) {
          layer.bringToFront();
        }
      }
    });
  };

  const debouncedUpdateMap = debounce(updateMap, CONFIG.MAP.debounceDelay);
  const debouncedUpdateUrlWithMapState = debounce(updateUrlWithMapState, 200);

  const isMapReady = () => AppState.map && AppState.mapInitialized && AppState.layerGroup;

  // Simplified map initialization
  async function initializeMap() {
    try {
      if (AppState.map) return true;

      const mapElement = getElement("map");
      if (!mapElement) {
        showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
        return false;
      }

      AppState.map = L.map("map", {
        preferCanvas: true,
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: false,
        attributionControl: false,
        minZoom: 2,
        maxZoom: CONFIG.MAP.maxZoom,
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 120,
        fadeAnimation: true,
        markerZoomAnimation: true,
        inertia: true,
        worldCopyJump: true,
      });

      window.map = AppState.map;

      const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
      const tileUrl = CONFIG.MAP.tileLayerUrls[theme] || CONFIG.MAP.tileLayerUrls.dark;

      AppState.baseLayer = L.tileLayer(tileUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        crossOrigin: true,
      }).addTo(AppState.map);

      L.control.zoom({ position: "topright" }).addTo(AppState.map);
      L.control.attribution({ position: "bottomright", prefix: "" }).addTo(AppState.map);

      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      // Setup basemaps
      const basemaps = Object.fromEntries(
        Object.entries(CONFIG.MAP.tileLayerUrls).map(([key, url]) => [
          key.charAt(0).toUpperCase() + key.slice(1),
          L.tileLayer(url, { maxZoom: CONFIG.MAP.maxZoom })
        ])
      );

      const defaultBasemap = theme === "light" ? "Light" : "Dark";
      if (basemaps[defaultBasemap]) {
        basemaps[defaultBasemap].addTo(AppState.map);
        AppState.baseLayer = basemaps[defaultBasemap];
      }

      L.control.layers(basemaps, null, { position: "topright", collapsed: true }).addTo(AppState.map);

      AppState.map.on("zoomend", debouncedUpdateUrlWithMapState);
      AppState.map.on("moveend", debouncedUpdateUrlWithMapState);
      AppState.map.on("click", handleMapClick);

      document.dispatchEvent(new CustomEvent("mapInitialized"));
      AppState.mapInitialized = true;
      
      return true;
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Map initialization");
      } else {
        console.error("Map initialization error:", error);
      }
      showNotification(`${CONFIG.ERROR_MESSAGES.mapInitFailed}: ${error.message}`, "danger");
      return false;
    }
  }

  function handleMapClick() {
    if (!AppState.map._popup || !AppState.map._popup.isOpen()) {
      if (AppState.selectedTripId) {
        AppState.selectedTripId = null;
        refreshTripStyles();
      }
    }
  }

  function updateUrlWithMapState() {
    if (!AppState.map || !window.history?.replaceState) return;

    try {
      const center = AppState.map.getCenter();
      const zoom = AppState.map.getZoom();
      
      const url = new URL(window.location.href);
      url.searchParams.set("zoom", zoom);
      url.searchParams.set("lat", center.lat.toFixed(5));
      url.searchParams.set("lng", center.lng.toFixed(5));

      window.history.replaceState({}, "", url.toString());
    } catch (error) {
      console.warn("Failed to update URL with map state:", error);
    }
  }

  function initializeLiveTracker() {
    if (!window.LiveTripTracker || !AppState.map || AppState.liveTracker) return;

    try {
      AppState.liveTracker = new window.LiveTripTracker(AppState.map);
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "LiveTripTracker Initialization");
      } else {
        console.error("LiveTripTracker Initialization error:", error);
      }
    }
  }

  // Consolidated layer control functions
  function initializeLayerControls() {
    const layerToggles = getElement("layer-toggles");
    if (!layerToggles) return;

    createLayerControlsUI(layerToggles);
    setupLayerEventListeners(layerToggles);
    updateLayerOrderUI();

    // Prevent map interaction
    [layerToggles, getElement("layer-order")].forEach(el => {
      if (el) {
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
      }
    });
  }

  function createLayerControlsUI(container) {
    const fragment = document.createDocumentFragment();

    Object.entries(AppState.mapLayers).forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className = "layer-control d-flex align-items-center mb-1 p-1 border rounded";
      div.dataset.layerName = name;

      const checkboxId = `${name}-toggle`;
      div.innerHTML = `
        <label class="custom-checkbox me-2">
          <input type="checkbox" id="${checkboxId}" ${info.visible ? "checked" : ""}>
          <span class="checkmark"></span>
        </label>
        <label for="${checkboxId}" class="me-auto" style="cursor: pointer;">${info.name || name}</label>
        ${!["customPlaces"].includes(name) ? `
          <input type="color" id="${name}-color" value="${info.color}" 
                 class="form-control form-control-sm layer-color-picker me-1" 
                 style="width: 30px;" title="Layer color for ${info.name || name}">
          <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" value="${info.opacity}"
                 class="form-range layer-opacity-slider" style="width: 60px;" 
                 title="Layer opacity for ${info.name || name}">
        ` : ''}
      `;

      fragment.appendChild(div);
    });

    container.innerHTML = "";
    container.appendChild(fragment);
  }

  function setupLayerEventListeners(container) {
    container.addEventListener("change", (e) => {
      if (e.target.matches('label.custom-checkbox input[type="checkbox"]')) {
        const layerName = e.target.id.replace("-toggle", "");
        toggleLayer(layerName, e.target.checked);
      }
    });

    container.addEventListener("input", (e) => {
      const layerName = e.target.closest(".layer-control")?.dataset.layerName;
      if (!layerName) return;

      if (e.target.matches('input[type="color"].layer-color-picker')) {
        changeLayerColor(layerName, e.target.value);
      } else if (e.target.matches('input[type="range"].layer-opacity-slider')) {
        changeLayerOpacity(layerName, parseFloat(e.target.value));
      }
    });
  }

  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;
    storage.set(`layer_visible_${name}`, visible);

    if (name === "customPlaces" && window.customPlaces) {
      window.customPlaces.toggleVisibility(visible);
    } else if (name === "undrivenStreets" && visible) {
      undrivenStreetsLoaded = false;
      lazyFetchUndrivenStreets();
    } else {
      debouncedUpdateMap();
    }

    updateLayerOrderUI();
    document.dispatchEvent(new CustomEvent("layerVisibilityChanged", {
      detail: { layer: name, visible }
    }));
  }

  function changeLayerColor(name, color) {
    if (AppState.mapLayers[name]) {
      AppState.mapLayers[name].color = color;
      debouncedUpdateMap();
    }
  }

  function changeLayerOpacity(name, opacity) {
    if (AppState.mapLayers[name]) {
      AppState.mapLayers[name].opacity = opacity;
      debouncedUpdateMap();
    }
  }

  function updateLayerOrderUI() {
    const layerOrderEl = getElement("layer-order");
    if (!layerOrderEl) return;

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && (info.layer || info === AppState.mapLayers.customPlaces))
      .sort(([, a], [, b]) => b.order - a.order);

    layerOrderEl.innerHTML = `
      <h4 class="h6 mb-1">Layer Order (Drag to Reorder)</h4>
      <ul id="layer-order-list" class="list-group layer-order-list">
        ${visibleLayers.map(([name, info]) => `
          <li class="list-group-item list-group-item-action list-group-item-dark p-1" 
              draggable="true" data-layer="${name}" style="cursor: grab;">
            ${info.name || name}
          </li>
        `).join('')}
      </ul>
    `;

    initializeDragAndDrop();
  }

  function initializeDragAndDrop() {
    const list = getElement("layer-order-list");
    if (!list) return;

    L.DomEvent.disableClickPropagation(list);
    let draggedItem = null;

    eventManager.add(list, "dragstart", (e) => {
      if (e.target.tagName === "LI" && e.target.draggable) {
        draggedItem = e.target;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", e.target.dataset.layer);
        }
        setTimeout(() => draggedItem?.classList.add("dragging"), 0);
      } else {
        e.preventDefault();
      }
    });

    eventManager.add(list, "dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      
      const target = e.target.closest("li");
      if (target && draggedItem && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        if (e.clientY > midpoint) {
          list.insertBefore(draggedItem, target.nextSibling);
        } else {
          list.insertBefore(draggedItem, target);
        }
      }
    });

    eventManager.add(list, "drop", (e) => e.preventDefault());

    eventManager.add(list, "dragend", () => {
      if (draggedItem) {
        draggedItem.classList.remove("dragging");
        draggedItem = null;
        updateLayerOrder();
      }
    });
  }

  function updateLayerOrder() {
    const list = getElement("layer-order-list");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("li"));
    const total = items.length;

    items.forEach((item, i) => {
      const layerName = item.dataset.layer;
      if (AppState.mapLayers[layerName]) {
        AppState.mapLayers[layerName].order = total - i;
      }
    });
    
    debouncedUpdateMap();
  }

  // Consolidated fetch functions with improved error handling
  async function fetchTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification("Invalid date range selected for fetching trips.", "warning");
      return;
    }

    const loadingManager = window.loadingManager || { 
      startOperation: () => {}, 
      updateOperation: () => {}, 
      finish: () => {} 
    };

    loadingManager.startOperation("FetchTrips", 100);

    try {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      loadingManager.updateOperation("FetchTrips", 10, "Fetching trips...");
      
      const response = await fetch(`/api/trips?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`HTTP error fetching trips: ${response.status} ${response.statusText}`);
      }

      let geojson = await response.json();
      if (!geojson || !Array.isArray(geojson.features)) {
        geojson = { type: "FeatureCollection", features: [] };
      }

      await Promise.all([
        updateTripsTable(geojson),
        updateMapWithTrips(geojson),
        fetchMatchedTrips().catch(err => console.error("Error fetching matched trips:", err))
      ]);

      loadingManager.updateOperation("FetchTrips", 80, "Rendering map...");
      await updateMap();

      document.dispatchEvent(new CustomEvent("tripsLoaded", {
        detail: { count: geojson.features.length }
      }));
      
      showNotification(`Loaded ${geojson.features.length} trips.`, "success");
      loadingManager.updateOperation("FetchTrips", 100, "Trips loaded!");
      
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Fetch Trips Main");
      } else {
        console.error("Error in fetchTrips:", error);
      }
      showNotification(CONFIG.ERROR_MESSAGES.fetchTripsFailed, "danger");
    } finally {
      loadingManager.finish("FetchTrips");
    }
  }

  function updateTripsTable(geojson) {
    if (!window.tripsTable || !$.fn.DataTable?.isDataTable("#tripsTable")) return;

    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    const formattedTrips = features.map(trip => {
      const props = trip.properties || {};
      return {
        transactionId: props.transactionId || "N/A",
        imei: props.imei || "N/A",
        startTime: props.startTime,
        endTime: props.endTime,
        startTimeFormatted: props.startTime ? DateUtils.formatForDisplay(props.startTime, {
          dateStyle: "short", timeStyle: "short"
        }) : "N/A",
        endTimeFormatted: props.endTime ? DateUtils.formatForDisplay(props.endTime, {
          dateStyle: "short", timeStyle: "short"
        }) : "N/A",
        duration: props.duration ? DateUtils.formatSecondsToHMS(props.duration) : "N/A",
        distance: typeof props.distance === "number" ? props.distance.toFixed(2) : "N/A",
        startOdometer: props.startOdometer ?? "N/A",
        endOdometer: props.endOdometer ?? "N/A",
        currentSpeed: typeof props.currentSpeed === "number" ? props.currentSpeed.toFixed(1) : "N/A",
        avgSpeed: typeof (props.avgSpeed ?? props.averageSpeed) === "number" ? 
          (props.avgSpeed ?? props.averageSpeed).toFixed(1) : "N/A",
        maxSpeed: typeof props.maxSpeed === "number" ? props.maxSpeed.toFixed(1) : "N/A",
        pointsRecorded: props.pointsRecorded ?? "N/A",
        totalIdlingTime: props.totalIdlingTime ? DateUtils.formatSecondsToHMS(props.totalIdlingTime) : "N/A",
        fuelConsumed: typeof props.fuelConsumed === "number" ? props.fuelConsumed.toFixed(2) : "N/A",
        lastUpdate: props.lastUpdate ? DateUtils.formatForDisplay(props.lastUpdate, {
          dateStyle: "medium", timeStyle: "short"
        }) : "N/A",
        destination: props.destination || "N/A",
        startLocation: props.startLocation || "N/A",
      };
    });

    try {
      window.tripsTable.clear().rows.add(formattedTrips).draw(false);
    } catch (error) {
      console.error("Error updating DataTable:", error);
      showNotification("Failed to update the trips table.", "danger");
    }
  }

  async function updateMapWithTrips(geojson) {
    AppState.mapLayers.trips.layer = Array.isArray(geojson?.features) 
      ? geojson 
      : { type: "FeatureCollection", features: [] };
  }

  async function updateMapWithUndrivenStreets(geojson) {
    AppState.mapLayers.undrivenStreets.layer = Array.isArray(geojson?.features)
      ? geojson 
      : { type: "FeatureCollection", features: [] };
  }

  function fetchMatchedTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    
    if (!startDate || !endDate) {
      return Promise.reject(new Error("Invalid date range for matched trips"));
    }

    const url = `/api/matched_trips?start_date=${startDate}&end_date=${endDate}`;
    return cachedFetch(url, {}, 60000)
      .then(data => {
        AppState.mapLayers.matchedTrips.layer = data && Array.isArray(data.features) 
          ? data 
          : { type: "FeatureCollection", features: [] };
        AppState.mapLayers.matchedTrips.visible = storage.get("layer_visible_matchedTrips") === "true";
      })
      .catch(error => {
        console.error("Error fetching matched trips:", error);
        AppState.mapLayers.matchedTrips.layer = { type: "FeatureCollection", features: [] };
        AppState.mapLayers.matchedTrips.visible = false;
        if (typeof handleError === "function") {
          handleError(error, "Fetch Matched Trips");
        }
        throw error;
      });
  }

  async function fetchUndrivenStreets() {
    const locationSelect = document.getElementById("undriven-streets-location");
    
    if (!locationSelect?.value) {
      if (AppState.mapLayers.undrivenStreets?.visible) {
        showNotification("Please select a location from the dropdown to show undriven streets.", "warning");
      }
      AppState.mapLayers.undrivenStreets.visible = false;
      AppState.mapLayers.undrivenStreets.layer = { type: "FeatureCollection", features: [] };
      await updateMap();
      return null;
    }

    try {
      const location = JSON.parse(locationSelect.value);
      if (!location?.display_name) {
        throw new Error("Invalid location data");
      }

      storage.set("selectedLocationForUndrivenStreets", location._id || location.display_name);
      showNotification(`Loading undriven streets for ${location.display_name}...`, "info");

      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(location),
      });

      if (!response.ok) {
        throw new Error(`Failed to load undriven streets (HTTP ${response.status})`);
      }

      const geojson = await response.json();
      if (!geojson?.type || !Array.isArray(geojson.features)) {
        throw new Error("Invalid GeoJSON structure received");
      }

      const message = geojson.features.length === 0 
        ? `No undriven streets found in ${location.display_name}`
        : `Loaded ${geojson.features.length} undriven street segments for ${location.display_name}`;
      
      showNotification(message, geojson.features.length === 0 ? "info" : "success");

      await updateMapWithUndrivenStreets(geojson);
      await updateMap();
      return geojson;
      
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      showNotification(`Failed to load undriven streets: ${error.message}`, "danger");
      
      AppState.mapLayers.undrivenStreets.visible = false;
      AppState.mapLayers.undrivenStreets.layer = { type: "FeatureCollection", features: [] };
      
      const toggle = document.getElementById("undrivenStreets-toggle");
      if (toggle) toggle.checked = false;
      
      await updateMap();
      return null;
    }
  }

  // Optimized map update function
  async function updateMap(fitBounds = false) {
    if (!isMapReady()) return;

    AppState.layerGroup.clearLayers();
    const tripLayers = new Map();

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([name, info]) => 
        info.visible && 
        ((info.layer && Array.isArray(info.layer.features) && info.layer.features.length > 0) ||
         (name === "customPlaces" && window.customPlaces?.isVisible()))
      )
      .sort(([, a], [, b]) => a.order - b.order);

    for (const [name, info] of visibleLayers) {
      try {
        if (name === "customPlaces" && window.customPlaces?.getLayerGroup()) {
          window.customPlaces.getLayerGroup().addTo(AppState.layerGroup);
        } else if (["trips", "matchedTrips"].includes(name)) {
          const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info),
            onEachFeature: (feature, layer) => {
              if (feature.properties?.transactionId) {
                tripLayers.set(feature.properties.transactionId, layer);
              }
              layer.on("click", (e) => handleTripClick(e, feature, layer));
              layer.on("popupopen", () => setupPopupEventListeners(layer, feature));
              layer.bindPopup(createTripPopupContent(feature), { autoPan: false });
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);

          // Add hit layer for easier clicking
          const hitLayer = L.geoJSON(info.layer, {
            style: { color: "#000000", opacity: 0, weight: 20, interactive: true },
            onEachFeature: (f, layer) => {
              layer.on("click", (e) => handleTripClick(e, f, layer));
              layer.bindPopup(createTripPopupContent(f), { autoPan: false });
            },
          });
          hitLayer.addTo(AppState.layerGroup);
          
        } else if (name === "undrivenStreets") {
          const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
            style: () => ({
              color: info.color,
              weight: 3,
              opacity: info.opacity,
              className: "undriven-street",
            }),
            onEachFeature: (feature, layer) => {
              if (feature.properties?.street_name) {
                const props = feature.properties;
                const streetName = props.street_name;
                const segmentLength = typeof props.segment_length === "number" 
                  ? props.segment_length.toFixed(2) : "Unknown";
                const streetType = props.highway || "street";
                layer.bindTooltip(
                  `<strong>${streetName}</strong><br>Type: ${streetType}<br>Length: ${segmentLength}m`,
                  { sticky: true }
                );
              }
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);
        }
      } catch (layerError) {
        console.error(`Error processing layer "${name}":`, layerError);
        if (typeof handleError === "function") {
          handleError(layerError, `Update Map - Layer ${name}`);
        }
      }
    }

    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      tripLayers.get(AppState.selectedTripId)?.bringToFront();
    }

    if (fitBounds) fitMapBounds();
    AppState.map.invalidateSize();
    document.dispatchEvent(new CustomEvent("mapUpdated"));
  }

  function handleTripClick(e, feature, layer) {
    if (e.originalEvent?.button !== 0) return;
    L.DomEvent.stopPropagation(e);
    
    const clickedTripId = feature.properties?.transactionId;
    if (!clickedTripId) return;

    AppState.selectedTripId = clickedTripId;
    refreshTripStyles();

    let visibleLayer = null;
    AppState.layerGroup.eachLayer((l) => {
      if (l.feature?.properties?.transactionId === clickedTripId && 
          l.options?.opacity > 0 && l.options?.weight > 0) {
        visibleLayer = l;
      }
    });

    const layerToOpenPopupOn = visibleLayer || layer;
    if (layerToOpenPopupOn?.openPopup) {
      layerToOpenPopupOn.openPopup(e.latlng);
    }
  }

  function createTripPopupContent(feature) {
    const props = feature.properties || {};
    
    const format = (value, formatter) => value != null ? formatter(value) : "N/A";
    const formatNum = (value, digits = 1) => format(value, (v) => parseFloat(v).toFixed(digits));
    const formatTime = (value) => format(value, (v) => 
      DateUtils.formatForDisplay(v, { dateStyle: "medium", timeStyle: "short" }));
    const formatDuration = (value) => format(value, (v) => DateUtils.formatSecondsToHMS(v));

    const detailsHtml = `
      <h4>Trip Details</h4>
      <table class="table table-sm table-borderless table-dark popup-data small mb-0">
        <tbody>
          <tr><th scope="row" class="fw-bold">Trip ID</th><td>${props.transactionId || "N/A"}</td></tr>
          <tr><th scope="row" class="fw-bold">IMEI</th><td>${props.imei || "N/A"}</td></tr>
          <tr><th scope="row" class="fw-bold">Start Time</th><td>${formatTime(props.startTime)}</td></tr>
          <tr><th scope="row" class="fw-bold">End Time</th><td>${formatTime(props.endTime)}</td></tr>
          <tr><th scope="row" class="fw-bold">Duration</th><td>${formatDuration(props.duration)}</td></tr>
          <tr><th scope="row" class="fw-bold">Distance</th><td>${formatNum(props.distance, 2)} mi</td></tr>
          <tr><th scope="row" class="fw-bold">Avg Speed</th><td>${formatNum(props.avgSpeed ?? props.averageSpeed)} mph</td></tr>
          <tr><th scope="row" class="fw-bold">Max Speed</th><td>${formatNum(props.maxSpeed)} mph</td></tr>
          <tr><th scope="row" class="fw-bold">Points Recorded</th><td>${props.pointsRecorded ?? "N/A"}</td></tr>
          <tr><th scope="row" class="fw-bold">Idling Time</th><td>${formatDuration(props.totalIdleDuration)}</td></tr>
          <tr><th scope="row" class="fw-bold">Fuel Consumed</th><td>${formatNum(props.fuelConsumed, 2)} gal</td></tr>
        </tbody>
      </table>
    `;

    return `
      <div class="popup-content trip-popup bg-dark text-light p-1 rounded">
        ${detailsHtml}
        <div class="popup-actions border-top border-secondary pt-1 mt-1">
          ${createActionButtons(feature)}
        </div>
      </div>
    `;
  }

  function createActionButtons(feature) {
    const tripId = feature.properties?.transactionId;
    if (!tripId) return "";

    const isMatched = Boolean(feature.properties.matchedTripId) ||
                     (typeof tripId === "string" && tripId.startsWith("MATCHED-"));

    return `
      <div class="trip-actions mt-2" data-trip-id="${tripId}">
        ${isMatched 
          ? `<button class="btn btn-sm btn-danger delete-matched-trip me-1">Delete Matched</button>
             <button class="btn btn-sm btn-warning rematch-trip">Re-match</button>`
          : `<button class="btn btn-sm btn-danger delete-trip">Delete Trip</button>`
        }
      </div>
    `;
  }

  function setupPopupEventListeners(layer, feature) {
    const popupEl = layer.getPopup()?.getElement();
    if (!popupEl) return;

    const handlePopupClick = async (e) => {
      const target = e.target.closest("button");
      if (!target) return;

      e.stopPropagation();
      L.DomEvent.stopPropagation(e);

      const tripId = target.closest(".trip-actions")?.dataset.tripId;
      if (!tripId) return;

      if (target.classList.contains("delete-matched-trip")) {
        e.preventDefault();
        await handleDeleteMatchedTrip(tripId, layer);
      } else if (target.classList.contains("delete-trip")) {
        e.preventDefault();
        await handleDeleteTrip(tripId, layer);
      } else if (target.classList.contains("rematch-trip")) {
        e.preventDefault();
        await handleRematchTrip(tripId, layer, feature);
      }
    };

    eventManager.add(popupEl, "mousedown", (e) => {
      if (e.button === 0) handlePopupClick(e);
    });

    layer.once("popupclose", () => {
      eventManager.remove(popupEl, "mousedown", "handlePopupClick");
    });
  }

  // Consolidated trip action handlers
  async function handleDeleteMatchedTrip(tripId, layer) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Matched Trip",
          message: `Are you sure you want to delete matched trip ${tripId}? The original trip will remain.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        })
      : confirm(`Are you sure you want to delete matched trip ${tripId}?`);

    if (!confirmed) return;

    const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
    loadingManager.startOperation("DeleteMatchedTrip", 100);
    
    try {
      const res = await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(`Failed to delete matched trip ${tripId}`);
      }

      layer.closePopup();
      await fetchTrips();
      showNotification(`Matched trip ${tripId} deleted successfully.`, "success");
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Deleting Matched Trip");
      } else {
        showNotification(`Error deleting matched trip: ${error.message}`, "danger");
      }
    } finally {
      loadingManager.finish("DeleteMatchedTrip");
    }
  }

  async function handleDeleteTrip(tripId, layer) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Original Trip",
          message: `Delete original trip ${tripId}? This will ALSO delete its corresponding matched trip, if one exists. This action cannot be undone.`,
          confirmText: "Delete Both",
          confirmButtonClass: "btn-danger",
        })
      : confirm(`Delete original trip ${tripId}? This will also delete its matched trip. Are you sure?`);

    if (!confirmed) return;

    const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
    loadingManager.startOperation("DeleteTrip", 100);
    
    try {
      const tripRes = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!tripRes.ok) {
        console.warn(`Failed to delete original trip ${tripId}`);
      }

      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      } catch (_) {
        console.warn(`Could not delete potential matched trip for ${tripId}`);
      }

      layer.closePopup();
      await fetchTrips();
      showNotification(`Trip ${tripId} (and its matched trip, if any) deleted.`, "success");
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Deleting Trip and Matched Trip");
      } else {
        showNotification(`Error deleting trip: ${error.message}`, "danger");
      }
    } finally {
      loadingManager.finish("DeleteTrip");
    }
  }

  async function handleRematchTrip(tripId, layer, feature) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Re-match Trip",
          message: `Re-match trip ${tripId}? This will delete the existing matched trip data and attempt to generate a new one based on the original trip points.`,
          confirmText: "Re-match",
          confirmButtonClass: "btn-warning",
        })
      : confirm(`Re-match trip ${tripId}? This deletes the current matched version.`);

    if (!confirmed) return;

    if (!feature.properties?.startTime || !feature.properties?.endTime) {
      showNotification("Cannot re-match: Trip is missing start or end time.", "warning");
      return;
    }

    const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
    loadingManager.startOperation("RematchTrip", 100);
    
    try {
      try {
        const deleteRes = await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
        if (!deleteRes.ok && deleteRes.status !== 404) {
          console.warn(`Failed to delete existing matched trip ${tripId} before re-match`);
        }
      } catch (deleteError) {
        console.warn("Error occurred while deleting existing matched trip:", deleteError);
      }

      const rematchRes = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip_id: tripId }),
      });

      if (!rematchRes.ok) {
        throw new Error(`Failed to re-match trip ${tripId}`);
      }

      const result = await rematchRes.json();
      layer.closePopup();
      await fetchTrips();
      showNotification(result.message || `Trip ${tripId} successfully re-matched.`, "success");
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Re-matching Trip");
      } else {
        showNotification(`Error re-matching trip: ${error.message}`, "danger");
      }
    } finally {
      loadingManager.finish("RematchTrip");
    }
  }

  function fitMapBounds() {
    if (!AppState.map) return;

    const bounds = L.latLngBounds();
    let validBoundsExist = false;

    Object.values(AppState.mapLayers).forEach((info) => {
      if (!info.visible || !info.layer) return;

      try {
        let layerBounds = null;
        if (typeof info.layer.getBounds === "function") {
          layerBounds = info.layer.getBounds();
        } else if (info.layer.type === "FeatureCollection" && info.layer.features?.length > 0) {
          layerBounds = L.geoJSON(info.layer).getBounds();
        } else if (info === AppState.mapLayers.customPlaces && window.customPlaces?.getBounds) {
          layerBounds = window.customPlaces.getBounds();
        }

        if (layerBounds?.isValid()) {
          bounds.extend(layerBounds);
          validBoundsExist = true;
        }
      } catch (_) {
        // Ignore errors for individual layers
      }
    });

    if (validBoundsExist) {
      AppState.map.fitBounds(bounds, { padding: [30, 30] });
    }
  }

  // Optimized API functions
  async function mapMatchTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification("Please select valid start and end dates before map matching.", "warning");
      return;
    }

    const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
    loadingManager.startOperation("MapMatching", 100);
    showNotification(`Starting map matching for trips between ${startDate} and ${endDate}...`, "info");

    try {
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        throw new Error(`Map matching failed (HTTP ${response.status})`);
      }

      const results = await response.json();
      showNotification(results.message || "Map matching process completed.", "success");
      await fetchTrips();

      document.dispatchEvent(new CustomEvent("mapMatchingCompleted", { detail: { results } }));
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Map Matching");
      } else {
        showNotification(`Map matching failed: ${err.message}`, "danger");
      }
    } finally {
      loadingManager.finish("MapMatching");
    }
  }

  async function fetchTripsInRange() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification("Select valid start and end dates before fetching.", "warning");
      return;
    }

    const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
    loadingManager.startOperation("FetchTripsRange", 100);
    showNotification(`Fetching raw trip data between ${startDate} and ${endDate}...`, "info");

    try {
      const response = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        throw new Error(`Fetching trips failed (HTTP ${response.status})`);
      }

      const data = await response.json();
      if (data.status === "success") {
        showNotification(data.message || "Successfully fetched raw trip data.", "success");
        await fetchTrips();
      } else {
        throw new Error(data.message || "An unknown error occurred while fetching trips.");
      }
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Fetching Trips in Range");
      } else {
        showNotification(`Error fetching trip data: ${err.message}`, "danger");
      }
    } finally {
      loadingManager.finish("FetchTripsRange");
    }
  }

  async function fetchMetrics() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    const imei = getElement("imei")?.value || "";

    if (!startDate || !endDate) return;

    try {
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      if (imei) params.append("imei", imei);

      const metrics = await cachedFetch(`/api/metrics?${params.toString()}`, {}, 30000);
      if (!metrics) throw new Error("Received no data for metrics.");

      const metricMap = {
        "total-trips": metrics.total_trips ?? "N/A",
        "total-distance": typeof metrics.total_distance === "number" 
          ? `${metrics.total_distance.toFixed(2)} mi` : "N/A",
        "avg-distance": typeof metrics.avg_distance === "number" 
          ? `${metrics.avg_distance.toFixed(2)} mi` : "N/A",
        "avg-start-time": metrics.avg_start_time ?? "N/A",
        "avg-driving-time": metrics.avg_driving_time ?? "N/A",
        "avg-speed": typeof metrics.avg_speed === "number" 
          ? `${metrics.avg_speed.toFixed(1)} mph` : "N/A",
        "max-speed": typeof metrics.max_speed === "number" 
          ? `${metrics.max_speed.toFixed(1)} mph` : "N/A",
      };

      Object.entries(metricMap).forEach(([id, value]) => {
        const el = getElement(id);
        if (el) el.textContent = value;
      });

      document.dispatchEvent(new CustomEvent("metricsUpdated", { detail: { metrics } }));
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Fetching Metrics");
      }
      showNotification(`Failed to load metrics: ${err.message}`, "warning");
    }
  }

  async function fetchCoverageAreas() {
    try {
      const data = await cachedFetch("/api/coverage_areas", {}, 300000);
      return data?.areas || [];
    } catch (error) {
      console.error("Error fetching coverage areas:", error);
      showNotification(`Failed to load coverage areas: ${error.message}`, "warning");
      if (typeof handleError === "function") {
        handleError(error, "Fetch Coverage Areas");
      }
      return [];
    }
  }

  async function populateLocationDropdown() {
    const dropdown = document.getElementById("undriven-streets-location");
    if (!dropdown) return;

    while (dropdown.options.length > 1) {
      dropdown.remove(1);
    }

    const coverageAreas = await fetchCoverageAreas();
    if (coverageAreas.length === 0) {
      const option = document.createElement("option");
      option.textContent = "No coverage areas defined";
      option.disabled = true;
      dropdown.appendChild(option);
      return;
    }

    coverageAreas.forEach((area) => {
      if (area.location?.display_name) {
        const option = document.createElement("option");
        option.value = JSON.stringify(area.location);
        option.textContent = area.location.display_name;
        dropdown.appendChild(option);
      }
    });

    // Restore previously selected location
    const savedLocationId = storage.get("selectedLocationForUndrivenStreets");
    if (savedLocationId) {
      for (let i = 0; i < dropdown.options.length; i++) {
        const value = dropdown.options[i].value;
        if (!value) continue;
        try {
          const optionLocation = JSON.parse(value);
          if (optionLocation && 
              (optionLocation._id === savedLocationId || 
               optionLocation.display_name === savedLocationId)) {
            dropdown.selectedIndex = i;
            if (storage.get("layer_visible_undrivenStreets") === "true") {
              AppState.mapLayers.undrivenStreets.visible = true;
              fetchUndrivenStreets();
            }
            break;
          }
        } catch (_) {
          console.warn("Error parsing JSON from location dropdown option value.");
        }
      }
    }
  }

  function initializeEventListeners() {
    // Controls toggle
    const controlsToggle = getElement("controls-toggle");
    const controlsContent = getElement("controls-content");
    
    if (controlsToggle && controlsContent) {
      const icon = controlsToggle.querySelector("i");
      const updateIcon = () => {
        if (!icon) return;
        if (controlsContent.classList.contains("show")) {
          icon.classList.remove("fa-chevron-down");
          icon.classList.add("fa-chevron-up");
        } else {
          icon.classList.remove("fa-chevron-up");
          icon.classList.add("fa-chevron-down");
        }
      };

      updateIcon();
      controlsContent.addEventListener("show.bs.collapse", updateIcon);
      controlsContent.addEventListener("hide.bs.collapse", updateIcon);
    }

    // Button listeners
    eventManager.add("map-match-trips", "click", mapMatchTrips);
    eventManager.add("fetch-trips-range", "click", fetchTripsInRange);

    // Checkbox listener
    eventManager.add("highlight-recent-trips", "change", function (event) {
      if (event.target.type === "checkbox") {
        AppState.mapSettings.highlightRecentTrips = event.target.checked;
        refreshTripStyles();
      }
    });

    // Dropdown listener
    const locationDropdown = document.getElementById("undriven-streets-location");
    if (locationDropdown) {
      locationDropdown.addEventListener("change", () => {
        if (AppState.mapLayers.undrivenStreets?.visible) {
          fetchUndrivenStreets();
        }
      });
    }

    // Custom event listener
    document.addEventListener("filtersApplied", async (e) => {
      const loadingManager = window.loadingManager || { startOperation: () => {}, finish: () => {} };
      loadingManager.startOperation("ApplyFilters");

      try {
        await Promise.all([fetchTrips(), fetchMetrics()]);
      } catch (error) {
        console.error("Error fetching data after filters applied:", error);
        window.notificationManager?.show("Error loading data for the selected date range.", "danger");
      } finally {
        loadingManager.finish("ApplyFilters");
      }
    });
  }

  function setInitialDates() {
    const today = DateUtils.getCurrentDate();
    if (!storage.get(CONFIG.STORAGE_KEYS.startDate)) {
      storage.set(CONFIG.STORAGE_KEYS.startDate, today);
    }
    if (!storage.get(CONFIG.STORAGE_KEYS.endDate)) {
      storage.set(CONFIG.STORAGE_KEYS.endDate, today);
    }
  }

  function initializeDatePickers() {
    const startDateInput = getElement("start-date");
    const endDateInput = getElement("end-date");

    if (!startDateInput || !endDateInput) return;

    const storedStartDate = storage.get(CONFIG.STORAGE_KEYS.startDate) || DateUtils.getCurrentDate();
    const storedEndDate = storage.get(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

    const config = {
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "M j, Y",
      static: false,
      appendTo: document.body,
      theme: document.documentElement.getAttribute("data-bs-theme") === "light" ? "light" : "dark",
      disableMobile: true,
      onChange(selectedDates, dateStr) {
        const input = this.input;
        const formattedDate = DateUtils.formatDate(dateStr);
        const isStartDate = input.id === "start-date";
        const key = isStartDate ? CONFIG.STORAGE_KEYS.startDate : CONFIG.STORAGE_KEYS.endDate;
        storage.set(key, formattedDate);
      },
    };

    if (DateUtils.initDatePicker) {
      DateUtils.initDatePicker(startDateInput, config);
      DateUtils.initDatePicker(endDateInput, config);
    } else if (window.flatpickr) {
      window.flatpickr(startDateInput, config);
      window.flatpickr(endDateInput, config);
    } else {
      startDateInput.value = storedStartDate;
      endDateInput.value = storedEndDate;
    }
  }

  function getOrCreateGeoJsonLayer(name, data, options) {
    if (!AppState.geoJsonLayers[name]) {
      AppState.geoJsonLayers[name] = L.geoJSON(data, options);
    } else {
      const layer = AppState.geoJsonLayers[name];
      layer.clearLayers();
      layer.addData(data);
      if (options) {
        layer.options = { ...L.GeoJSON.prototype.options, ...options };
        if (options.style) layer.setStyle(options.style);
        if (options.onEachFeature) {
          layer.eachLayer((featureLayer) => {
            options.onEachFeature(featureLayer.feature, featureLayer);
          });
        }
      }
    }
    return AppState.geoJsonLayers[name];
  }

  async function lazyFetchUndrivenStreets() {
    if (AppState.mapLayers.undrivenStreets?.visible && !undrivenStreetsLoaded) {
      undrivenStreetsLoaded = true;
      try {
        const data = await fetchUndrivenStreets();
        if (!data) undrivenStreetsLoaded = false;
        return data;
      } catch (error) {
        undrivenStreetsLoaded = false;
        return null;
      }
    } else if (undrivenStreetsLoaded && AppState.mapLayers.undrivenStreets?.layer) {
      return AppState.mapLayers.undrivenStreets.layer;
    }
    return null;
  }

  function zoomToLastTrip(targetZoom = 14, duration = 2) {
    if (!AppState.map || !AppState.mapLayers.trips?.layer?.features) return;

    const features = AppState.mapLayers.trips.layer.features;
    if (features.length === 0) return;

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

    if (!lastTripFeature) return;

    let lastCoord = null;
    const geomType = lastTripFeature.geometry?.type;
    const coords = lastTripFeature.geometry?.coordinates;

    if (geomType === "LineString" && Array.isArray(coords) && coords.length > 0) {
      lastCoord = coords[coords.length - 1];
    } else if (geomType === "Point" && Array.isArray(coords)) {
      lastCoord = coords;
    }

    if (Array.isArray(lastCoord) && lastCoord.length === 2 &&
        typeof lastCoord[0] === "number" && typeof lastCoord[1] === "number") {
      const targetLatLng = [lastCoord[1], lastCoord[0]];
      AppState.map.flyTo(targetLatLng, targetZoom, {
        animate: true,
        duration: duration,
        easeLinearity: 0.25,
      });
    }
  }

  // Main initialization function - simplified
  function initialize() {
    setInitialDates();
    initializeDatePickers();
    initializeEventListeners();

    if (getElement("map") && !document.getElementById("visits-page")) {
      initializeMap()
        .then((mapInitializedOk) => {
          if (!mapInitializedOk || !isMapReady()) {
            console.error("Map initialization failed.");
            showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
            return Promise.reject(new Error("Map initialization failed"));
          }

          initializeLayerControls();
          initializeLiveTracker();

          // Restore layer visibility state
          Object.keys(AppState.mapLayers).forEach((layerName) => {
            const savedVisibility = storage.get(`layer_visible_${layerName}`);
            const toggle = document.getElementById(`${layerName}-toggle`);

            if (savedVisibility !== null) {
              const isVisible = savedVisibility === "true";
              AppState.mapLayers[layerName].visible = isVisible;
              if (toggle) toggle.checked = isVisible;
            } else {
              if (toggle) toggle.checked = AppState.mapLayers[layerName].visible;
            }

            if (layerName === "undrivenStreets" && !AppState.mapLayers[layerName].visible) {
              AppState.mapLayers[layerName].layer = { type: "FeatureCollection", features: [] };
            }
          });
          
          updateLayerOrderUI();
          return populateLocationDropdown();
        })
        .then(() => Promise.all([fetchTrips(), fetchMetrics()]))
        .then(() => {
          if (AppState.mapLayers.trips?.layer?.features?.length > 0) {
            zoomToLastTrip();
          }
          document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        })
        .catch((error) => {
          console.error("Error during application initialization:", error);
          if (typeof handleError === "function") {
            handleError(error, "Application Initialization");
          } else {
            showNotification(`Initialization Error: ${error.message}`, "danger");
          }
        })
        .finally(() => {
          window.loadingManager?.finish("ApplyFilters");
        });
    }

    // Global exposure
    window.AppState = AppState;
    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.App = {
      fetchTrips,
      updateMap,
      refreshTripStyles,
      updateTripsTable,
      toggleLayer,
      fetchMetrics,
      initializeMap,
      getStartDate,
      getEndDate,
      fitMapBounds,
      mapMatchTrips,
      fetchTripsInRange,
      AppState,
      CONFIG,
    };

    document.dispatchEvent(new CustomEvent("appReady"));
  }

  // Event listeners
  document.addEventListener("DOMContentLoaded", initialize);

  window.addEventListener("beforeunload", () => {
    apiCache.clear();
  });

  // Keyboard navigation
  window.addEventListener("keydown", function (e) {
    if (!AppState.map) return;

    const activeElement = document.activeElement;
    const isInputFocused = activeElement && 
      (activeElement.tagName === "INPUT" || 
       activeElement.tagName === "TEXTAREA" || 
       activeElement.tagName === "SELECT");
    if (isInputFocused) return;

    const keyActions = {
      "+": () => AppState.map.zoomIn(),
      "=": () => AppState.map.zoomIn(),
      "-": () => AppState.map.zoomOut(),
      "_": () => AppState.map.zoomOut(),
      "ArrowUp": () => AppState.map.panBy([0, -100]),
      "ArrowDown": () => AppState.map.panBy([0, 100]),
      "ArrowLeft": () => AppState.map.panBy([-100, 0]),
      "ArrowRight": () => AppState.map.panBy([100, 0]),
    };

    if (keyActions[e.key]) {
      keyActions[e.key]();
    }
  });

  document.addEventListener("visibilitychange", () => {
    // Clean up resources when page becomes hidden
    if (document.hidden) {
      apiCache.clear();
    }
  });
})();
