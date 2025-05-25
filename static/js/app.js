/* eslint-disable complexity */
/* global handleError , DateUtils, mapboxgl, $ */
/* eslint-disable no-unused-vars */

"use strict";

(function () {
  // Consolidated configuration
  const CONFIG = {
    MAP: {
      defaultCenter: [-95.7129, 37.0902], // Note: Mapbox uses [lng, lat]
      defaultZoom: 4,
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000,
      debounceDelay: 100,
      styles: {
        dark: "mapbox://styles/mapbox/dark-v11",
        light: "mapbox://styles/mapbox/light-v11",
        satellite: "mapbox://styles/mapbox/satellite-v9",
        streets: "mapbox://styles/mapbox/streets-v12",
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
    mapInitialized: false,
    mapLayers: { ...LAYER_DEFAULTS },
    mapSettings: { highlightRecentTrips: true },
    selectedTripId: null,
    liveTracker: null,
    dom: new Map(), // Use Map for better performance
    mapboxSources: new Map(), // Track Mapbox sources
    mapboxLayers: new Map(), // Track Mapbox layers
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
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    apiCache.set(key, { data, timestamp: now });
    return data;
  };

  // Mapbox-specific utility functions
  const mapboxUtils = {
    convertGeoJSONToMapboxFeatures(geojson) {
      if (!geojson || !geojson.features) return [];
      return geojson.features.map(feature => ({
        ...feature,
        id: feature.properties?.id || feature.properties?.tripId || Math.random().toString(36)
      }));
    },

    createLayerStyle(layerInfo, layerType = 'line') {
      const baseStyle = {
        'line-color': layerInfo.color,
        'line-opacity': layerInfo.opacity,
        'line-width': layerInfo.weight || 2,
      };

      if (layerType === 'circle') {
        return {
          'circle-color': layerInfo.color,
          'circle-opacity': layerInfo.opacity,
          'circle-radius': layerInfo.weight || 4,
        };
      }

      return baseStyle;
    },

    addOrUpdateSource(map, sourceId, data) {
      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(data);
      } else {
        map.addSource(sourceId, {
          type: 'geojson',
          data: data
        });
      }
    },

    addOrUpdateLayer(map, layerId, sourceId, layerInfo, layerType = 'line') {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }

      const style = this.createLayerStyle(layerInfo, layerType);
      
      map.addLayer({
        id: layerId,
        type: layerType,
        source: sourceId,
        layout: {
          'visibility': layerInfo.visible ? 'visible' : 'none'
        },
        paint: style
      });
    }
  };

  // Debounced versions of functions
  const debouncedUpdateUrlWithMapState = debounce(updateUrlWithMapState, CONFIG.MAP.debounceDelay);

  // Date utilities
  const getStartDate = () => storage.get(CONFIG.STORAGE_KEYS.startDate) || DateUtils.getCurrentDate();
  const getEndDate = () => storage.get(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

  // Trip styling functions for Mapbox
  const getTripFeatureStyle = (feature, layerInfo) => {
    const isRecent = AppState.mapSettings.highlightRecentTrips && 
      feature.properties?.endTime && 
      (Date.now() - new Date(feature.properties.endTime).getTime()) < CONFIG.MAP.recentTripThreshold;

    const isSelected = AppState.selectedTripId && 
      (feature.properties?.id === AppState.selectedTripId || 
       feature.properties?.tripId === AppState.selectedTripId);

    if (isSelected) {
      return {
        color: layerInfo.highlightColor || "#FFD700",
        opacity: 1,
        weight: (layerInfo.weight || 2) + 2,
      };
    }

    if (isRecent) {
    return {
        color: layerInfo.highlightColor || "#FFD700",
        opacity: Math.min(layerInfo.opacity + 0.3, 1),
        weight: (layerInfo.weight || 2) + 1,
      };
    }

    return {
      color: layerInfo.color,
      opacity: layerInfo.opacity,
      weight: layerInfo.weight || 2,
    };
  };

  const refreshTripStyles = () => {
    if (!AppState.map || !AppState.mapInitialized) return;

    ['trips', 'matchedTrips'].forEach(layerName => {
      const layerInfo = AppState.mapLayers[layerName];
      if (!layerInfo || !layerInfo.visible) return;

      const mapboxLayerId = `${layerName}-layer`;
      if (AppState.map.getLayer(mapboxLayerId)) {
        // Update layer styles based on current state
        const style = mapboxUtils.createLayerStyle(layerInfo);
        Object.entries(style).forEach(([property, value]) => {
          AppState.map.setPaintProperty(mapboxLayerId, property, value);
        });
      }
    });
  };

  const isMapReady = () => AppState.map && AppState.mapInitialized;

  // Map initialization with Mapbox GL JS
  async function initializeMap() {
    try {
      if (AppState.map) return true;

      const mapElement = getElement("map");
      if (!mapElement) {
        showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
        return false;
      }

      // Check for Mapbox access token
      if (!window.MAPBOX_ACCESS_TOKEN) {
        showNotification("Mapbox access token not configured", "danger");
        return false;
      }

      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

      // Disable telemetry to prevent 500 errors on events API
      try {
        // Block telemetry at source
        if (mapboxgl.Map && mapboxgl.Map.prototype) {
          const originalAddEventData = mapboxgl.Map.prototype._addEventData;
          if (originalAddEventData) {
            mapboxgl.Map.prototype._addEventData = function() {};
          }
        }
        
        // Disable prewarm which can trigger events
        if (typeof mapboxgl.prewarm === 'function') {
          mapboxgl.prewarm = function() {};
        }
      } catch (e) {
        console.warn("Could not fully disable Mapbox telemetry:", e);
      }

      const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
      const mapStyle = CONFIG.MAP.styles[theme] || CONFIG.MAP.styles.dark;

      AppState.map = new mapboxgl.Map({
        container: "map",
        style: mapStyle,
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        maxZoom: CONFIG.MAP.maxZoom,
        attributionControl: false,
        logoPosition: 'bottom-right',
        collectResourceTiming: false, // Disable resource timing collection
        transformRequest: (url, resourceType) => {
          // Block all telemetry and events API calls to prevent 500 errors
          if (typeof url === 'string' && (
            url.includes('events.mapbox.com') || 
            url.includes('/events/v2') || 
            url.includes('telemetry') ||
            url.includes('/ping') ||
            url.includes('api.mapbox.com/events') ||
            url.includes('cloudfront.net/events')
          )) {
            console.log('Blocked telemetry request:', url);
            return null; // Return null to block the request
          }
          return { url };
        }
      });

      window.map = AppState.map;

      // Add controls
      AppState.map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      AppState.map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

      // Setup event handlers
      AppState.map.on('moveend', debouncedUpdateUrlWithMapState);
      AppState.map.on('zoomend', debouncedUpdateUrlWithMapState);
      AppState.map.on('click', handleMapClick);

      // Wait for map to load
      await new Promise((resolve) => {
        AppState.map.on('load', resolve);
      });

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

  function handleMapClick(e) {
    // Check if clicking on a feature
    const features = AppState.map.queryRenderedFeatures(e.point);
    
    if (features.length === 0) {
      // Clicked on empty area, deselect trip
      if (AppState.selectedTripId) {
        AppState.selectedTripId = null;
        refreshTripStyles();
      }
    } else {
      // Handle feature click
      const tripFeature = features.find(f => 
        f.source && (f.source.includes('trips') || f.source.includes('matched'))
      );
      
      if (tripFeature) {
        handleTripClick(e, tripFeature);
      }
    }
  }

  function updateUrlWithMapState() {
    if (!AppState.map || !window.history?.replaceState) return;

    try {
      const center = AppState.map.getCenter();
      const zoom = AppState.map.getZoom();
      
      const url = new URL(window.location.href);
      url.searchParams.set("zoom", zoom.toFixed(2));
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

  // Layer control functions adapted for Mapbox
  function initializeLayerControls() {
    const layerToggles = getElement("layer-toggles");
    if (!layerToggles) return;

    createLayerControlsUI(layerToggles);
    setupLayerEventListeners(layerToggles);
    updateLayerOrderUI();
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
      // Update Mapbox layer visibility
      const mapboxLayerId = `${name}-layer`;
      if (AppState.map && AppState.map.getLayer(mapboxLayerId)) {
        AppState.map.setLayoutProperty(mapboxLayerId, 'visibility', visible ? 'visible' : 'none');
      }
    }

    updateMap();
  }

  function changeLayerColor(name, color) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.color = color;
    
    // Update Mapbox layer color
    const mapboxLayerId = `${name}-layer`;
    if (AppState.map && AppState.map.getLayer(mapboxLayerId)) {
      AppState.map.setPaintProperty(mapboxLayerId, 'line-color', color);
    }
  }

  function changeLayerOpacity(name, opacity) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.opacity = opacity;
    
    // Update Mapbox layer opacity
    const mapboxLayerId = `${name}-layer`;
    if (AppState.map && AppState.map.getLayer(mapboxLayerId)) {
      AppState.map.setPaintProperty(mapboxLayerId, 'line-opacity', opacity);
    }
  }

  function updateLayerOrderUI() {
    const orderContainer = getElement("layer-order-list");
    if (!orderContainer) return;

    const sortedLayers = Object.entries(AppState.mapLayers)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

    orderContainer.innerHTML = "";
    const fragment = document.createDocumentFragment();

    sortedLayers.forEach(([name, info]) => {
      const li = document.createElement("li");
      li.className = "list-group-item d-flex justify-content-between align-items-center";
      li.dataset.layerName = name;
      li.innerHTML = `
        <span>${info.name || name}</span>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-secondary move-up" title="Move Up">
            <i class="fas fa-arrow-up"></i>
          </button>
          <button class="btn btn-outline-secondary move-down" title="Move Down">
            <i class="fas fa-arrow-down"></i>
          </button>
        </div>
      `;
      fragment.appendChild(li);
    });

    orderContainer.appendChild(fragment);
    initializeDragAndDrop();
  }

  function initializeDragAndDrop() {
    const orderContainer = getElement("layer-order-list");
    if (!orderContainer) return;

    orderContainer.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (!button) return;

      const li = button.closest("li");
      const layerName = li?.dataset.layerName;
      if (!layerName) return;

      if (button.classList.contains("move-up")) {
        const prev = li.previousElementSibling;
        if (prev) {
          orderContainer.insertBefore(li, prev);
          updateLayerOrder();
        }
      } else if (button.classList.contains("move-down")) {
        const next = li.nextElementSibling;
        if (next) {
          orderContainer.insertBefore(next, li);
          updateLayerOrder();
        }
      }
    });
  }

  function updateLayerOrder() {
    const orderContainer = getElement("layer-order-list");
    if (!orderContainer) return;

    const items = Array.from(orderContainer.children);
    items.forEach((item, index) => {
      const layerName = item.dataset.layerName;
      if (AppState.mapLayers[layerName]) {
        AppState.mapLayers[layerName].order = index;
      }
    });

    // Re-order layers in Mapbox map
    if (AppState.map && AppState.mapInitialized) {
      const sortedLayers = Object.entries(AppState.mapLayers)
        .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));

      let beforeLayer = null;
      sortedLayers.reverse().forEach(([name]) => {
        const mapboxLayerId = `${name}-layer`;
        if (AppState.map.getLayer(mapboxLayerId)) {
          if (beforeLayer) {
            AppState.map.moveLayer(mapboxLayerId, beforeLayer);
          }
          beforeLayer = mapboxLayerId;
        }
      });
    }
  }

  // Continue with rest of functions...
  async function fetchTrips() {
    if (!isMapReady()) return null;

    try {
      const startDate = getStartDate();
      const endDate = getEndDate();
      
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        format: "geojson",
      });

      const data = await cachedFetch(`/api/trips?${params}`);
      
      if (data?.type === "FeatureCollection") {
        AppState.mapLayers.trips.layer = data;
        updateTripsTable(data);
        return data;
      }
      
      return null;
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Fetch Trips");
      } else {
        console.error("Error fetching trips:", error);
      }
      showNotification(CONFIG.ERROR_MESSAGES.fetchTripsFailed, "danger");
      return null;
    }
  }

  function updateTripsTable(geojson) {
    // Update trips count and metrics display
    const totalTripsElement = getElement("total-trips");
    const totalDistanceElement = getElement("total-distance");
    const avgDistanceElement = getElement("avg-distance");
    const avgStartTimeElement = getElement("avg-start-time");
    const avgDrivingTimeElement = getElement("avg-driving-time");
    const avgSpeedElement = getElement("avg-speed");
    const maxSpeedElement = getElement("max-speed");

    if (!geojson?.features) {
      [totalTripsElement, totalDistanceElement, avgDistanceElement, 
       avgStartTimeElement, avgDrivingTimeElement, avgSpeedElement, 
       maxSpeedElement].forEach(el => {
        if (el) el.textContent = "0";
      });
      return;
    }

    const features = geojson.features;
    const totalTrips = features.length;
    
    let totalDistance = 0;
    let totalDrivingTime = 0;
    let totalStartHours = 0;
    let maxSpeed = 0;
    let validDistanceCount = 0;
    let validDrivingTimeCount = 0;
    let validStartTimeCount = 0;

    features.forEach(feature => {
      const props = feature.properties || {};
      
      if (props.distance && !isNaN(props.distance)) {
        totalDistance += parseFloat(props.distance);
        validDistanceCount++;
      }
      
      let drivingTime = props.duration || props.drivingTime;
      
      // Calculate duration if not provided (for matched trips)
      if (!drivingTime && props.startTime && props.endTime) {
        try {
          const startTime = new Date(props.startTime);
          const endTime = new Date(props.endTime);
          if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
            drivingTime = (endTime - startTime) / 1000; // Convert to seconds
          }
        } catch (e) {
          // Ignore calculation errors
        }
      }
      
      if (drivingTime && !isNaN(drivingTime)) {
        totalDrivingTime += parseFloat(drivingTime);
        validDrivingTimeCount++;
      }
      
      if (props.startTime) {
        const startTime = new Date(props.startTime);
        if (!isNaN(startTime.getTime())) {
          totalStartHours += startTime.getHours() + startTime.getMinutes() / 60;
          validStartTimeCount++;
        }
      }
      
      if (props.maxSpeed && !isNaN(props.maxSpeed)) {
        maxSpeed = Math.max(maxSpeed, parseFloat(props.maxSpeed));
      }
    });

    // Update display elements
    if (totalTripsElement) totalTripsElement.textContent = totalTrips.toString();
    if (totalDistanceElement) totalDistanceElement.textContent = totalDistance.toFixed(1);
    if (avgDistanceElement) avgDistanceElement.textContent = 
      validDistanceCount > 0 ? (totalDistance / validDistanceCount).toFixed(1) : "0";
    if (avgStartTimeElement) avgStartTimeElement.textContent = 
      validStartTimeCount > 0 ? 
        DateUtils.formatTimeFromHours(totalStartHours / validStartTimeCount) : "--:--";
    if (avgDrivingTimeElement) avgDrivingTimeElement.textContent = 
      validDrivingTimeCount > 0 ? 
        DateUtils.formatSecondsToHMS(totalDrivingTime / validDrivingTimeCount) : "--:--";
    if (avgSpeedElement) avgSpeedElement.textContent = 
      validDrivingTimeCount > 0 && totalDistance > 0 ? 
        ((totalDistance / (totalDrivingTime / validDrivingTimeCount)) * 3600 / 5280).toFixed(1) : "0";
    if (maxSpeedElement) maxSpeedElement.textContent = maxSpeed.toFixed(0);
  }

  // Mapbox-specific layer update functions
  async function updateMapWithTrips(geojson) {
    if (!AppState.map || !AppState.mapInitialized || !geojson) return;

    const sourceId = 'trips-source';
    const layerId = 'trips-layer';
    const layerInfo = AppState.mapLayers.trips;

    try {
      mapboxUtils.addOrUpdateSource(AppState.map, sourceId, geojson);
      
      if (!AppState.map.getLayer(layerId)) {
        mapboxUtils.addOrUpdateLayer(AppState.map, layerId, sourceId, layerInfo);
        
        // Add click handler
        AppState.map.on('click', layerId, (e) => {
          handleTripClick(e, e.features[0]);
        });
        
        // Add hover effects
        AppState.map.on('mouseenter', layerId, () => {
          AppState.map.getCanvas().style.cursor = 'pointer';
        });
        
        AppState.map.on('mouseleave', layerId, () => {
          AppState.map.getCanvas().style.cursor = '';
        });
      }
    } catch (error) {
      console.error("Error updating trips layer:", error);
    }
  }

  async function updateMapWithUndrivenStreets(geojson) {
    if (!AppState.map || !AppState.mapInitialized || !geojson) return;

    const sourceId = 'undriven-streets-source';
    const layerId = 'undrivenStreets-layer';
    const layerInfo = AppState.mapLayers.undrivenStreets;

    try {
      mapboxUtils.addOrUpdateSource(AppState.map, sourceId, geojson);
      
      if (!AppState.map.getLayer(layerId)) {
        mapboxUtils.addOrUpdateLayer(AppState.map, layerId, sourceId, layerInfo);
        
        // Add specific styling for undriven streets
        AppState.map.setPaintProperty(layerId, 'line-dasharray', [2, 2]);
      }
    } catch (error) {
      console.error("Error updating undriven streets layer:", error);
    }
  }

  async function fetchMatchedTrips() {
    if (!isMapReady()) return null;

    try {
    const startDate = getStartDate();
    const endDate = getEndDate();
    
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
        format: "geojson",
      });

      const data = await cachedFetch(`/api/matched_trips?${params}`);
      
      if (data?.type === "FeatureCollection") {
        AppState.mapLayers.matchedTrips.layer = data;
        
        // Add to map if visible
        if (AppState.mapLayers.matchedTrips.visible) {
          const sourceId = 'matched-trips-source';
          const layerId = 'matchedTrips-layer';
          const layerInfo = AppState.mapLayers.matchedTrips;

          mapboxUtils.addOrUpdateSource(AppState.map, sourceId, data);
          
          if (!AppState.map.getLayer(layerId)) {
            mapboxUtils.addOrUpdateLayer(AppState.map, layerId, sourceId, layerInfo);
            
            // Add click handler
            AppState.map.on('click', layerId, (e) => {
              handleTripClick(e, e.features[0]);
            });
          }
        }
        
        return data;
      }
      
      return null;
    } catch (error) {
      console.error("Error fetching matched trips:", error);
      return null;
    }
      }

  async function fetchUndrivenStreets() {
    const selectedLocationId = storage.get(CONFIG.STORAGE_KEYS.selectedLocation);
    if (!selectedLocationId || !isMapReady()) return null;

    try {
      // Get the full location object from coverage areas
      const coverageAreas = await fetchCoverageAreas();
      const selectedLocation = coverageAreas.find(area => area._id === selectedLocationId);
      
      if (!selectedLocation || !selectedLocation.location) {
        console.warn("Selected location not found in coverage areas:", selectedLocationId);
        return null;
      }

      // Send the location object as expected by the API
      const locationData = selectedLocation.location;
      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(locationData),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data?.type === "FeatureCollection") {
        AppState.mapLayers.undrivenStreets.layer = data;
        await updateMapWithUndrivenStreets(data);
        return data;
      }
      
      return null;
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      return null;
    }
  }

  // Main update function
  async function updateMap(fitBounds = false) {
    if (!isMapReady()) return;

    try {
      const promises = [];
      
      // Fetch trips data
      if (AppState.mapLayers.trips.visible) {
        promises.push(fetchTrips().then(data => {
          if (data) return updateMapWithTrips(data);
        }));
      }
      
      // Fetch matched trips if visible
      if (AppState.mapLayers.matchedTrips.visible) {
        promises.push(fetchMatchedTrips());
      }
      
      // Fetch undriven streets if visible
      if (AppState.mapLayers.undrivenStreets.visible) {
        promises.push(lazyFetchUndrivenStreets());
      }

      await Promise.all(promises);

      // Fit bounds if requested
      if (fitBounds) {
        fitMapBounds();
      }

    } catch (error) {
      console.error("Error updating map:", error);
      showNotification("Error updating map data", "danger");
    }
  }

  // Trip interaction handlers adapted for Mapbox
  function handleTripClick(e, feature) {
    if (!feature || !feature.properties) return;

    const tripId = feature.properties.id || feature.properties.tripId;
    if (tripId) {
      AppState.selectedTripId = tripId;
      refreshTripStyles();
    }

    // Create and show popup
    const popupContent = createTripPopupContent(feature);
    
    const popup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: '400px'
    })
    .setLngLat(e.lngLat)
    .setHTML(popupContent)
    .addTo(AppState.map);

    // Setup popup event listeners
    popup.on('open', () => {
      setupPopupEventListeners(popup, feature);
    });
  }

  function createTripPopupContent(feature) {
    const props = feature.properties || {};
    
    const format = (value, formatter) => value != null ? formatter(value) : "N/A";
    const formatNum = (value, digits = 1) => format(value, (v) => parseFloat(v).toFixed(digits));
    const formatTime = (value) => format(value, (v) => 
      new Date(v).toLocaleString('en-US', { 
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true 
      })
    );
    const formatDuration = (value) => format(value, (v) => DateUtils.formatSecondsToHMS(v));
    
    // Calculate duration if not provided (especially for matched trips)
    let duration = props.duration || props.drivingTime;
    if (!duration && props.startTime && props.endTime) {
      try {
        const startTime = new Date(props.startTime);
        const endTime = new Date(props.endTime);
        if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
          duration = (endTime - startTime) / 1000; // Convert to seconds
        }
      } catch (e) {
        console.warn("Could not calculate duration from timestamps:", e);
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
          <span>${formatNum(props.distance)} mi</span>
        </div>
        <div class="popup-detail">
          <span class="popup-label">Duration:</span>
          <span>${formatDuration(duration)}</span>
        </div>
        <div class="popup-detail">
          <span class="popup-label">Avg Speed:</span>
          <span>${formatNum(props.averageSpeed)} mph</span>
        </div>
        <div class="popup-detail">
          <span class="popup-label">Max Speed:</span>
          <span>${formatNum(props.maxSpeed)} mph</span>
        </div>
        ${createActionButtons(feature)}
      </div>
    `;
  }

  function createActionButtons(feature) {
    const props = feature.properties || {};
    const isMatched = props.source === "matched" || props.mapMatchingStatus === "success";
    const tripId = props.id || props.tripId;

    if (!tripId) return "";

    return `
      <div class="popup-actions mt-3 d-flex gap-2 flex-wrap">
        <button class="btn btn-sm btn-primary view-trip-btn" data-trip-id="${tripId}">
          <i class="fas fa-eye"></i> View
        </button>
        ${isMatched ? `
          <button class="btn btn-sm btn-warning rematch-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-redo"></i> Rematch
          </button>
          <button class="btn btn-sm btn-danger delete-matched-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-trash"></i> Delete Matched
          </button>
        ` : `
          <button class="btn btn-sm btn-info map-match-btn" data-trip-id="${tripId}">
            <i class="fas fa-route"></i> Map Match
          </button>
          <button class="btn btn-sm btn-danger delete-trip-btn" data-trip-id="${tripId}">
            <i class="fas fa-trash"></i> Delete
          </button>
        `}
      </div>
    `;
  }

  function setupPopupEventListeners(popup, feature) {
    const popupElement = popup.getElement();
    if (!popupElement) return;

    const handlePopupClick = async (e) => {
      const button = e.target.closest("button");
      if (!button) return;

      const tripId = button.dataset.tripId;
      if (!tripId) return;

      try {
        if (button.classList.contains("delete-matched-trip-btn")) {
          await handleDeleteMatchedTrip(tripId, popup);
        } else if (button.classList.contains("delete-trip-btn")) {
          await handleDeleteTrip(tripId, popup);
        } else if (button.classList.contains("rematch-trip-btn")) {
          await handleRematchTrip(tripId, popup, feature);
        } else if (button.classList.contains("view-trip-btn")) {
          window.open(`/trips/${tripId}`, '_blank');
        } else if (button.classList.contains("map-match-btn")) {
          await handleRematchTrip(tripId, popup, feature);
        }
      } catch (error) {
        console.error("Error handling popup action:", error);
        showNotification("Error performing action", "danger");
      }
    };

    popupElement.addEventListener("click", handlePopupClick);
  }

  // Continue with remaining functions like handleDeleteMatchedTrip, etc.
  async function handleDeleteMatchedTrip(tripId, popup) {
    if (!confirm("Are you sure you want to delete this matched trip?")) return;

    try {
      const response = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        popup.remove();
        showNotification("Matched trip deleted successfully", "success");
        await updateMap();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to delete matched trip");
      }
    } catch (error) {
      console.error("Error deleting matched trip:", error);
      showNotification(error.message, "danger");
    }
  }

  async function handleDeleteTrip(tripId, popup) {
    if (!confirm("Are you sure you want to delete this trip? This action cannot be undone.")) return;

    try {
      const response = await fetch(`/api/trips/${tripId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        popup.remove();
        showNotification("Trip deleted successfully", "success");
        await updateMap();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to delete trip");
      }
    } catch (error) {
      console.error("Error deleting trip:", error);
      showNotification(error.message, "danger");
    }
  }

  async function handleRematchTrip(tripId, popup, feature) {
    try {
      showNotification("Starting map matching...", "info");
      
      const response = await fetch(`/api/process_trip/${tripId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ map_match: true }),
      });

      if (response.ok) {
        const result = await response.json();
        popup.remove();
        showNotification("Trip map matching completed", "success");
        await updateMap();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to remap trip");
      }
    } catch (error) {
      console.error("Error remapping trip:", error);
      showNotification(error.message, "danger");
    }
  }

  // Map bounds and navigation functions
  function fitMapBounds() {
    if (!AppState.map || !AppState.mapInitialized) return;

    const allFeatures = [];
    
    // Collect features from all visible layers
    Object.entries(AppState.mapLayers).forEach(([name, layerInfo]) => {
      if (layerInfo.visible && layerInfo.layer?.features) {
        allFeatures.push(...layerInfo.layer.features);
      }
    });

    if (allFeatures.length === 0) return;

    // Calculate bounds
    const bounds = new mapboxgl.LngLatBounds();
    
    allFeatures.forEach(feature => {
      if (feature.geometry) {
        if (feature.geometry.type === 'Point') {
          bounds.extend(feature.geometry.coordinates);
        } else if (feature.geometry.type === 'LineString') {
          feature.geometry.coordinates.forEach(coord => bounds.extend(coord));
        } else if (feature.geometry.type === 'MultiLineString') {
          feature.geometry.coordinates.forEach(line => {
            line.forEach(coord => bounds.extend(coord));
          });
        }
      }
    });

    if (!bounds.isEmpty()) {
      AppState.map.fitBounds(bounds, { 
        padding: 50,
        maxZoom: 15,
        duration: 1000
      });
    }
  }

  // Additional utility functions
  async function mapMatchTrips() {
    try {
      showNotification("Starting map matching process...", "info");
      
    const startDate = getStartDate();
    const endDate = getEndDate();

      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (response.ok) {
        const result = await response.json();
        showNotification(`Map matching completed: ${result.message}`, "success");
        await updateMap();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Map matching failed");
      }
    } catch (error) {
      console.error("Error in map matching:", error);
      showNotification(`Map matching error: ${error.message}`, "danger");
    }
  }

  async function fetchTripsInRange() {
    try {
    const startDate = getStartDate();
    const endDate = getEndDate();

      const response = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (response.ok) {
        const result = await response.json();
        showNotification(`Fetched ${result.new_trips || 0} new trips`, "success");
        await updateMap();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to fetch trips");
      }
    } catch (error) {
      console.error("Error fetching trips in range:", error);
      showNotification(`Fetch error: ${error.message}`, "danger");
    }
  }

  async function fetchMetrics() {
    try {
    const startDate = getStartDate();
    const endDate = getEndDate();
      
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });

      const data = await cachedFetch(`/api/metrics?${params}`);
      
      // Update metrics display (implementation depends on your metrics structure)
      if (data) {
        document.dispatchEvent(new CustomEvent("metricsUpdated", { detail: data }));
      }
      
      return data;
    } catch (error) {
      console.error("Error fetching metrics:", error);
      return null;
    }
  }

  async function fetchCoverageAreas() {
    try {
      const data = await cachedFetch("/api/coverage_areas");
      // The API returns {success: true, areas: [...]} so extract the areas
      if (data && data.success && Array.isArray(data.areas)) {
        return data.areas;
      }
      // Fallback for direct array response
      if (Array.isArray(data)) {
        return data;
      }
      console.warn("Unexpected coverage areas response format:", data);
      return [];
    } catch (error) {
      console.error("Error fetching coverage areas:", error);
      return [];
    }
  }

  async function populateLocationDropdown() {
    const dropdown = getElement("undriven-streets-location");
    if (!dropdown) return;

    try {
    const coverageAreas = await fetchCoverageAreas();
      
      dropdown.innerHTML = '<option value="">Select a location...</option>';
      
      // Ensure coverageAreas is an array
      const areasArray = Array.isArray(coverageAreas) ? coverageAreas : [];
      
      if (areasArray.length === 0) {
        console.warn("No coverage areas returned from API");
      return;
    }

      areasArray.forEach(area => {
        const option = document.createElement("option");
        option.value = area._id || area.id;
        option.textContent = area.location?.display_name || area.location?.city || area.name || area.city || "Unknown Location";
        dropdown.appendChild(option);
    });

      // Restore saved selection
      const savedLocationId = storage.get(CONFIG.STORAGE_KEYS.selectedLocation);
    if (savedLocationId) {
        dropdown.value = savedLocationId;
      }

    } catch (error) {
      console.error("Error populating location dropdown:", error);
      showNotification("Failed to load coverage areas", "warning");
    }
  }

  // Event listeners setup
  function initializeEventListeners() {
    // Controls toggle
    const controlsToggle = getElement("controls-toggle");
    if (controlsToggle) {
      const updateIcon = () => {
        const content = getElement("controls-content");
        const icon = controlsToggle.querySelector("i");
        if (content && icon) {
          const isCollapsed = !content.classList.contains("show");
          icon.className = isCollapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
        }
      };

      controlsToggle.addEventListener("click", () => {
        setTimeout(updateIcon, 350);
      });
      updateIcon();
    }

    // Location dropdown
    const locationDropdown = getElement("undriven-streets-location");
    if (locationDropdown) {
      locationDropdown.addEventListener("change", (e) => {
        const selectedLocationId = e.target.value;
        storage.set(CONFIG.STORAGE_KEYS.selectedLocation, selectedLocationId);
        
        if (selectedLocationId && AppState.mapLayers.undrivenStreets.visible) {
          undrivenStreetsLoaded = false;
          lazyFetchUndrivenStreets();
        }
      });
    }

    // Center on location button
    const centerButton = getElement("center-on-location");
    if (centerButton) {
      centerButton.addEventListener("click", () => {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const { latitude, longitude } = position.coords;
              AppState.map.flyTo({
                center: [longitude, latitude],
                zoom: 14,
                duration: 1000
              });
            },
            (error) => {
              console.error("Geolocation error:", error);
              showNotification("Unable to get your location", "warning");
            }
          );
        } else {
          showNotification("Geolocation is not supported", "warning");
        }
      });
    }

    // Highlight recent trips toggle
    const highlightToggle = getElement("highlight-recent-trips");
    if (highlightToggle) {
      highlightToggle.addEventListener("change", (e) => {
        AppState.mapSettings.highlightRecentTrips = e.target.checked;
        refreshTripStyles();
      });
    }
  }

  // Date picker functions
  function setInitialDates() {
    const startDateInput = getElement("start-date");
    const endDateInput = getElement("end-date");
    
    if (startDateInput && !startDateInput.value) {
      startDateInput.value = getStartDate();
    }
    if (endDateInput && !endDateInput.value) {
      endDateInput.value = getEndDate();
    }
  }

  function initializeDatePickers() {
    if (!window.flatpickr) return;

    const startDateInput = getElement("start-date");
    const endDateInput = getElement("end-date");

    if (startDateInput) {
      window.flatpickr(startDateInput, {
      dateFormat: "Y-m-d",
        defaultDate: getStartDate(),
      onChange(selectedDates, dateStr) {
          storage.set(CONFIG.STORAGE_KEYS.startDate, dateStr);
          updateMap();
        },
      });
    }

    if (endDateInput) {
      window.flatpickr(endDateInput, {
        dateFormat: "Y-m-d",
        defaultDate: getEndDate(),
        onChange(selectedDates, dateStr) {
          storage.set(CONFIG.STORAGE_KEYS.endDate, dateStr);
          updateMap();
        },
      });
    }
  }

  // Layer management functions
  function getOrCreateGeoJsonLayer(name, data, options) {
    if (!data?.features) {
      console.warn(`No features found for layer: ${name}`);
      return null;
    }

    const layerInfo = AppState.mapLayers[name];
    if (layerInfo) {
      layerInfo.layer = data;
      
      // Update Mapbox layer
      const sourceId = `${name}-source`;
      const layerId = `${name}-layer`;
      
      if (AppState.map && AppState.mapInitialized) {
        mapboxUtils.addOrUpdateSource(AppState.map, sourceId, data);
        
        if (!AppState.map.getLayer(layerId)) {
          mapboxUtils.addOrUpdateLayer(AppState.map, layerId, sourceId, layerInfo);
          
          // Apply additional options
          if (options?.style) {
            Object.entries(options.style).forEach(([property, value]) => {
              AppState.map.setPaintProperty(layerId, property, value);
          });
        }
      }
    }
    }
    
    return AppState.mapLayers[name];
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
      AppState.map.flyTo({
        center: lastCoord, // Mapbox uses [lng, lat]
        zoom: targetZoom,
        duration: duration * 1000,
        essential: true
      });
    }
  }

  // Main initialization function
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
            const toggle = document.getElementById(`${layerName}-toggle`);
            if (layerName === "trips") {
              // Always show trips layer by default
              AppState.mapLayers[layerName].visible = true;
              if (toggle) toggle.checked = true;
            } else {
              const savedVisibility = storage.get(`layer_visible_${layerName}`);
              if (savedVisibility !== null) {
                const isVisible = savedVisibility === "true";
                AppState.mapLayers[layerName].visible = isVisible;
                if (toggle) toggle.checked = isVisible;
              } else {
                if (toggle) toggle.checked = AppState.mapLayers[layerName].visible;
              }
              // Clear layer data for undrivenStreets if not visible
              if (layerName === "undrivenStreets" && !AppState.mapLayers[layerName].visible) {
                AppState.mapLayers[layerName].layer = { type: "FeatureCollection", features: [] };
              }
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
    window.CONFIG = CONFIG; // Make CONFIG globally available
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

  // Keyboard navigation adapted for Mapbox
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
      e.preventDefault();
    }
  });

  document.addEventListener("visibilitychange", () => {
    // Clean up resources when page becomes hidden
    if (document.hidden) {
      apiCache.clear();
    }
  });
})();
