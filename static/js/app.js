/* global L, flatpickr, notificationManager, bootstrap, $, DateUtils */

/**
 * Main application module for Every Street mapping functionality
 */
"use strict";

(function () {
  // Configuration
  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129],
      defaultZoom: 4,
      tileLayerUrls: {
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        satellite:
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        streets: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      },
      tileLayerAttribution: {
        dark: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        light:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        satellite:
          "Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community",
        streets:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours in ms
      debounceDelay: 100,
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

  // Default layer configurations
  const LAYER_DEFAULTS = {
    trips: {
      order: 1,
      color: "#BB86FC",
      opacity: 0.6,
      visible: true,
      highlightColor: "#FFD700",
      name: "Trips",
      weight: 3,
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.6,
      visible: false,
      highlightColor: "#40E0D0",
      name: "Matched Trips",
      weight: 3,
    },
    undrivenStreets: {
      order: 2,
      color: "#00BFFF", // Bright blue for undriven streets
      opacity: 0.8,
      visible: false,
      name: "Undriven Streets",
      weight: 2,
    },
  };

  // Application State
  const AppState = {
    map: null,
    layerGroup: null,
    mapLayers: { ...LAYER_DEFAULTS },
    mapInitialized: false,
    mapSettings: { highlightRecentTrips: true },
    trips: [],
    selectedTripId: null,
    polling: {
      active: true,
      interval: 5000,
      timers: {},
    },
    dom: {},
    baseLayer: null,
  };

  // DOM Cache and Utilities
  const getElement = (selector, useCache = true, context = document) => {
    if (useCache && AppState.dom[selector]) return AppState.dom[selector];

    const normalizedSelector =
      selector.startsWith("#") || selector.includes(" ")
        ? selector
        : `#${selector}`;
    const element = context.querySelector(normalizedSelector);
    if (useCache && element) AppState.dom[selector] = element;
    return element;
  };

  const showNotification = (message, type = "info") => {
    if (window.notificationManager?.show) {
      window.notificationManager.show(message, type);
      return true;
    }
    console.log(`${type.toUpperCase()}: ${message}`);
    return false;
  };

  const handleError = (error, context) =>
    window.handleError?.(error, context) ||
    console.error(`Error in ${context}:`, error);

  const addSingleEventListener = (element, eventType, handler) => {
    const el = typeof element === "string" ? getElement(element) : element;
    if (!el) return false;

    if (!el._eventHandlers) el._eventHandlers = {};

    const handlerKey = `${eventType}_${handler
      .toString()
      .substring(0, 50)
      .replace(/\s+/g, "")}`;
    if (el._eventHandlers[handlerKey]) return false;

    el.addEventListener(eventType, handler);
    el._eventHandlers[handlerKey] = handler;
    return true;
  };

  // Use utils.js storage functions
  const getStorageItem =
    window.utils?.getStorage ||
    ((key, defaultValue = null) => {
      try {
        const value = localStorage.getItem(key);
        return value !== null ? value : defaultValue;
      } catch (e) {
        console.warn(`Error reading from localStorage: ${e.message}`);
        return defaultValue;
      }
    });

  const setStorageItem =
    window.utils?.setStorage ||
    ((key, value) => {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        console.warn(`Error writing to localStorage: ${e.message}`);
        return false;
      }
    });

  const debounce =
    window.utils?.debounce ||
    ((func, delay) => {
      let timeout;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(null, args), delay);
      };
    });

  const debouncedUpdateMap = debounce(updateMap, CONFIG.MAP.debounceDelay);

  // Date & Filter Functions
  const getStartDate = () => {
    // Primarily rely on localStorage, managed by modern-ui.js
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.startDate);
    return storedDate
      ? DateUtils.formatDate(storedDate)
      : DateUtils.getCurrentDate();
  };

  const getEndDate = () => {
    // Primarily rely on localStorage, managed by modern-ui.js
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.endDate);
    return storedDate
      ? DateUtils.formatDate(storedDate)
      : DateUtils.getCurrentDate();
  };

  // Trip Styling Functions
  const getTripFeatureStyle = (feature, layerInfo) => {
    const { properties } = feature;
    const { transactionId, startTime } = properties;
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const tripStartTime = new Date(startTime).getTime();
    const isRecent =
      AppState.mapSettings.highlightRecentTrips && tripStartTime > sixHoursAgo;
    const isSelected = transactionId === AppState.selectedTripId;
    const isMatchedPair =
      isSelected ||
      (AppState.selectedTripId &&
        transactionId &&
        (AppState.selectedTripId.replace("MATCHED-", "") === transactionId ||
          transactionId.replace("MATCHED-", "") === AppState.selectedTripId));

    let color = layerInfo.color;
    let weight = layerInfo.weight || 3;
    let opacity = layerInfo.opacity;

    // Apply enhanced styling for selected and recent trips
    if (isSelected) {
      color = layerInfo.highlightColor || "#FFD700"; // Gold for selected
      weight = 5;
      opacity = 1;
    } else if (isMatchedPair) {
      color = "#03DAC6"; // Teal for matched pairs
      weight = 4;
      opacity = 0.8;
    } else if (isRecent) {
      color = layerInfo.highlightColor || "#FF4081"; // Pink for recent
      weight = 4;
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

  function refreshTripStyles() {
    if (!AppState.layerGroup) return;

    AppState.layerGroup.eachLayer((layer) => {
      if (layer.eachLayer) {
        layer.eachLayer((featureLayer) => {
          if (featureLayer.feature?.properties && featureLayer.setStyle) {
            const layerInfo = featureLayer.feature.properties.isMatched
              ? AppState.mapLayers.matchedTrips
              : AppState.mapLayers.trips;

            featureLayer.setStyle(
              getTripFeatureStyle(featureLayer.feature, layerInfo),
            );

            if (
              featureLayer.feature.properties.transactionId ===
              AppState.selectedTripId
            ) {
              featureLayer.bringToFront();
            }
          }
        });
      }
    });
  }

  // Map Initialization & Controls
  const isMapReady = () =>
    AppState.map && AppState.mapInitialized && AppState.layerGroup;

  async function initializeMap() {
    try {
      if (AppState.map) return true;

      const mapElement = getElement("map");
      if (!mapElement) {
        showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
        return false;
      }

      // Create map with enhanced options
      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: false, // We'll add custom controls
        attributionControl: false, // Remove default attribution
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

      // Expose map globally AFTER initialization
      window.map = AppState.map;

      // Initialize the currentTheme variable
      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";

      // Add the tile layer based on the theme
      const tileUrl =
        CONFIG.MAP.tileLayerUrls[theme] || CONFIG.MAP.tileLayerUrls.dark;
      const attribution =
        CONFIG.MAP.tileLayerAttribution[theme] ||
        CONFIG.MAP.tileLayerAttribution.dark;

      AppState.baseLayer = L.tileLayer(tileUrl, {
        attribution,
        maxZoom: CONFIG.MAP.maxZoom,
        crossOrigin: true,
      }).addTo(AppState.map);

      // Add custom zoom controls in a better position
      L.control
        .zoom({
          position: "topright",
        })
        .addTo(AppState.map);

      // Add scale control
      L.control
        .scale({
          imperial: true,
          metric: true,
          position: "bottomright",
        })
        .addTo(AppState.map);

      // Add layer group for vector data
      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      // Add basemap selector
      const basemaps = {
        Dark: L.tileLayer(CONFIG.MAP.tileLayerUrls.dark, {
          attribution: CONFIG.MAP.tileLayerAttribution.dark,
          maxZoom: CONFIG.MAP.maxZoom,
        }),
        Light: L.tileLayer(CONFIG.MAP.tileLayerUrls.light, {
          attribution: CONFIG.MAP.tileLayerAttribution.light,
          maxZoom: CONFIG.MAP.maxZoom,
        }),
        Satellite: L.tileLayer(CONFIG.MAP.tileLayerUrls.satellite, {
          attribution: CONFIG.MAP.tileLayerAttribution.satellite,
          maxZoom: CONFIG.MAP.maxZoom,
        }),
        Streets: L.tileLayer(CONFIG.MAP.tileLayerUrls.streets, {
          attribution: CONFIG.MAP.tileLayerAttribution.streets,
          maxZoom: CONFIG.MAP.maxZoom,
        }),
      };

      // Use the current theme as the default basemap
      const defaultBasemap = theme === "light" ? "Light" : "Dark";
      if (basemaps[defaultBasemap]) {
        // Check if exists
        basemaps[defaultBasemap].addTo(AppState.map);
      } else {
        basemaps["Dark"].addTo(AppState.map); // Fallback to Dark
      }

      L.control
        .layers(basemaps, null, {
          position: "topright",
          collapsed: true,
        })
        .addTo(AppState.map);

      // Map events for better user experience
      AppState.map.on("zoomend", () => {
        updateUrlWithMapState();
        adjustLayerStylesForZoom();
      });

      AppState.map.on("moveend", () => {
        updateUrlWithMapState();
      });

      // Dispatch mapInitialized event after map setup is complete
      document.dispatchEvent(new CustomEvent("mapInitialized"));

      // Set map initialized flag
      AppState.mapInitialized = true;
      return true;
    } catch (error) {
      handleError(error, "Map initialization");
      showNotification(
        `${CONFIG.ERROR_MESSAGES.mapInitFailed}: ${error.message}`,
        "danger",
      );
      return false;
    }
  }

  // Update URL with current map state to allow sharing
  function updateUrlWithMapState() {
    if (!AppState.map || !window.history) return;

    const center = AppState.map.getCenter();
    const zoom = AppState.map.getZoom();
    const lat = center.lat.toFixed(5);
    const lng = center.lng.toFixed(5);

    const url = new URL(window.location.href);
    url.searchParams.set("zoom", zoom);
    url.searchParams.set("lat", lat);
    url.searchParams.set("lng", lng);

    window.history.replaceState({}, "", url.toString());
  }

  // Adjust layer weights based on zoom level
  function adjustLayerStylesForZoom() {
    if (!AppState.map || !AppState.layerGroup) return;

    const zoom = AppState.map.getZoom();

    // Iterate through all layers and adjust their styling
    AppState.layerGroup.eachLayer((layer) => {
      if (layer.feature && layer.feature.properties) {
        // Get the appropriate layerInfo
        let layerName = "trips";
        if (
          layer.feature.properties.transactionId &&
          layer.feature.properties.transactionId.startsWith("MATCHED-")
        ) {
          layerName = "matchedTrips";
        } else if (layer.feature.properties.type === "undriven") {
          layerName = "undrivenStreets";
        }

        const layerInfo = AppState.mapLayers[layerName];

        // Apply style based on zoom level
        if (zoom > 14) {
          // Higher zoom - make lines more prominent
          let weight = (layerInfo.weight || 2) * 1.5;
          layer.setStyle({ weight });
        } else {
          // Lower zoom - use default weight
          layer.setStyle({ weight: layerInfo.weight || 2 });
        }
      }
    });
  }

  // Update map theme based on the application theme
  function updateMapTheme(theme) {
    if (!AppState.map || !AppState.baseLayer) return;

    const isDark = theme === "dark";
    const tileUrl = isDark
      ? CONFIG.MAP.tileLayerUrls.dark
      : CONFIG.MAP.tileLayerUrls.light;
    const attribution = isDark
      ? CONFIG.MAP.tileLayerAttribution.dark
      : CONFIG.MAP.tileLayerAttribution.light;

    // Remove the current base layer
    AppState.map.removeLayer(AppState.baseLayer);

    // Create and add the new base layer
    AppState.baseLayer = L.tileLayer(tileUrl, {
      attribution,
      maxZoom: CONFIG.MAP.maxZoom,
    }).addTo(AppState.map);

    // Make sure the base layer is at the bottom
    if (AppState.baseLayer && AppState.layerGroup) {
      AppState.baseLayer.bringToBack();
    }

    // Refresh trip styles to match the new theme
    refreshTripStyles();
  }

  function initializeLiveTracker() {
    if (!window.LiveTripTracker || !AppState.map) return;

    try {
      if (!window.liveTracker) {
        AppState.liveTracker = new window.LiveTripTracker(AppState.map);
        window.liveTracker = AppState.liveTracker;
      }
    } catch (error) {
      handleError(error, "LiveTripTracker Initialization");
    }
  }

  async function centerMapOnLastPosition() {
    try {
      const response = await fetch("/api/last_trip_point");
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);

      const data = await response.json();
      if (data.lastPoint && AppState.map) {
        AppState.map.flyTo([data.lastPoint[1], data.lastPoint[0]], 11, {
          duration: 2,
          easeLinearity: 0.25,
        });
      } else {
        AppState.map?.setView([31.55002, -97.123354], 14);
      }
    } catch (error) {
      AppState.map?.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      throw error;
    }
  }

  function initializeLayerControls() {
    const layerToggles = getElement("layer-toggles");
    if (!layerToggles) return;

    layerToggles.innerHTML = "";

    Object.entries(AppState.mapLayers).forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;

      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${
            info.visible ? "checked" : ""
          }>
          <span class="checkmark"></span>
        </label>
        <label for="${name}-toggle">${info.name || name}</label>
      `;

      if (!["customPlaces"].includes(name)) {
        const colorControl = document.createElement("input");
        colorControl.type = "color";
        colorControl.id = `${name}-color`;
        colorControl.value = info.color;
        div.appendChild(colorControl);

        const opacityLabel = document.createElement("label");
        opacityLabel.setAttribute("for", `${name}-opacity`);
        opacityLabel.textContent = "Opacity:";
        div.appendChild(opacityLabel);

        const opacitySlider = document.createElement("input");
        opacitySlider.type = "range";
        opacitySlider.id = `${name}-opacity`;
        opacitySlider.min = "0";
        opacitySlider.max = "1";
        opacitySlider.step = "0.1";
        opacitySlider.value = info.opacity;
        div.appendChild(opacitySlider);
      }

      layerToggles.appendChild(div);
    });

    // Use event delegation
    layerToggles.addEventListener("change", (e) => {
      const target = e.target;
      if (target.matches('input[type="checkbox"]')) {
        toggleLayer(target.id.replace("-toggle", ""), target.checked);
      }
    });

    layerToggles.addEventListener("input", (e) => {
      const target = e.target;
      if (target.matches('input[type="color"]')) {
        changeLayerColor(target.id.replace("-color", ""), target.value);
      } else if (target.matches('input[type="range"]')) {
        changeLayerOpacity(
          target.id.replace("-opacity", ""),
          parseFloat(target.value),
        );
      }
    });

    updateLayerOrderUI();
  }

  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;

    if (name === "customPlaces" && window.customPlaces) {
      window.customPlaces.toggleVisibility(visible);
    } else if (name === "undrivenStreets" && visible) {
      // When undriven streets layer is toggled on, fetch the data
      fetchUndrivenStreets();
    } else {
      debouncedUpdateMap();
    }

    updateLayerOrderUI();
    document.dispatchEvent(
      new CustomEvent("layerVisibilityChanged", {
        detail: { layer: name, visible },
      }),
    );
  }

  function changeLayerColor(name, color) {
    if (!AppState.mapLayers[name]) return;
    AppState.mapLayers[name].color = color;
    debouncedUpdateMap();
  }

  function changeLayerOpacity(name, opacity) {
    if (!AppState.mapLayers[name]) return;
    AppState.mapLayers[name].opacity = opacity;
    debouncedUpdateMap();
  }

  function updateLayerOrderUI() {
    const layerOrderEl = getElement("layer-order");
    if (!layerOrderEl) return;

    layerOrderEl.innerHTML = '<h4 class="h6">Layer Order</h4>';

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => b.order - a.order);

    const ul = document.createElement("ul");
    ul.id = "layer-order-list";
    ul.className = "list-group bg-dark";

    visibleLayers.forEach(([name, info]) => {
      const li = document.createElement("li");
      li.textContent = info.name || name;
      li.draggable = true;
      li.dataset.layer = name;
      li.className = "list-group-item bg-dark text-white";
      ul.appendChild(li);
    });

    layerOrderEl.appendChild(ul);
    initializeDragAndDrop();
  }

  function initializeDragAndDrop() {
    const list = getElement("layer-order-list");
    if (!list) return;

    let draggedItem = null;

    list.addEventListener("dragstart", (e) => {
      draggedItem = e.target;
      e.dataTransfer.effectAllowed = "move";
      setTimeout(() => draggedItem.classList.add("dragging"), 0);
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target.closest("li");
      if (target && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        const midpoint = (e.clientY - rect.top) / (rect.bottom - rect.top);
        if (midpoint > 0.5) {
          list.insertBefore(draggedItem, target.nextSibling);
        } else {
          list.insertBefore(draggedItem, target);
        }
      }
    });

    list.addEventListener("dragend", (e) => {
      e.target.classList.remove("dragging");
      updateLayerOrder();
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

  // API Calls & Map Data
  async function withLoading(
    operationId,
    totalWeight = 100,
    operation,
    subOperations = {},
  ) {
    const loadingManager = window.loadingManager || {
      startOperation: () => {},
      addSubOperation: () => {},
      updateSubOperation: () => {},
      finish: () => {},
    };

    try {
      loadingManager.startOperation(operationId, totalWeight);
      Object.entries(subOperations).forEach(([name, weight]) => {
        loadingManager.addSubOperation(operationId, name, weight);
      });
      return await operation(loadingManager, operationId);
    } catch (error) {
      handleError(error, operationId);
      throw error;
    } finally {
      loadingManager.finish(operationId);
    }
  }

  async function fetchTrips() {
    return withLoading(
      "Fetching and Displaying Trips",
      100,
      async (lm, opId) => {
        const subOps = {
          "Fetching Data": 50,
          "Processing Data": 30,
          "Displaying Data": 20,
        };

        Object.entries(subOps).forEach(([name, weight]) => {
          lm.addSubOperation(opId, name, weight);
        });

        const startDate = DateUtils.formatDate(
          getStorageItem(CONFIG.STORAGE_KEYS.startDate),
        );
        const endDate = DateUtils.formatDate(
          getStorageItem(CONFIG.STORAGE_KEYS.endDate),
        );

        if (!startDate || !endDate) {
          showNotification("Invalid date range for fetching trips.", "warning");
          console.warn("Invalid dates selected for fetching trips.");
          return;
        }

        if (AppState.dom.startDateInput)
          AppState.dom.startDateInput.value = startDate;
        if (AppState.dom.endDateInput)
          AppState.dom.endDateInput.value = endDate;

        lm.updateSubOperation(opId, "Fetching Data", 25);

        const params = new URLSearchParams({
          start_date: startDate,
          end_date: endDate,
        });
        const response = await fetch(`/api/trips?${params.toString()}`);
        if (!response.ok)
          throw new Error(`HTTP error! status: ${response.status}`);

        const geojson = await response.json();
        lm.updateSubOperation(opId, "Fetching Data", 50);
        lm.updateSubOperation(opId, "Processing Data", 15);

        // Ensure trips table is updated before map potentially fits bounds
        await updateTripsTable(geojson);
        // Now update the map layer data
        await updateMapWithTrips(geojson);

        // Fetch matched trips and update the map layer data
        try {
          await fetchMatchedTrips();
        } catch (err) {
          handleError(err, "Fetching Matched Trips");
        }

        // Update map rendering after all layers are potentially updated
        await updateMap();

        lm.updateSubOperation(opId, "Processing Data", 30);
        lm.updateSubOperation(opId, "Displaying Data", 20); // Adjusted timing

        document.dispatchEvent(
          new CustomEvent("tripsLoaded", {
            detail: { count: geojson.features.length },
          }),
        );
      },
    );
  }

  async function updateTripsTable(geojson) {
    if (!window.tripsTable) return;

    const formattedTrips = geojson.features.map((trip) => ({
      ...trip.properties,
      gps: trip.geometry, // Keep geometry if needed elsewhere
      // Use DateUtils for reliable formatting
      startTimeFormatted: DateUtils.formatForDisplay(
        trip.properties.startTime,
        {
          dateStyle: "short",
          timeStyle: "short",
        },
      ),
      endTimeFormatted: DateUtils.formatForDisplay(trip.properties.endTime, {
        dateStyle: "short",
        timeStyle: "short",
      }),
      startTimeRaw: trip.properties.startTime, // Keep raw for sorting/filtering
      endTimeRaw: trip.properties.endTime, // Keep raw for sorting/filtering
      destination: trip.properties.destination || "N/A",
      startLocation: trip.properties.startLocation || "N/A",
      distance: Number(trip.properties.distance).toFixed(2),
    }));

    // Wrap in promise for async consistency
    return new Promise((resolve) => {
      // Check if DataTable instance exists
      if ($.fn.DataTable.isDataTable("#tripsTable")) {
        // Assuming table ID is tripsTable
        window.tripsTable.clear().rows.add(formattedTrips).draw();
      } else {
        console.warn("Trips DataTable not initialized yet.");
        // Optionally initialize here if needed, or ensure initialization order
      }
      setTimeout(resolve, 100); // Allow draw to complete
    });
  }

  async function updateMapWithTrips(geojson) {
    if (!geojson?.features) return;
    AppState.mapLayers.trips.layer = {
      type: "FeatureCollection",
      features: geojson.features,
    };
    await updateMap();
  }

  async function updateMapWithUndrivenStreets(geojson) {
    if (!geojson?.features) return;
    AppState.mapLayers.undrivenStreets.layer = geojson;
    await updateMap();
  }

  async function fetchMatchedTrips() {
    const startDate = DateUtils.formatDate(
      getStorageItem(CONFIG.STORAGE_KEYS.startDate),
    );
    const endDate = DateUtils.formatDate(
      getStorageItem(CONFIG.STORAGE_KEYS.endDate),
    );

    if (!startDate || !endDate) {
      console.warn("Invalid date range for fetching matched trips");
      return;
    }

    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });
    const response = await fetch(`/api/matched_trips?${params.toString()}`);

    if (!response.ok)
      throw new Error(`HTTP error fetching matched trips: ${response.status}`);

    const geojson = await response.json();
    AppState.mapLayers.matchedTrips.layer = geojson;
    return geojson;
  }

  async function fetchUndrivenStreets() {
    try {
      const locationSelect = document.getElementById(
        "undriven-streets-location",
      );
      if (!locationSelect || !locationSelect.value) {
        showNotification(
          "Please select a location from the dropdown to show undriven streets",
          "warning",
        );
        AppState.mapLayers.undrivenStreets.visible = false;
        await updateMap();
        return null;
      }

      let location;
      try {
        location = JSON.parse(locationSelect.value);
        // --- Add Frontend Logging ---
        console.log(
          "[fetchUndrivenStreets] Parsed location object from dropdown:",
          JSON.stringify(location, null, 2),
        );
        if (
          !location ||
          typeof location !== "object" ||
          !location.display_name
        ) {
          throw new Error(
            "Parsed location data is invalid or missing display_name.",
          );
        }
        // --- End Frontend Logging ---
      } catch (parseError) {
        showNotification(
          `Invalid location data in dropdown: ${parseError.message}. Please select another location.`,
          "warning",
        );
        AppState.mapLayers.undrivenStreets.visible = false;
        await updateMap();
        return null;
      }

      localStorage.setItem(
        "selectedLocationForUndrivenStreets",
        location._id || location.display_name,
      ); // Use display_name as fallback key if _id missing

      showNotification(
        `Loading undriven streets for ${location.display_name}...`,
        "info",
      );
      // --- Add Frontend Logging ---
      console.log(
        `[fetchUndrivenStreets] Sending POST request to /api/undriven_streets with location:`,
        location,
      );
      // --- End Frontend Logging ---

      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(location),
      });

      // --- Add Frontend Logging ---
      console.log(
        `[fetchUndrivenStreets] Received response status: ${response.status}`,
      );
      // --- End Frontend Logging ---

      if (!response.ok) {
        let errorDetail = `HTTP error ${response.status}`;
        try {
          const errorData = await response.json();
          errorDetail = errorData.detail || errorDetail;
        } catch (e) {
          /* ignore */
        }
        throw new Error(errorDetail);
      }

      const geojson = await response.json();
      // --- Add Frontend Logging ---
      console.log(
        "[fetchUndrivenStreets] Received GeoJSON data:",
        JSON.stringify(geojson, null, 2),
      );
      // --- End Frontend Logging ---

      if (!geojson.features || geojson.features.length === 0) {
        // --- Add Frontend Logging ---
        console.log(
          `[fetchUndrivenStreets] No features found in response for ${location.display_name}. Showing notification.`,
        );
        // --- End Frontend Logging ---
        showNotification(
          `No undriven streets found in ${location.display_name}`,
          "info",
        );
      } else {
        // --- Add Frontend Logging ---
        console.log(
          `[fetchUndrivenStreets] Found ${geojson.features.length} features for ${location.display_name}. Updating map.`,
        );
        // --- End Frontend Logging ---
        showNotification(
          `Loaded ${geojson.features.length} undriven street segments`,
          "success",
        );
      }

      // Update map layer data
      await updateMapWithUndrivenStreets(geojson);
      // Explicitly update map rendering
      await updateMap();
      return geojson;
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      showNotification(
        `Failed to load undriven streets: ${error.message}`,
        "danger",
      );
      AppState.mapLayers.undrivenStreets.visible = false;
      // Update map layer data and rendering on error
      AppState.mapLayers.undrivenStreets.layer = {
        type: "FeatureCollection",
        features: [],
      };
      await updateMap();
      return null;
    }
  }

  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      console.warn("Map not ready for update. Operation deferred.");
      return;
    }

    AppState.layerGroup.clearLayers();

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(
        ([, info]) =>
          info.visible &&
          info.layer &&
          (info.layer.features?.length > 0 ||
            info.layer instanceof L.LayerGroup),
      )
      .sort(([, a], [, b]) => a.order - b.order);

    const tripLayers = new Map(); // Cache layers by ID for quick access

    // Use Promise.all for potentially parallel layer processing if needed
    // but keep it sequential for simplicity unless performance demands otherwise
    for (const [name, info] of visibleLayers) {
      if (name === "customPlaces" && info.layer instanceof L.LayerGroup) {
        info.layer.addTo(AppState.layerGroup);
      } else if (["trips", "matchedTrips"].includes(name)) {
        if (info.layer && info.layer.features) {
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info),
            onEachFeature: (feature, layer) => {
              tripLayers.set(feature.properties.transactionId, layer);
              layer.on("click", (e) =>
                handleTripClick(e, feature, layer, info, name),
              );
              layer.on("popupopen", () =>
                setupPopupEventListeners(layer, feature),
              );
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);
        }
      } else if (name === "undrivenStreets" && info.layer?.features) {
        const geoJsonLayer = L.geoJSON(info.layer, {
          style: () => ({
            color: info.color,
            weight: 3,
            opacity: info.opacity,
            className: "undriven-street",
          }),
          onEachFeature: (feature, layer) => {
            if (feature.properties?.street_name) {
              const streetName = feature.properties.street_name;
              const segmentLength =
                feature.properties.segment_length?.toFixed(2) || "Unknown";
              const streetType = feature.properties.highway || "street";
              layer.bindTooltip(
                `<strong>${streetName}</strong><br>Type: ${streetType}<br>Length: ${segmentLength}m`,
                { sticky: true },
              );
            }
          },
        });
        geoJsonLayer.addTo(AppState.layerGroup);
      }
    }

    // Bring selected trip to front after all layers are added
    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      tripLayers.get(AppState.selectedTripId)?.bringToFront();
    }

    if (fitBounds) {
      fitMapBounds(); // Ensure this is called after layers are added
    }

    // Invalidate map size after updates, especially if container changed
    AppState.map.invalidateSize();

    document.dispatchEvent(new CustomEvent("mapUpdated"));
  }

  function handleTripClick(e, feature, layer, info, name) {
    e.originalEvent._stopped = true;
    L.DomEvent.stopPropagation(e);

    const clickedId = feature.properties.transactionId;
    const wasSelected = AppState.selectedTripId === clickedId;

    AppState.selectedTripId = wasSelected ? null : clickedId;
    AppState.layerGroup.eachLayer((l) => l.closePopup && l.closePopup());

    if (!wasSelected) {
      layer
        .bindPopup(createTripPopupContent(feature, name), {
          className: "trip-popup",
          maxWidth: 300,
          autoPan: true,
        })
        .openPopup(e.latlng);
    }

    refreshTripStyles();
    document.dispatchEvent(
      new CustomEvent("tripSelected", {
        detail: {
          id: wasSelected ? null : clickedId,
          tripData: wasSelected ? null : feature.properties,
        },
      }),
    );
  }

  function createTripPopupContent(feature, layerName) {
    const props = feature.properties;
    const isMatched = layerName === "matchedTrips";

    // Normalize trip data
    const tripData = {
      id: props.tripId || props.id || props.transactionId,
      startTime: props.startTime || null,
      endTime: props.endTime || null,
      distance: typeof props.distance === "number" ? props.distance : null,
      maxSpeed:
        props.maxSpeed ||
        props.max_speed ||
        (props.properties &&
          (props.properties.maxSpeed || props.properties.max_speed)) ||
        null,
      averageSpeed:
        props.averageSpeed ||
        props.average_speed ||
        (props.properties &&
          (props.properties.averageSpeed || props.properties.average_speed)) ||
        null,
      startLocation: props.startLocation || null,
      destination: props.destination || null,
      hardBrakingCount: parseInt(props.hardBrakingCount || 0, 10),
      hardAccelerationCount: parseInt(props.hardAccelerationCount || 0, 10),
      totalIdleDurationFormatted: props.totalIdleDurationFormatted || null,
    };

    // Format values for display
    const formatDate = (date) =>
      date
        ? DateUtils.formatForDisplay(date, {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "Unknown";
    const startTimeDisplay = formatDate(tripData.startTime);
    const endTimeDisplay = formatDate(tripData.endTime);
    const distance =
      tripData.distance !== null
        ? `${tripData.distance.toFixed(2)} mi`
        : "Unknown";

    // Calculate duration
    let durationDisplay = "Unknown";
    if (tripData.startTime && tripData.endTime) {
      try {
        const durationMs =
          new Date(tripData.endTime) - new Date(tripData.startTime);
        const hours = Math.floor(durationMs / (1000 * 60 * 60));
        const minutes = Math.floor(
          (durationMs % (1000 * 60 * 60)) / (1000 * 60),
        );
        durationDisplay = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      } catch (e) {
        console.log("Error calculating duration", e);
      }
    }

    // Format speed values
    const formatSpeed = (speed) => {
      if (speed === null || speed === undefined) return "Unknown";
      const speedValue = parseFloat(speed);
      return isNaN(speedValue)
        ? "Unknown"
        : `${(speedValue * 0.621371).toFixed(1)} mph`;
    };

    const maxSpeed = formatSpeed(tripData.maxSpeed);
    const avgSpeed = formatSpeed(tripData.averageSpeed);

    // Create popup content
    let html = `
      <div class="trip-popup">
        <h4>${isMatched ? "Matched Trip" : "Trip"}</h4>
        <table class="popup-data">
          <tr><th>Start Time:</th><td>${startTimeDisplay}</td></tr>
          <tr><th>End Time:</th><td>${endTimeDisplay}</td></tr>
          <tr><th>Duration:</th><td>${durationDisplay}</td></tr>
          <tr><th>Distance:</th><td>${distance}</td></tr>
    `;

    // Add location information if available
    if (tripData.startLocation) {
      const startLocationText =
        typeof tripData.startLocation === "object"
          ? tripData.startLocation.formatted_address || "Unknown location"
          : tripData.startLocation;
      html += `<tr><th>Start Location:</th><td>${startLocationText}</td></tr>`;
    }

    if (tripData.destination) {
      const destinationText =
        typeof tripData.destination === "object"
          ? tripData.destination.formatted_address || "Unknown destination"
          : tripData.destination;
      html += `<tr><th>Destination:</th><td>${destinationText}</td></tr>`;
    }

    // Add speed information
    html += `
      <tr><th>Max Speed:</th><td>${maxSpeed}</td></tr>
      <tr><th>Avg Speed:</th><td>${avgSpeed}</td></tr>
    `;

    // Add idle time if available
    if (tripData.totalIdleDurationFormatted) {
      html += `<tr><th>Idle Time:</th><td>${tripData.totalIdleDurationFormatted}</td></tr>`;
    }

    // Add driving behavior metrics if greater than 0
    if (tripData.hardBrakingCount > 0) {
      html += `<tr><th>Hard Braking:</th><td>${tripData.hardBrakingCount}</td></tr>`;
    }

    if (tripData.hardAccelerationCount > 0) {
      html += `<tr><th>Hard Accel:</th><td>${tripData.hardAccelerationCount}</td></tr>`;
    }

    // Add action buttons
    html += `
        </table>
        <div class="trip-actions" data-trip-id="${tripData.id}">
    `;

    if (isMatched) {
      html += `<button class="btn btn-sm btn-danger delete-matched-trip">Delete Match</button>`;
    } else {
      html += `
          <button class="btn btn-sm btn-primary rematch-trip">Rematch</button>
          <button class="btn btn-sm btn-danger delete-trip">Delete</button>
      `;
    }

    html += `</div></div>`;
    return html;
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

    popupEl.addEventListener("click", handlePopupClick);
    layer.on("popupclose", () =>
      popupEl.removeEventListener("click", handlePopupClick),
    );
  }

  async function handleDeleteMatchedTrip(tripId, layer) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Matched Trip",
          message: "Are you sure you want to delete this matched trip?",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        })
      : confirm("Are you sure you want to delete this matched trip?");

    if (!confirmed) return;

    try {
      const res = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete matched trip");

      layer.closePopup();
      await fetchTrips();
      showNotification("Trip deleted", "success");
    } catch (error) {
      handleError(error, "Deleting Matched Trip");
    }
  }

  async function handleDeleteTrip(tripId, layer) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Trip",
          message:
            "Delete this trip? This will also delete its corresponding matched trip.",
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        })
      : confirm(
          "Delete this trip? This will also delete its corresponding matched trip.",
        );

    if (!confirmed) return;

    try {
      const tripRes = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!tripRes.ok) throw new Error("Failed to delete trip");

      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      } catch (e) {
        console.warn("No matched trip found or failed to delete matched trip");
      }

      layer.closePopup();
      await fetchTrips();
      showNotification("Trip and its matched trip deleted", "success");
    } catch (error) {
      handleError(error, "Deleting Trip and Matched Trip");
    }
  }

  async function handleRematchTrip(tripId, layer, feature) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Re-match Trip",
          message:
            "Re-match this trip? This will delete the existing matched trip and create a new one.",
          confirmText: "Re-match",
          confirmButtonClass: "btn-warning",
        })
      : confirm(
          "Re-match this trip? This will delete the existing matched trip and create a new one.",
        );

    if (!confirmed) return;

    try {
      const deleteRes = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (!deleteRes.ok)
        throw new Error("Failed to delete existing matched trip");

      const startTime = DateUtils.formatDate(feature.properties.startTime);
      const endTime = DateUtils.formatDate(feature.properties.endTime);

      const rematchRes = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startTime,
          end_date: endTime,
          trip_id: tripId,
        }),
      });

      if (!rematchRes.ok) throw new Error("Failed to re-match trip");

      layer.closePopup();
      await fetchTrips();
      showNotification("Trip successfully re-matched", "success");
    } catch (error) {
      handleError(error, "Re-matching Trip");
    }
  }

  function fitMapBounds() {
    if (!AppState.map) return;

    const bounds = L.latLngBounds();
    let validBounds = false;

    Object.values(AppState.mapLayers).forEach((info) => {
      if (!info.visible || !info.layer) return;

      try {
        const layerBounds =
          typeof info.layer.getBounds === "function"
            ? info.layer.getBounds()
            : L.geoJSON(info.layer).getBounds();

        if (layerBounds?.isValid()) {
          bounds.extend(layerBounds);
          validBounds = true;
        }
      } catch (e) {
        // ignore invalid bounds
      }
    });

    if (validBounds) AppState.map.fitBounds(bounds);
  }

  // Map Matching & Metrics
  async function mapMatchTrips() {
    const startDate = DateUtils.formatDate(getStartDate());
    const endDate = DateUtils.formatDate(getEndDate());

    if (!startDate || !endDate) {
      showNotification("Select valid start and end dates.", "warning");
      return;
    }

    const loadingManager = window.loadingManager || {
      startOperation: () => {},
      finish: () => {},
    };

    loadingManager.startOperation("MapMatching", 100);

    try {
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || `HTTP error! status: ${response.status}`,
        );
      }

      const results = await response.json();
      showNotification("Map matching completed for selected trips.", "success");
      await fetchTrips();

      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", {
          detail: { results },
        }),
      );
    } catch (err) {
      handleError(err, "Map Matching");
    } finally {
      loadingManager.finish("MapMatching");
    }
  }

  async function fetchTripsInRange() {
    const startDate = DateUtils.formatDate(getStartDate());
    const endDate = DateUtils.formatDate(getEndDate());

    if (!startDate || !endDate) {
      showNotification("Select valid start and end dates.", "warning");
      return;
    }

    if (window.loadingManager) {
      window.loadingManager.startOperation("FetchTripsRange", 100);
    }

    try {
      const response = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.status === "success") {
        showNotification(data.message, "success");
        await fetchTrips();
      } else {
        throw new Error(data.message || "Error fetching trips");
      }
    } catch (err) {
      handleError(err, "Fetching Trips in Range");
    } finally {
      if (window.loadingManager) {
        window.loadingManager.finish("FetchTripsRange");
      }
    }
  }

  async function fetchMetrics() {
    const startDate = DateUtils.formatDate(getStartDate());
    const endDate = DateUtils.formatDate(getEndDate());
    const imei = getElement("imei")?.value || "";

    if (!startDate || !endDate) return;

    try {
      const response = await fetch(
        `/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`,
      );
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`);

      const metrics = await response.json();
      const metricMap = {
        "total-trips": metrics.total_trips,
        "total-distance": metrics.total_distance,
        "avg-distance": metrics.avg_distance,
        "avg-start-time": metrics.avg_start_time,
        "avg-driving-time": metrics.avg_driving_time,
        "avg-speed": `${metrics.avg_speed} mph`,
        "max-speed": `${metrics.max_speed} mph`,
      };

      for (const [id, value] of Object.entries(metricMap)) {
        const el = getElement(id, false);
        if (el) el.textContent = value;
      }

      document.dispatchEvent(
        new CustomEvent("metricsUpdated", {
          detail: { metrics },
        }),
      );
    } catch (err) {
      handleError(err, "Fetching Metrics");
    }
  }

  // Function to fetch coverage areas for the location dropdown
  async function fetchCoverageAreas() {
    try {
      const response = await fetch("/api/coverage_areas");

      if (!response.ok) {
        throw new Error(
          `HTTP error fetching coverage areas: ${response.status}`,
        );
      }

      const data = await response.json();
      // The server returns the areas in the 'areas' property, not 'coverage_areas'
      return data.areas || [];
    } catch (error) {
      console.error("Error fetching coverage areas:", error);
      showNotification(
        `Failed to load coverage areas: ${error.message}`,
        "warning",
      );
      return [];
    }
  }

  // Function to populate the location dropdown
  async function populateLocationDropdown() {
    const dropdown = document.getElementById("undriven-streets-location");
    if (!dropdown) return;

    // Clear existing options (except the first one)
    while (dropdown.options.length > 1) {
      dropdown.remove(1);
    }

    // Fetch coverage areas
    const coverageAreas = await fetchCoverageAreas();

    if (coverageAreas.length === 0) {
      // Add a disabled option indicating no areas available
      const option = document.createElement("option");
      option.textContent = "No coverage areas available";
      option.disabled = true;
      dropdown.appendChild(option);
      return;
    }

    // Add each coverage area to the dropdown
    coverageAreas.forEach((area) => {
      const option = document.createElement("option");
      option.value = JSON.stringify(area.location);
      option.textContent = area.location.display_name;
      dropdown.appendChild(option);
    });

    // Check if we have a previously selected location
    const savedLocationId = localStorage.getItem(
      "selectedLocationForUndrivenStreets",
    );
    if (savedLocationId) {
      for (let i = 0; i < dropdown.options.length; i++) {
        try {
          const optionLocation = JSON.parse(dropdown.options[i].value);
          if (
            optionLocation &&
            (optionLocation._id === savedLocationId ||
              optionLocation.display_name === savedLocationId)
          ) {
            dropdown.selectedIndex = i;
            // If the undriven streets layer is set to be visible, fetch data now
            if (
              localStorage.getItem(`layer_visible_undrivenStreets`) === "true"
            ) {
              fetchUndrivenStreets();
            }
            break;
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  // Event Listeners & Date Presets
  function initializeEventListeners() {
    addSingleEventListener("controls-toggle", "click", function () {
      const mapControls = getElement("map-controls");
      const controlsContent = getElement("controls-content");

      if (mapControls) {
        mapControls.classList.toggle("minimized");

        if (controlsContent && window.bootstrap?.Collapse) {
          const bsCollapse = bootstrap.Collapse.getInstance(controlsContent);
          if (bsCollapse) {
            mapControls.classList.contains("minimized")
              ? bsCollapse.hide()
              : bsCollapse.show();
          } else {
            new bootstrap.Collapse(controlsContent, {
              toggle: !mapControls.classList.contains("minimized"),
            });
          }
        }
      }

      const icon = this.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-chevron-up");
        icon.classList.toggle("fa-chevron-down");
      }
    });

    addSingleEventListener("map-match-trips", "click", mapMatchTrips);

    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      debouncedUpdateMap();
    });

    // Add event listener for undriven streets location dropdown
    const locationDropdown = document.getElementById(
      "undriven-streets-location",
    );
    if (locationDropdown) {
      locationDropdown.addEventListener("change", function () {
        // If the undriven streets layer is currently visible, refresh it with the new location
        if (AppState.mapLayers.undrivenStreets?.visible) {
          fetchUndrivenStreets();
        }
      });
    }

    // ADD listener for filters applied event from modern-ui.js
    document.addEventListener("filtersApplied", (e) => {
      console.log("Filters applied event received in app.js:", e.detail);
      // Fetch data based on the new filter dates provided by the event or localStorage
      fetchTrips();
      fetchMetrics();
    });
  }

  function initializeDOMCache() {
    AppState.dom.map = getElement("map");
    AppState.dom.layerToggles = getElement("layer-toggles");
    AppState.dom.layerOrder = getElement("layer-order");
    AppState.dom.controlsToggle = getElement("controls-toggle");
    AppState.dom.controlsContent = getElement("controls-content");
    AppState.dom.startDateInput = getElement("start-date");
    AppState.dom.endDateInput = getElement("end-date");
    AppState.dom.applyFiltersBtn = getElement("apply-filters");
    AppState.dom.mapMatchTripsBtn = getElement("map-match-trips");
    AppState.dom.highlightRecentTrips = getElement("highlight-recent-trips");
  }

  function setInitialDates() {
    const today = DateUtils.getCurrentDate();
    if (!getStorageItem(CONFIG.STORAGE_KEYS.startDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.startDate, today);
    }
    if (!getStorageItem(CONFIG.STORAGE_KEYS.endDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.endDate, today);
    }
  }

  function initializeDatePickers() {
    AppState.dom.startDateInput =
      AppState.dom.startDateInput || getElement("start-date");
    AppState.dom.endDateInput =
      AppState.dom.endDateInput || getElement("end-date");

    const storedStartDate =
      getStorageItem(CONFIG.STORAGE_KEYS.startDate) ||
      DateUtils.getCurrentDate();
    const storedEndDate =
      getStorageItem(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const config = {
      maxDate: tomorrow,
      static: false,
      appendTo: document.body,
      theme: document.body.classList.contains("light-mode") ? "light" : "dark",
      position: "auto",
      disableMobile: true,
      onChange: function (selectedDates, dateStr) {
        const input = this.input;
        const formattedDate = DateUtils.formatDate(dateStr);
        const isStartDate = input.id === "start-date";
        const key = isStartDate
          ? CONFIG.STORAGE_KEYS.startDate
          : CONFIG.STORAGE_KEYS.endDate;
        setStorageItem(key, formattedDate);
      },
    };

    AppState.dom.startDatePicker = DateUtils.initDatePicker(
      AppState.dom.startDateInput,
      config,
    );
    AppState.dom.endDatePicker = DateUtils.initDatePicker(
      AppState.dom.endDateInput,
      config,
    );

    if (AppState.dom.startDatePicker) {
      AppState.dom.startDatePicker.setDate(storedStartDate);
    } else if (AppState.dom.startDateInput) {
      AppState.dom.startDateInput.value = storedStartDate;
    }

    if (AppState.dom.endDatePicker) {
      AppState.dom.endDatePicker.setDate(storedEndDate);
    } else if (AppState.dom.endDateInput) {
      AppState.dom.endDateInput.value = storedEndDate;
    }
  }

  function initialize() {
    setInitialDates();
    initializeDOMCache();
    initializeDatePickers();
    initializeEventListeners();

    if (AppState.dom.map && !document.getElementById("visits-page")) {
      initializeMap()
        .then(() => {
          if (!isMapReady()) {
            console.error("Failed to initialize map components");
            showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
            return Promise.reject("Map initialization failed"); // Reject promise on failure
          }

          initializeLayerControls();

          // Load coverage areas for the undriven streets dropdown *before* restoring state
          return populateLocationDropdown(); // Return promise
        })
        .then(() => {
          // Restore layer visibility from localStorage *after* dropdown is populated
          Object.keys(AppState.mapLayers).forEach((layerName) => {
            const savedVisibility = localStorage.getItem(
              `layer_visible_${layerName}`,
            );
            if (savedVisibility === "true") {
              AppState.mapLayers[layerName].visible = true;
              // Update the checkbox state in the UI
              const toggle = document.getElementById(`${layerName}-toggle`);
              if (toggle) toggle.checked = true;

              // Special handling for undrivenStreets - fetch ONLY if a location is selected
              // The selection logic is handled within populateLocationDropdown now
              // No need for setTimeout here anymore, selection triggers fetch
            } else {
              AppState.mapLayers[layerName].visible = false;
              const toggle = document.getElementById(`${layerName}-toggle`);
              if (toggle) toggle.checked = false;
            }
          });
          updateLayerOrderUI(); // Update UI after restoring visibility

          // Initial data fetch based on stored dates (modern-ui handles initial storage)
          return Promise.all([fetchTrips(), fetchMetrics()]);
        })
        .then((results) => {
          if (results) {
            document.dispatchEvent(new CustomEvent("initialDataLoaded"));
          }
        })
        .catch((error) => {
          handleError(error, "Initialization");
        });
    }
  }

  document.addEventListener("DOMContentLoaded", initialize);

  window.addEventListener("beforeunload", () => {
    Object.values(AppState.polling.timers).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    AppState.polling.active = false;
  });

  // Export public API
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.App = {
    fetchTrips,
    updateMap,
    refreshTripStyles,
    updateTripsTable,
    toggleLayer,
    fetchMetrics,
    initializeMap,
    handleError,
    getStartDate,
    getEndDate,
    fitMapBounds,
    mapMatchTrips,
    fetchTripsInRange,
  };
})();
