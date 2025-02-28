/* global L, flatpickr, notificationManager, bootstrap, $, DateUtils */

/**
 * Main application module for Every Street mapping functionality
 */
"use strict";

(function () {
  // ==============================
  // Configuration & Constants
  // ==============================
  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129],
      defaultZoom: 4,
      tileLayerUrls: {
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      },
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours in milliseconds
      debounceDelay: 100,
    },
    REFRESH: {
      minPollingInterval: 1000,
      maxPollDelay: 8000,
    },
    STORAGE_KEYS: {
      startDate: "startDate",
      endDate: "endDate",
      selectedLocation: "selectedLocation",
      sidebarState: "sidebarCollapsed",
    },
    ERROR_MESSAGES: {
      mapInitFailed:
        "Failed to initialize map components. Please refresh the page.",
      fetchTripsFailed: "Error loading trips. Please try again.",
      streetCoverageFailed: "Error calculating street coverage",
      locationValidationFailed: "Location not found. Please check your input.",
    },
  };

  // Default layer configurations
  const LAYER_DEFAULTS = {
    trips: {
      order: 1,
      color: "#BB86FC",
      opacity: 0.4,
      visible: true,
      highlightColor: "#FFD700",
      name: "Trips",
    },
    historicalTrips: {
      order: 2,
      color: "#03DAC6",
      opacity: 0.4,
      visible: false,
      highlightColor: "#FFD700",
      name: "Historical Trips",
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.4,
      visible: false,
      highlightColor: "#40E0D0",
      name: "Matched Trips",
    },
    osmBoundary: {
      order: 4,
      color: "#03DAC6",
      opacity: 0.7,
      visible: false,
      name: "OSM Boundary",
    },
    osmStreets: {
      order: 5,
      color: "#FF0266",
      opacity: 0.7,
      visible: false,
      name: "OSM Streets",
    },
    streetCoverage: {
      order: 6,
      color: "#00FF00",
      opacity: 0.7,
      visible: false,
      name: "Street Coverage",
    },
    customPlaces: {
      order: 7,
      color: "#FF9800",
      opacity: 0.5,
      visible: false,
      name: "Custom Places",
    },
  };

  // ==============================
  // Application State
  // ==============================
  const AppState = {
    dom: {}, // Cached DOM elements
    map: null,
    layerGroup: null,
    liveTracker: null,
    mapInitialized: false,
    selectedTripId: null,
    lastPollingTimestamp: 0,
    mapLayers: { ...LAYER_DEFAULTS },
    mapSettings: { highlightRecentTrips: true },
    polling: {
      timers: {},
      active: false,
    },
  };

  // ==============================
  // DOM Utility Functions
  // ==============================

  /**
   * Safely queries and caches DOM elements for better performance
   * @param {string} selector - CSS selector or ID (with or without #)
   * @param {boolean} [useCache=true] - Whether to use/update cache
   * @param {Document|Element} [context=document] - Query context
   * @returns {Element|null} - Found element or null
   */
  function getElement(selector, useCache = true, context = document) {
    // Check cache first if requested
    if (useCache && AppState.dom[selector]) {
      return AppState.dom[selector];
    }

    // Normalize selector to add # if it's an ID without one
    const normalizedSelector =
      selector.startsWith("#") || selector.includes(" ")
        ? selector
        : `#${selector}`;

    // Query the element
    const element = context.querySelector(normalizedSelector);

    // Cache if requested and found
    if (useCache && element) {
      AppState.dom[selector] = element;
    }

    return element;
  }

  /**
   * Safely shows a notification if notification manager exists
   * @param {string} message - Notification message
   * @param {string} [type="info"] - Notification type (success, info, warning, danger)
   * @returns {boolean} - Whether notification was shown
   */
  function showNotification(message, type = "info") {
    if (
      window.notificationManager &&
      typeof window.notificationManager.show === "function"
    ) {
      window.notificationManager.show(message, type);
      return true;
    }
    // Removed console.log and replaced with notification manager
    if (window.notificationManager) {
      window.notificationManager.show(
        `${type.toUpperCase()}: ${message}`,
        type
      );
    }
    return false;
  }

  /**
   * Returns a debounced version of the provided function
   * @param {Function} func - Function to debounce
   * @param {number} delay - Delay in ms
   * @returns {Function} - Debounced function
   */
  function debounce(func, delay) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(null, args), delay);
    };
  }

  /**
   * Adds an event listener once to prevent duplicates
   * @param {string|Element} element - Element or selector
   * @param {string} eventType - Event type
   * @param {Function} handler - Event handler
   * @returns {boolean} - Whether listener was added
   */
  function addSingleEventListener(element, eventType, handler) {
    // Get element if string was provided
    const el = typeof element === "string" ? getElement(element) : element;
    if (!el) return false;

    // Element data store for tracking attached listeners
    if (!el._eventHandlers) {
      el._eventHandlers = {};
    }

    // Generate unique key based on event type and handler toString
    const handlerFunction = handler.toString();
    const handlerKey = `${eventType}_${handlerFunction.substring(0, 50).replace(/\s+/g, "")}`;

    // Check if same handler already attached for this event type
    if (el._eventHandlers[handlerKey]) {
      return false;
    }

    // Add handler and track it
    el.addEventListener(eventType, handler);
    el._eventHandlers[handlerKey] = handler;

    return true;
  }

  /**
   * Gets a value from localStorage with fallback
   * @param {string} key - Storage key
   * @param {*} [defaultValue=null] - Default value
   * @returns {*} - Stored or default value
   */
  function getStorageItem(key, defaultValue = null) {
    try {
      const value = localStorage.getItem(key);
      return value !== null ? value : defaultValue;
    } catch (e) {
      console.warn(`Error reading from localStorage: ${e.message}`);
      return defaultValue;
    }
  }

  /**
   * Sets a value in localStorage
   * @param {string} key - Storage key
   * @param {*} value - Value to store
   */
  function setStorageItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`Error writing to localStorage: ${e.message}`);
    }
  }

  /**
   * Unified error handler for consistent error handling
   * @param {Error} error - Error object
   * @param {string} context - Error context
   */
  function handleError(error, context) {
    console.error(`Error in ${context}:`, error);
    showNotification(`Error in ${context}: ${error.message}`, "danger");

    // Trigger custom event for error tracking
    document.dispatchEvent(
      new CustomEvent("appError", {
        detail: { context, error: error.message },
      })
    );
  }

  // Debounced functions
  const debouncedUpdateMap = debounce(updateMap, CONFIG.MAP.debounceDelay);

  // ==============================
  // Date & Filter Functions
  // ==============================

  /**
   * Gets the start date from input or localStorage
   * @returns {string} The start date in YYYY-MM-DD format
   */
  function getStartDate() {
    const startDateInput =
      AppState.dom.startDateInput || getElement("start-date");

    // Check input element first
    if (startDateInput?.value) {
      return DateUtils.formatDate(startDateInput.value);
    }

    // Then check localStorage
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.startDate);
    if (storedDate) {
      return DateUtils.formatDate(storedDate);
    }

    // Fallback to current date
    return DateUtils.getCurrentDate();
  }

  /**
   * Gets the end date from input or localStorage
   * @returns {string} The end date in YYYY-MM-DD format
   */
  function getEndDate() {
    const endDateInput = AppState.dom.endDateInput || getElement("end-date");

    // Check input element first
    if (endDateInput?.value) {
      return DateUtils.formatDate(endDateInput.value);
    }

    // Then check localStorage
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.endDate);
    if (storedDate) {
      return DateUtils.formatDate(storedDate);
    }

    // Fallback to current date
    return DateUtils.getCurrentDate();
  }

  /**
   * Creates URL parameters for date filtering
   * @returns {URLSearchParams} The URL parameters
   */
  function getFilterParams() {
    return new URLSearchParams({
      start_date: getStartDate(),
      end_date: getEndDate(),
    });
  }

  /**
   * Updates the date pickers and stores in localStorage
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   */
  function updateDatePickersAndStore(startDate, endDate) {
    const startDateString = DateUtils.formatDate(startDate);
    const endDateString = DateUtils.formatDate(endDate);

    if (!startDateString || !endDateString) {
      console.warn("Invalid date values provided to updateDatePickersAndStore");
      return;
    }

    // Update flatpickr instances if available
    if (AppState.dom.startDateInput?._flatpickr) {
      AppState.dom.startDateInput._flatpickr.setDate(startDateString);
    } else if (AppState.dom.startDateInput) {
      AppState.dom.startDateInput.value = startDateString;
    }

    if (AppState.dom.endDateInput?._flatpickr) {
      AppState.dom.endDateInput._flatpickr.setDate(endDateString);
    } else if (AppState.dom.endDateInput) {
      AppState.dom.endDateInput.value = endDateString;
    }

    // Store in localStorage
    setStorageItem(CONFIG.STORAGE_KEYS.startDate, startDateString);
    setStorageItem(CONFIG.STORAGE_KEYS.endDate, endDateString);
  }

  // ==============================
  // Trip Styling Functions
  // ==============================

  /**
   * Generates styling for trip features
   * @param {Object} feature - GeoJSON feature
   * @param {Object} layerInfo - Layer configuration
   * @returns {Object} Leaflet path style options
   */
  function getTripFeatureStyle(feature, layerInfo) {
    const { properties } = feature;
    const { transactionId, startTime } = properties;

    // Check if trip is recent
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const tripStartTime = new Date(startTime).getTime();
    const isRecent =
      AppState.mapSettings.highlightRecentTrips && tripStartTime > sixHoursAgo;

    // Check if trip is selected or is part of a matched pair
    const isSelected = transactionId === AppState.selectedTripId;
    const isMatchedPair =
      isSelected ||
      (AppState.selectedTripId &&
        transactionId &&
        (AppState.selectedTripId.replace("MATCHED-", "") === transactionId ||
          transactionId.replace("MATCHED-", "") === AppState.selectedTripId));

    // Determine appropriate styling
    let color = layerInfo.color;
    let weight = 2;
    let opacity = layerInfo.opacity;
    let className = "";

    if (isSelected) {
      color = layerInfo.highlightColor;
      weight = 5;
      opacity = 0.9;
      className = "highlighted-trip";
    } else if (isMatchedPair) {
      color =
        layerInfo === AppState.mapLayers.matchedTrips
          ? AppState.mapLayers.matchedTrips.highlightColor
          : AppState.mapLayers.trips.highlightColor;
      weight = 5;
      opacity = 0.9;
      className = "highlighted-matched-trip";
    } else if (isRecent) {
      color = "#FF5722";
      weight = 4;
      opacity = 0.8;
      className = "recent-trip";
    }

    return {
      color,
      weight,
      opacity,
      className,
      zIndexOffset: isSelected || isMatchedPair ? 1000 : 0,
    };
  }

  /**
   * Updates the styling of all trip layers based on the current selection
   */
  function refreshTripStyles() {
    if (!AppState.layerGroup) return;

    AppState.layerGroup.eachLayer((layer) => {
      // Check if this is a GeoJSON layer with features
      if (layer.eachLayer) {
        layer.eachLayer((featureLayer) => {
          // Only process layers with features and style method
          if (featureLayer.feature?.properties && featureLayer.setStyle) {
            const isHistorical =
              featureLayer.feature.properties.imei === "HISTORICAL";
            let layerInfo = isHistorical
              ? AppState.mapLayers.historicalTrips
              : AppState.mapLayers.trips;

            // If this is a matched trip layer
            if (featureLayer.feature.properties.isMatched) {
              layerInfo = AppState.mapLayers.matchedTrips;
            }

            // Update the style based on current selection
            featureLayer.setStyle(
              getTripFeatureStyle(featureLayer.feature, layerInfo)
            );

            // Bring selected trips to front
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

  // ==============================
  // Map Initialization & Controls
  // ==============================

  /**
   * Checks if the map is ready for operations
   * @returns {boolean} - Whether the map is ready
   */
  function isMapReady() {
    return AppState.map && AppState.mapInitialized && AppState.layerGroup;
  }

  /**
   * Initializes the map and base layers
   * @returns {Promise<void>}
   */
  async function initializeMap() {
    const mapContainer = getElement("map");
    if (!mapContainer || AppState.mapInitialized) return;

    try {
      // Make sure the map container is visible
      mapContainer.style.display = "block";
      mapContainer.style.height = "500px";
      mapContainer.style.position = "relative";

      // Determine initial theme
      const theme = document.body.classList.contains("light-mode")
        ? "light"
        : "dark";
      const tileUrl = CONFIG.MAP.tileLayerUrls[theme];

      // Create map instance
      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: true,
        attributionControl: true,
        maxBounds: [
          [-90, -180],
          [90, 180],
        ],
      });

      window.map = AppState.map; // Expose map for external modules

      // Add tile layer with appropriate theme
      L.tileLayer(tileUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        attribution: "",
      }).addTo(AppState.map);

      // Initialize layer groups
      AppState.layerGroup = L.layerGroup().addTo(AppState.map);
      AppState.mapLayers.customPlaces.layer = L.layerGroup();

      // Add map click handler to clear trip selection when clicking outside of any trip
      AppState.map.on("click", (e) => {
        // Only clear if we have a selected trip and we're not clicking on a marker or popup
        if (AppState.selectedTripId && !e.originalEvent._stopped) {
          // Clear the selected trip ID
          AppState.selectedTripId = null;

          // Update trip styles
          refreshTripStyles();
        }
      });

      // Listen for theme changes
      document.addEventListener("themeChanged", (e) => {
        const theme = e.detail?.theme || "dark";
        updateMapTheme(theme);
      });

      // Initialize live trip tracker
      initializeLiveTracker();

      try {
        // Try to center map on last known position
        await centerMapOnLastPosition();
      } catch (error) {
        console.error("Error fetching last trip point:", error);
        AppState.map.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      } finally {
        AppState.mapInitialized = true;

        // Force a resize to fix rendering issues
        setTimeout(() => {
          AppState.map.invalidateSize();
        }, 100);

        // Dispatch event that map is ready
        document.dispatchEvent(new CustomEvent("mapInitialized"));
      }
    } catch (error) {
      handleError(error, "Map Initialization");
    }
  }

  /**
   * Updates the map theme
   * @param {string} theme - Theme name ('light' or 'dark')
   */
  function updateMapTheme(theme) {
    if (!AppState.map) return;

    // First remove existing tile layers
    AppState.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        AppState.map.removeLayer(layer);
      }
    });

    // Add new tile layer based on theme
    const tileUrl =
      CONFIG.MAP.tileLayerUrls[theme] || CONFIG.MAP.tileLayerUrls.dark;

    L.tileLayer(tileUrl, {
      maxZoom: CONFIG.MAP.maxZoom,
      attribution: "",
    }).addTo(AppState.map);

    // Refresh styles for all layers
    refreshTripStyles();

    // Fix rendering issues
    AppState.map.invalidateSize();
  }

  /**
   * Initializes the live trip tracker
   */
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

  /**
   * Centers the map on the last known position
   * @returns {Promise<void>}
   */
  async function centerMapOnLastPosition() {
    try {
      const response = await fetch("/api/last_trip_point");
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();

      if (data.lastPoint && AppState.map) {
        // Fly to the last known point
        AppState.map.flyTo([data.lastPoint[1], data.lastPoint[0]], 11, {
          duration: 2,
          easeLinearity: 0.25,
        });
      } else {
        // Use default position if no last point exists
        AppState.map?.setView([31.55002, -97.123354], 14);
      }
    } catch (error) {
      AppState.map?.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      throw error;
    }
  }

  /**
   * Initializes layer control UI elements
   */
  function initializeLayerControls() {
    const layerToggles = getElement("layer-toggles");
    if (!layerToggles) return;

    layerToggles.innerHTML = "";

    // Create controls for each layer
    Object.entries(AppState.mapLayers).forEach(([name, info]) => {
      const showControls = !["streetCoverage", "customPlaces"].includes(name);
      const displayName = info.name || name;

      // Create layer control div
      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;

      // Add checkbox control
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${info.visible ? "checked" : ""}>
          <span class="checkmark"></span>
        </label>
        <label for="${name}-toggle">${displayName}</label>
      `;

      // Add color picker if needed
      if (showControls) {
        const colorControl = document.createElement("input");
        colorControl.type = "color";
        colorControl.id = `${name}-color`;
        colorControl.value = info.color;
        div.appendChild(colorControl);

        // Add opacity slider
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

    // Use event delegation for layer controls
    addSingleEventListener(layerToggles, "change", handleLayerControlsChange);
    addSingleEventListener(layerToggles, "input", handleLayerControlsInput);

    updateLayerOrderUI();
  }

  /**
   * Handles change events on layer control checkboxes
   * @param {Event} e - The change event
   */
  function handleLayerControlsChange(e) {
    const target = e.target;
    if (target.matches('input[type="checkbox"]')) {
      const layerName = target.id.replace("-toggle", "");
      toggleLayer(layerName, target.checked);
    }
  }

  /**
   * Handles input events on layer control sliders and color pickers
   * @param {Event} e - The input event
   */
  function handleLayerControlsInput(e) {
    const target = e.target;

    if (target.matches('input[type="color"]')) {
      const layerName = target.id.replace("-color", "");
      changeLayerColor(layerName, target.value);
    } else if (target.matches('input[type="range"]')) {
      const layerName = target.id.replace("-opacity", "");
      changeLayerOpacity(layerName, parseFloat(target.value));
    }
  }

  /**
   * Toggles visibility of a map layer
   * @param {string} name - Layer name
   * @param {boolean} visible - Visibility state
   */
  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;

    if (name === "customPlaces" && window.customPlaces) {
      window.customPlaces.toggleVisibility(visible);
    } else {
      debouncedUpdateMap();
    }

    updateLayerOrderUI();

    // Dispatch event for layer visibility change
    document.dispatchEvent(
      new CustomEvent("layerVisibilityChanged", {
        detail: { layer: name, visible },
      })
    );
  }

  /**
   * Changes the color of a map layer
   * @param {string} name - Layer name
   * @param {string} color - Color value
   */
  function changeLayerColor(name, color) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.color = color;
    debouncedUpdateMap();
  }

  /**
   * Changes the opacity of a map layer
   * @param {string} name - Layer name
   * @param {number} opacity - Opacity value (0-1)
   */
  function changeLayerOpacity(name, opacity) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.opacity = opacity;
    debouncedUpdateMap();
  }

  /**
   * Updates the layer order UI
   */
  function updateLayerOrderUI() {
    const layerOrderEl = getElement("layer-order");
    if (!layerOrderEl) return;

    layerOrderEl.innerHTML = '<h4 class="h6">Layer Order</h4>';

    // Get visible layers in order
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible)
      .sort(([, a], [, b]) => b.order - a.order);

    // Create ordered list
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

  /**
   * Initializes drag and drop for layer order
   */
  function initializeDragAndDrop() {
    const list = getElement("layer-order-list");
    if (!list) return;

    let draggedItem = null;

    // Drag start
    list.addEventListener("dragstart", (e) => {
      draggedItem = e.target;
      e.dataTransfer.effectAllowed = "move";

      // Add styling for dragging
      setTimeout(() => {
        draggedItem.classList.add("dragging");
      }, 0);
    });

    // Drag over
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

    // Drag end
    list.addEventListener("dragend", (e) => {
      e.target.classList.remove("dragging");
      updateLayerOrder();
    });
  }

  /**
   * Updates the map layer order from UI
   */
  function updateLayerOrder() {
    const list = getElement("layer-order-list");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("li"));
    const total = items.length;

    // Update layer orders
    items.forEach((item, i) => {
      const layerName = item.dataset.layer;
      if (AppState.mapLayers[layerName]) {
        AppState.mapLayers[layerName].order = total - i;
      }
    });

    debouncedUpdateMap();
  }

  // ==============================
  // API Calls & Map Data Functions
  // ==============================

  /**
   * Safely uses the loading manager with proper cleanup in all cases
   * @param {string} operationId - Unique operation identifier
   * @param {number} [totalWeight=100] - Total progress weight
   * @param {Function} operation - Async operation to perform
   * @param {Object} [subOperations={}] - Sub-operations with weights
   * @returns {Promise<any>} - Operation result
   */
  async function withLoading(
    operationId,
    totalWeight = 100,
    operation,
    subOperations = {}
  ) {
    // Get loading manager or create fallback
    const loadingManager = window.loadingManager || {
      startOperation: () => {},
      addSubOperation: () => {},
      updateSubOperation: () => {},
      finish: () => {},
    };

    try {
      // Start the loading operation
      loadingManager.startOperation(operationId, totalWeight);

      // Add sub-operations if provided
      Object.entries(subOperations).forEach(([name, weight]) => {
        loadingManager.addSubOperation(operationId, name, weight);
      });

      // Execute the operation
      return await operation(loadingManager, operationId);
    } catch (error) {
      // Handle operation error
      handleError(error, operationId);
      throw error;
    } finally {
      // Always finish the loading operation
      loadingManager.finish(operationId);
    }
  }

  /**
   * Fetches trips data and updates the map
   * @returns {Promise<void>}
   */
  async function fetchTrips() {
    return withLoading(
      "Fetching and Displaying Trips",
      100,
      async (loadingManager, opId) => {
        const subOps = {
          "Fetching Data": 50,
          "Processing Data": 30,
          "Displaying Data": 20,
        };

        // Add sub-operations
        Object.entries(subOps).forEach(([name, weight]) => {
          loadingManager.addSubOperation(opId, name, weight);
        });

        // Get dates and ensure they're properly formatted
        const startDate = DateUtils.formatDate(
          getStorageItem(CONFIG.STORAGE_KEYS.startDate)
        );
        const endDate = DateUtils.formatDate(
          getStorageItem(CONFIG.STORAGE_KEYS.endDate)
        );

        if (!startDate || !endDate) {
          showNotification("Invalid date range for fetching trips.", "warning");
          console.warn("Invalid dates selected for fetching trips.");
          return;
        }

        // Update date inputs if they exist
        if (AppState.dom.startDateInput) {
          AppState.dom.startDateInput.value = startDate;
        }
        if (AppState.dom.endDateInput) {
          AppState.dom.endDateInput.value = endDate;
        }

        // Update progress
        loadingManager.updateSubOperation(opId, "Fetching Data", 25);

        // Fetch trip data
        const params = new URLSearchParams({
          start_date: startDate,
          end_date: endDate,
        });

        const response = await fetch(`/api/trips?${params.toString()}`);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const geojson = await response.json();

        // Update progress
        loadingManager.updateSubOperation(opId, "Fetching Data", 50);
        loadingManager.updateSubOperation(opId, "Processing Data", 15);

        // Update trips table and map
        await Promise.all([
          updateTripsTable(geojson),
          updateMapWithTrips(geojson),
        ]);

        // Update progress
        loadingManager.updateSubOperation(opId, "Processing Data", 30);
        loadingManager.updateSubOperation(opId, "Displaying Data", 10);

        // Also fetch matched trips
        try {
          await fetchMatchedTrips();
        } catch (err) {
          handleError(err, "Fetching Matched Trips");
        } finally {
          loadingManager.updateSubOperation(opId, "Displaying Data", 20);
        }

        // Dispatch event that trips are loaded
        document.dispatchEvent(
          new CustomEvent("tripsLoaded", {
            detail: { count: geojson.features.length },
          })
        );
      }
    );
  }

  /**
   * Updates the trips table with fetched data
   * @param {Object} geojson - GeoJSON data from API
   * @returns {Promise<void>}
   */
  async function updateTripsTable(geojson) {
    if (!window.tripsTable) return;

    // Format trips for DataTable
    const formattedTrips = geojson.features
      .filter((trip) => trip.properties.imei !== "HISTORICAL")
      .map((trip) => {
        // Format dates
        const startTimeFormatted = DateUtils.formatForDisplay(
          trip.properties.startTime,
          { dateStyle: "short", timeStyle: "short" }
        );

        const endTimeFormatted = DateUtils.formatForDisplay(
          trip.properties.endTime,
          { dateStyle: "short", timeStyle: "short" }
        );

        return {
          ...trip.properties,
          gps: trip.geometry,
          startTimeFormatted, // Add formatted date for display
          endTimeFormatted, // Add formatted date for display
          startTimeRaw: trip.properties.startTime, // Keep raw date for sorting
          endTimeRaw: trip.properties.endTime, // Keep raw date for sorting
          destination: trip.properties.destination || "N/A",
          startLocation: trip.properties.startLocation || "N/A",
          distance: Number(trip.properties.distance).toFixed(2),
        };
      });

    // Update the table
    return new Promise((resolve) => {
      window.tripsTable.clear().rows.add(formattedTrips).draw();
      setTimeout(resolve, 100);
    });
  }

  /**
   * Updates the map with trips data
   * @param {Object} geojson - GeoJSON data from API
   * @returns {Promise<void>}
   */
  async function updateMapWithTrips(geojson) {
    if (!getElement("map") || !AppState.map || !AppState.layerGroup) return;

    // Separate regular and historical trips
    AppState.mapLayers.trips.layer = {
      type: "FeatureCollection",
      features: geojson.features.filter(
        (f) => f.properties.imei !== "HISTORICAL"
      ),
    };

    AppState.mapLayers.historicalTrips.layer = {
      type: "FeatureCollection",
      features: geojson.features.filter(
        (f) => f.properties.imei === "HISTORICAL"
      ),
    };

    // Update map
    return updateMap();
  }

  /**
   * Fetches matched trips data
   * @returns {Promise<void>}
   */
  async function fetchMatchedTrips() {
    // Get and properly format dates
    const startDate = DateUtils.formatDate(
      getStorageItem(CONFIG.STORAGE_KEYS.startDate)
    );
    const endDate = DateUtils.formatDate(
      getStorageItem(CONFIG.STORAGE_KEYS.endDate)
    );

    if (!startDate || !endDate) {
      console.warn("Invalid date range for fetching matched trips");
      return;
    }

    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });

    const url = `/api/matched_trips?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error fetching matched trips: ${response.status}`);
    }

    const geojson = await response.json();
    AppState.mapLayers.matchedTrips.layer = geojson;
  }

  /**
   * Updates the map with current layer data
   * @param {boolean} [fitBounds=false] - Whether to fit bounds to visible layers
   * @returns {Promise<void>}
   */
  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      console.warn("Map not ready for update. Operation deferred.");
      return;
    }

    // Clear all current layers
    AppState.layerGroup.clearLayers();

    // Get visible layers in order
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => a.order - b.order);

    // Track trip layers for selection
    const tripLayers = new Map();

    // Add each layer to map
    await Promise.all(
      visibleLayers.map(async ([name, info]) => {
        if (["streetCoverage", "customPlaces"].includes(name)) {
          // Direct layers
          info.layer.addTo(AppState.layerGroup);
        } else if (
          ["trips", "historicalTrips", "matchedTrips"].includes(name)
        ) {
          // Trip layers with styling
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info),
            onEachFeature: (feature, layer) => {
              // Store for selection
              tripLayers.set(feature.properties.transactionId, layer);

              // Add click handler
              layer.on("click", (e) =>
                handleTripClick(e, feature, layer, info, name)
              );

              // Setup popup event listeners when opened
              layer.on("popupopen", () =>
                setupPopupEventListeners(layer, feature)
              );
            },
          });

          geoJsonLayer.addTo(AppState.layerGroup);
        } else if (["osmBoundary", "osmStreets"].includes(name)) {
          // OSM layers
          info.layer
            .setStyle({ color: info.color, opacity: info.opacity })
            .addTo(AppState.layerGroup);
        }
      })
    );

    // Bring selected trip to front
    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      tripLayers.get(AppState.selectedTripId)?.bringToFront();
    }

    // Fit bounds if requested
    if (fitBounds) {
      fitMapBounds();
    }

    // Dispatch event that map is updated
    document.dispatchEvent(new CustomEvent("mapUpdated"));
  }

  /**
   * Handles click on a trip feature
   * @param {L.MouseEvent} e - Click event
   * @param {Object} feature - GeoJSON feature
   * @param {L.Layer} layer - Leaflet layer
   * @param {Object} info - Layer info
   * @param {string} name - Layer name
   */
  function handleTripClick(e, feature, layer, info, name) {
    // Stop propagation to prevent the map click handler from triggering
    e.originalEvent._stopped = true;
    L.DomEvent.stopPropagation(e);

    const clickedId = feature.properties.transactionId;
    const wasSelected = AppState.selectedTripId === clickedId;

    // Toggle selection
    AppState.selectedTripId = wasSelected ? null : clickedId;

    // Close all popups
    AppState.layerGroup.eachLayer((l) => l.closePopup && l.closePopup());

    if (!wasSelected) {
      // Create and open popup for the selected trip
      const popupContent = createTripPopupContent(feature, name);

      layer
        .bindPopup(popupContent, {
          className: "trip-popup",
          maxWidth: 300,
          autoPan: true,
        })
        .openPopup(e.latlng);
    }

    // Update styles for all trip layers immediately
    refreshTripStyles();

    // Dispatch event for trip selection
    document.dispatchEvent(
      new CustomEvent("tripSelected", {
        detail: {
          id: wasSelected ? null : clickedId,
          tripData: wasSelected ? null : feature.properties,
        },
      })
    );
  }

  /**
   * Creates popup content for a trip
   * @param {Object} feature - GeoJSON feature
   * @param {string} layerName - Layer name
   * @returns {string} HTML content for popup
   */
  function createTripPopupContent(feature, layerName) {
    const { properties } = feature;
    const {
      startTime,
      endTime,
      timezone = "America/Chicago",
      distance,
      startLocation,
      destination,
      maxSpeed,
      averageSpeed,
      totalIdleDurationFormatted,
      transactionId,
    } = properties;

    // Format dates using DateUtils
    const formattedStart = DateUtils.formatForDisplay(startTime, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
      hour12: true,
    });

    const formattedEnd = DateUtils.formatForDisplay(endTime, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
      hour12: true,
    });

    // Create popup content
    return `
      <div class="trip-popup">
        <h4>Trip Details</h4>
        <p><strong>Start:</strong> ${formattedStart}</p>
        <p><strong>End:</strong> ${formattedEnd}</p>
        <p><strong>Distance:</strong> ${Number(distance).toFixed(2)} miles</p>
        <p><strong>From:</strong> ${startLocation || "Unknown"}</p>
        <p><strong>To:</strong> ${destination || "Unknown"}</p>
        ${maxSpeed ? `<p><strong>Max Speed:</strong> ${Number(maxSpeed).toFixed(1)} mph</p>` : ""}
        ${averageSpeed ? `<p><strong>Avg Speed:</strong> ${Number(averageSpeed).toFixed(1)} mph</p>` : ""}
        ${totalIdleDurationFormatted ? `<p><strong>Idle Time:</strong> ${totalIdleDurationFormatted}</p>` : ""}
        <div class="mt-2">
          ${
            layerName === "trips"
              ? `<button class="btn btn-danger btn-sm me-2 delete-trip" data-trip-id="${transactionId}">Delete Trip</button>`
              : ""
          }
          ${
            layerName === "matchedTrips"
              ? `<button class="btn btn-danger btn-sm me-2 delete-matched-trip" data-trip-id="${transactionId}">Delete Matched Trip</button>
             <button class="btn btn-warning btn-sm rematch-trip" data-trip-id="${transactionId}">Re-match Trip</button>`
              : ""
          }
        </div>
      </div>
    `;
  }

  /**
   * Sets up event listeners for trip popup buttons
   * @param {L.Layer} layer - Leaflet layer with popup
   * @param {Object} feature - GeoJSON feature
   */
  function setupPopupEventListeners(layer, feature) {
    const popupEl = layer.getPopup()?.getElement();
    if (!popupEl) return;

    // Single event handler for all popup buttons using event delegation
    const handlePopupClick = async (e) => {
      // Only process if button was clicked
      if (!e.target.closest("button")) return;

      // Stop propagation to prevent the map click from closing the popup
      e.stopPropagation();
      L.DomEvent.stopPropagation(e);

      const target = e.target.closest("button");
      const tripId = target.dataset.tripId;

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

    // Add a single event listener to the popup
    popupEl.addEventListener("click", handlePopupClick);

    // Clean up when popup is closed
    layer.on("popupclose", () => {
      popupEl.removeEventListener("click", handlePopupClick);
    });
  }

  /**
   * Handles deleting a matched trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @returns {Promise<void>}
   */
  async function handleDeleteMatchedTrip(tripId, layer) {
    if (!window.confirmationDialog) {
      // Fallback to regular confirm
      if (!confirm("Are you sure you want to delete this matched trip?")) {
        return;
      }
    } else {
      const confirmed = await window.confirmationDialog.show({
        title: "Delete Matched Trip",
        message: "Are you sure you want to delete this matched trip?",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;
    }

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

  /**
   * Handles deleting a trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @returns {Promise<void>}
   */
  async function handleDeleteTrip(tripId, layer) {
    let confirmed = false;

    if (!window.confirmationDialog) {
      // Fallback to regular confirm
      confirmed = confirm(
        "Delete this trip? This will also delete its corresponding matched trip."
      );
    } else {
      confirmed = await window.confirmationDialog.show({
        title: "Delete Trip",
        message:
          "Delete this trip? This will also delete its corresponding matched trip.",
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });
    }

    if (!confirmed) return;

    try {
      // Delete trip
      const tripRes = await fetch(`/api/trips/${tripId}`, {
        method: "DELETE",
      });

      if (!tripRes.ok) throw new Error("Failed to delete trip");

      // Try to delete matched trip
      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      } catch (e) {
        // Don't fail if matched trip not found
        console.warn("No matched trip found or failed to delete matched trip");
      }

      layer.closePopup();
      await fetchTrips();

      showNotification("Trip and its matched trip deleted", "success");
    } catch (error) {
      handleError(error, "Deleting Trip and Matched Trip");
    }
  }

  /**
   * Handles rematching a trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @param {Object} feature - GeoJSON feature
   * @returns {Promise<void>}
   */
  async function handleRematchTrip(tripId, layer, feature) {
    let confirmed = false;

    if (!window.confirmationDialog) {
      // Fallback to regular confirm
      confirmed = confirm(
        "Re-match this trip? This will delete the existing matched trip and create a new one."
      );
    } else {
      confirmed = await window.confirmationDialog.show({
        title: "Re-match Trip",
        message:
          "Re-match this trip? This will delete the existing matched trip and create a new one.",
        confirmText: "Re-match",
        confirmButtonClass: "btn-warning",
      });
    }

    if (!confirmed) return;

    try {
      // Delete existing matched trip
      const deleteRes = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });

      if (!deleteRes.ok) {
        throw new Error("Failed to delete existing matched trip");
      }

      // Format dates consistently for API
      const startTime = DateUtils.formatDate(feature.properties.startTime);
      const endTime = DateUtils.formatDate(feature.properties.endTime);

      // Create new matched trip
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

  /**
   * Fits the map bounds to visible layers
   */
  function fitMapBounds() {
    if (!AppState.map) return;

    const bounds = L.latLngBounds();
    let validBounds = false;

    // Add bounds of all visible layers
    Object.values(AppState.mapLayers).forEach((info) => {
      if (!info.visible || !info.layer) return;

      try {
        // Get bounds based on layer type
        const layerBounds =
          typeof info.layer.getBounds === "function"
            ? info.layer.getBounds()
            : L.geoJSON(info.layer).getBounds();

        if (layerBounds?.isValid()) {
          bounds.extend(layerBounds);
          validBounds = true;
        }
      } catch (e) {
        // Ignore errors for invalid bounds
      }
    });

    // Only fit bounds if we have valid data
    if (validBounds) AppState.map.fitBounds(bounds);
  }

  // ==============================
  // Location Validation & OSM Data
  // ==============================

  /**
   * Validates a location input
   * @returns {Promise<void>}
   */
  async function validateLocation() {
    const locInput = getElement("location-input");
    const locType = getElement("location-type");

    if (!locInput || !locType || !locInput.value || !locType.value) {
      showNotification(
        "Please enter a location and select a location type.",
        "warning"
      );
      return;
    }

    try {
      const res = await fetch("/api/validate_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locInput.value,
          locationType: locType.value,
        }),
      });

      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

      const data = await res.json();
      if (!data) {
        showNotification(
          CONFIG.ERROR_MESSAGES.locationValidationFailed,
          "warning"
        );
        return;
      }

      handleLocationValidationSuccess(data, locInput);
      showNotification("Location validated successfully!", "success");
    } catch (err) {
      handleError(err, "Validating Location");
    }
  }

  /**
   * Handles successful location validation
   * @param {Object} data - Location data
   * @param {HTMLElement} locInput - Location input element
   */
  function handleLocationValidationSuccess(data, locInput) {
    // Store the validated location
    window.validatedLocation = data;

    // Update input attributes
    locInput.setAttribute("data-location", JSON.stringify(data));
    locInput.setAttribute(
      "data-display-name",
      data.display_name || data.name || locInput.value
    );

    // Enable relevant buttons
    [
      "generate-boundary",
      "generate-streets",
      "generate-coverage",
      "preprocess-streets",
    ].forEach((id) => {
      const btn = getElement(id);
      if (btn) btn.disabled = false;
    });

    // Dispatch event for other components
    document.dispatchEvent(
      new CustomEvent("locationValidated", {
        detail: { location: data },
      })
    );
  }

  /**
   * Generates OSM data for a location
   * @param {boolean} streetsOnly - Whether to only get streets
   * @returns {Promise<void>}
   */
  async function generateOSMData(streetsOnly) {
    if (!window.validatedLocation) {
      showNotification("Please validate a location first.", "warning");
      return;
    }

    try {
      const res = await fetch("/api/generate_geojson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: window.validatedLocation,
          streetsOnly,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Unknown error generating OSM data");
      }

      const geojson = await res.json();
      if (!geojson || geojson.type !== "FeatureCollection") {
        throw new Error("Invalid GeoJSON data from Overpass");
      }

      // Create layer from the GeoJSON
      const layer = L.geoJSON(geojson, {
        style: {
          color: streetsOnly
            ? AppState.mapLayers.osmStreets.color
            : AppState.mapLayers.osmBoundary.color,
          weight: 2,
          opacity: 0.7,
        },
      });

      // Update the appropriate layer
      if (streetsOnly) {
        AppState.mapLayers.osmStreets.layer = layer;
      } else {
        AppState.mapLayers.osmBoundary.layer = layer;
      }

      // Update the map and UI
      debouncedUpdateMap();
      updateLayerOrderUI();

      showNotification("OSM data generated successfully!", "success");

      // Dispatch event for OSM data generation
      document.dispatchEvent(
        new CustomEvent("osmDataGenerated", {
          detail: { type: streetsOnly ? "streets" : "boundary" },
        })
      );
    } catch (err) {
      handleError(err, "Generating OSM Data");
    }
  }

  // ==============================
  // Map Matching & Metrics
  // ==============================

  /**
   * Initiates map matching for trips
   * @param {boolean} [isHistorical=false] - Whether to include historical trips
   * @returns {Promise<void>}
   */
  async function mapMatchTrips(isHistorical = false) {
    // Get and properly format dates
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

    // Create tasks array
    const tasks = [
      fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      }),
    ];

    // Add historical task if needed
    if (isHistorical) {
      tasks.push(
        fetch("/api/map_match_historical_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date: startDate, end_date: endDate }),
        })
      );
    }

    try {
      // Execute all tasks
      const responses = await Promise.all(tasks);

      // Check for errors
      const errorResponses = responses.filter((response) => !response.ok);
      if (errorResponses.length > 0) {
        const errorData = await errorResponses[0].json();
        throw new Error(
          errorData.message || `HTTP error! status: ${errorResponses[0].status}`
        );
      }

      // Process results
      const results = await Promise.all(responses.map((r) => r.json()));

      showNotification("Map matching completed for selected trips.", "success");

      // Fetch updated trips
      await fetchTrips();

      // Dispatch event for map matching completion
      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", {
          detail: {
            isHistorical,
            results,
          },
        })
      );
    } catch (err) {
      handleError(err, "Map Matching");
    } finally {
      loadingManager.finish("MapMatching");
    }
  }

  /**
   * Fetches trips within the selected date range
   * @returns {Promise<void>}
   */
  async function fetchTripsInRange() {
    // Get and properly format dates
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

  /**
   * Fetches metrics for the selected date range
   * @returns {Promise<void>}
   */
  async function fetchMetrics() {
    // Get and properly format dates
    const startDate = DateUtils.formatDate(getStartDate());
    const endDate = DateUtils.formatDate(getEndDate());
    const imei = getElement("imei")?.value || "";

    if (!startDate || !endDate) return;

    try {
      const response = await fetch(
        `/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const metrics = await response.json();

      // Map metrics to DOM elements
      const metricMap = {
        "total-trips": metrics.total_trips,
        "total-distance": metrics.total_distance,
        "avg-distance": metrics.avg_distance,
        "avg-start-time": metrics.avg_start_time,
        "avg-driving-time": metrics.avg_driving_time,
        "avg-speed": `${metrics.avg_speed} mph`,
        "max-speed": `${metrics.max_speed} mph`,
      };

      // Update all metric elements
      for (const [id, value] of Object.entries(metricMap)) {
        const el = getElement(id, false); // Don't cache these elements
        if (el) el.textContent = value;
      }

      // Dispatch event for metrics update
      document.dispatchEvent(
        new CustomEvent("metricsUpdated", {
          detail: { metrics },
        })
      );
    } catch (err) {
      handleError(err, "Fetching Metrics");
    }
  }

  // ==============================
  // Street Coverage & Polling
  // ==============================

  /**
   * Visualizes street coverage data on the map
   * @param {Object} coverageData - Coverage data
   */
  function visualizeStreetCoverage(coverageData) {
    // Clear existing layer if present
    if (AppState.mapLayers.streetCoverage.layer) {
      AppState.layerGroup.removeLayer(AppState.mapLayers.streetCoverage.layer);
      AppState.mapLayers.streetCoverage.layer = null;
    }

    // Validate data
    if (!coverageData?.streets_data) {
      console.error("Invalid coverage data received");
      return;
    }

    // Create new layer
    AppState.mapLayers.streetCoverage.layer = L.geoJSON(
      coverageData.streets_data,
      {
        style: (feature) => {
          const { driven, coverage_count = 0 } = feature.properties;

          // Style based on driven status and count
          let color, opacity, weight;

          if (driven) {
            // Color gradient based on coverage count
            if (coverage_count >= 10) color = "#004400";
            else if (coverage_count >= 5) color = "#006600";
            else if (coverage_count >= 3) color = "#008800";
            else color = "#00AA00";

            opacity = 0.8;
            weight = 4;
          } else {
            color = "#FF4444";
            opacity = 0.4;
            weight = 3;
          }

          return { color, weight, opacity };
        },
        onEachFeature: (feature, layer) => {
          // Create popup content
          const {
            length,
            street_name,
            driven,
            coverage_count = 0,
            segment_id,
          } = feature.properties;

          const lengthMiles = (length * 0.000621371).toFixed(2);
          const popupContent = `
          <strong>${street_name || "Unnamed Street"}</strong><br>
          Status: ${driven ? "Driven" : "Not driven"}<br>
          Times driven: ${coverage_count}<br>
          Length: ${lengthMiles} miles<br>
          Segment ID: ${segment_id}
        `;

          // Add popup
          layer.bindPopup(popupContent);

          // Add hover effects
          layer.on({
            mouseover: (e) => e.target.setStyle({ weight: 5, opacity: 1 }),
            mouseout: (e) =>
              AppState.mapLayers.streetCoverage.layer.resetStyle(e.target),
          });
        },
      }
    );

    // Add to map
    AppState.mapLayers.streetCoverage.layer.addTo(AppState.layerGroup);
    AppState.mapLayers.streetCoverage.visible = true;

    // Update UI
    updateLayerOrderUI();
    debouncedUpdateMap();

    // Dispatch event for street coverage visualization
    document.dispatchEvent(
      new CustomEvent("streetCoverageVisualized", {
        detail: {
          metadata: coverageData.streets_data.metadata,
        },
      })
    );
  }

  // ==============================
  // Event Listeners & Date Presets
  // ==============================

  /**
   * Handles click on a date preset button
   * @returns {Promise<void>}
   */
  async function handleDatePresetClick() {
    const range = this.dataset.range;
    if (!range) return;

    // Special case for all-time
    if (range === "all-time") {
      const loadingManager = window.loadingManager || {
        startOperation: () => {},
        finish: () => {},
      };

      loadingManager.startOperation("AllTimeDatePreset", 100);

      try {
        const response = await fetch("/api/first_trip_date");

        if (!response.ok) {
          throw new Error(
            `Failed to fetch first trip date: ${response.status}`
          );
        }

        const data = await response.json();
        const firstTripDate = DateUtils.parseDate(data.first_trip_date);
        const today = DateUtils.parseDate(new Date());

        if (firstTripDate && today) {
          updateDatePickersAndStore(firstTripDate, today);
        } else {
          showNotification("Invalid date returned from server", "warning");
        }
      } catch (err) {
        handleError(err, "Fetching First Trip Date");
        showNotification(
          "Error fetching first trip date. Please try again.",
          "danger"
        );
      } finally {
        loadingManager.finish("AllTimeDatePreset");
      }
      return;
    }

    // Use DateUtils for date range presets
    const { startDate, endDate } = DateUtils.getDateRangeForPreset(range);
    updateDatePickersAndStore(startDate, endDate);

    // Dispatch event for date preset selection
    document.dispatchEvent(
      new CustomEvent("datePresetSelected", {
        detail: {
          preset: range,
          startDate: DateUtils.formatDate(startDate),
          endDate: DateUtils.formatDate(endDate),
        },
      })
    );
  }

  /**
   * Initializes all event listeners
   */
  function initializeEventListeners() {
    // Apply filters button
    addSingleEventListener("apply-filters", "click", () => {
      setStorageItem(CONFIG.STORAGE_KEYS.startDate, getStartDate());
      setStorageItem(CONFIG.STORAGE_KEYS.endDate, getEndDate());
      fetchTrips();
      fetchMetrics();
    });

    // Controls toggle
    addSingleEventListener("controls-toggle", "click", function () {
      const mapControls = getElement("map-controls");
      const controlsContent = getElement("controls-content");

      if (mapControls) mapControls.classList.toggle("minimized");

      const icon = this.querySelector("i");
      if (icon) {
        icon.classList.toggle("fa-chevron-up");
        icon.classList.toggle("fa-chevron-down");
      }

      if (controlsContent) {
        controlsContent.style.display = mapControls?.classList.contains(
          "minimized"
        )
          ? "none"
          : "block";
      }
    });

    // Location validation and OSM buttons
    addSingleEventListener("validate-location", "click", validateLocation);
    addSingleEventListener("generate-boundary", "click", () =>
      generateOSMData(false)
    );
    addSingleEventListener("generate-streets", "click", () =>
      generateOSMData(true)
    );

    // Trip processing buttons
    addSingleEventListener("map-match-trips", "click", () =>
      mapMatchTrips(false)
    );
    addSingleEventListener("map-match-historical-trips", "click", () =>
      mapMatchTrips(true)
    );
    addSingleEventListener(
      "generate-coverage",
      "click",
      generateStreetCoverage
    );
    addSingleEventListener("fetch-trips-range", "click", fetchTripsInRange);

    // Date preset buttons
    document.querySelectorAll(".date-preset").forEach((btn) => {
      addSingleEventListener(btn, "click", handleDatePresetClick);
    });

    // Highlight recent trips toggle
    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      debouncedUpdateMap();
    });

    // Streets preprocessing button
    addSingleEventListener("preprocess-streets", "click", () =>
      preprocessStreets()
    );

    // Cancel coverage polling button (if exists)
    addSingleEventListener("cancel-coverage-polling", "click", () => {
      AppState.polling.active = false;
      if (AppState.polling.timers.coverageStatus) {
        clearTimeout(AppState.polling.timers.coverageStatus);
      }
    });
  }

  /**
   * Preprocesses streets for a location for improved route matching and coverage calculation
   * @param {Object} [location] - Location data (defaults to window.validatedLocation)
   * @returns {Promise<void>}
   */
  async function preprocessStreets(location = window.validatedLocation) {
    if (!location) {
      showNotification("Please validate a location first.", "warning");
      return;
    }

    const button = getElement("preprocess-streets");
    const originalText = button?.innerHTML || "Preprocess Streets";

    try {
      // Update button state
      if (button) {
        button.disabled = true;
        button.innerHTML =
          '<span class="spinner-border spinner-border-sm me-1"></span> Processing...';
      }

      // Send request
      const response = await fetch("/api/preprocess_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || `HTTP error! status: ${response.status}`
        );
      }

      const data = await response.json();

      showNotification(
        data.message || "Streets preprocessed successfully for route matching.",
        "success"
      );

      // Dispatch event for streets preprocessing
      document.dispatchEvent(
        new CustomEvent("streetsPreprocessed", {
          detail: { location },
        })
      );
    } catch (error) {
      handleError(error, "Preprocessing Streets");
    } finally {
      // Restore button state
      if (button) {
        button.disabled = false;
        button.innerHTML = originalText;
      }
    }
  }

  /**
   * Initializes DOM cache for better performance
   */
  function initializeDOMCache() {
    // Map elements
    AppState.dom.map = getElement("map");

    // Control elements
    AppState.dom.layerToggles = getElement("layer-toggles");
    AppState.dom.layerOrder = getElement("layer-order");
    AppState.dom.controlsToggle = getElement("controls-toggle");
    AppState.dom.controlsContent = getElement("controls-content");

    // Filter elements
    AppState.dom.startDateInput = getElement("start-date");
    AppState.dom.endDateInput = getElement("end-date");
    AppState.dom.applyFiltersBtn = getElement("apply-filters");

    // Location elements
    AppState.dom.locationInput = getElement("location-input");
    AppState.dom.locationType = getElement("location-type");

    // Button elements
    AppState.dom.validateLocationBtn = getElement("validate-location");
    AppState.dom.generateBoundaryBtn = getElement("generate-boundary");
    AppState.dom.generateStreetsBtn = getElement("generate-streets");
    AppState.dom.generateCoverageBtn = getElement("generate-coverage");
    AppState.dom.mapMatchTripsBtn = getElement("map-match-trips");
    AppState.dom.mapMatchHistoricalBtn = getElement(
      "map-match-historical-trips"
    );
    AppState.dom.preprocessStreetsBtn = getElement("preprocess-streets");
    AppState.dom.highlightRecentTrips = getElement("highlight-recent-trips");
  }

  /**
   * Sets default dates in localStorage if not present
   */
  function setInitialDates() {
    const today = DateUtils.getCurrentDate();

    if (!getStorageItem(CONFIG.STORAGE_KEYS.startDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.startDate, today);
    }

    if (!getStorageItem(CONFIG.STORAGE_KEYS.endDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.endDate, today);
    }
  }

  /**
   * Initializes date picker inputs
   */
  function initializeDatePickers() {
    // Skip if flatpickr is not available
    if (typeof flatpickr !== "function") return;

    // Ensure DOM elements are cached
    AppState.dom.startDateInput =
      AppState.dom.startDateInput || getElement("start-date");
    AppState.dom.endDateInput =
      AppState.dom.endDateInput || getElement("end-date");

    // Get stored dates or use current date
    const storedStartDate =
      getStorageItem(CONFIG.STORAGE_KEYS.startDate) ||
      DateUtils.getCurrentDate();
    const storedEndDate =
      getStorageItem(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

    // Use tomorrow as max date
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const config = {
      dateFormat: "Y-m-d",
      maxDate: tomorrow,
      enableTime: false,
      static: false,
      appendTo: document.body,
      theme: document.body.classList.contains("light-mode") ? "light" : "dark",
      position: "auto",
      disableMobile: true,
      onChange: function (selectedDates, dateStr) {
        const input = this.input;
        if (input) {
          // Validate and normalize the date
          const formattedDate = DateUtils.formatDate(dateStr);
          if (formattedDate) {
            setStorageItem(
              input.id === "start-date"
                ? CONFIG.STORAGE_KEYS.startDate
                : CONFIG.STORAGE_KEYS.endDate,
              formattedDate
            );
          }
        }
      },
    };

    // Initialize flatpickr on both inputs if they exist and aren't already initialized
    if (
      AppState.dom.startDateInput &&
      !AppState.dom.startDateInput._flatpickr
    ) {
      const startConfig = { ...config, defaultDate: storedStartDate };
      flatpickr(AppState.dom.startDateInput, startConfig);
    }

    if (AppState.dom.endDateInput && !AppState.dom.endDateInput._flatpickr) {
      const endConfig = { ...config, defaultDate: storedEndDate };
      flatpickr(AppState.dom.endDateInput, endConfig);
    }
  }

  /**
   * Main initialization function
   */
  function initialize() {
    setInitialDates();
    initializeDOMCache();
    initializeDatePickers();
    initializeEventListeners();

    // Initialize map if on map page
    if (AppState.dom.map && !document.getElementById("visits-page")) {
      initializeMap().then(() => {
        if (!AppState.map || !AppState.layerGroup) {
          console.error("Failed to initialize map components");
          showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
          return;
        }

        initializeLayerControls();

        // Load data
        Promise.all([fetchTrips(), fetchMetrics()]).then(() => {
          // Dispatch event that initial data is loaded
          document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        });

        // Load selected location from storage if exists
        const selectedLocationStr = getStorageItem(
          CONFIG.STORAGE_KEYS.selectedLocation
        );
        if (selectedLocationStr) {
          try {
            const location = JSON.parse(selectedLocationStr);
            window.validatedLocation = location;
            showCoverageForLocation(location).then(() => {
              localStorage.removeItem(CONFIG.STORAGE_KEYS.selectedLocation);
            });
          } catch (error) {
            console.error("Error loading selected location:", error);
          }
        }
      });
    } else {
      // Just fetch metrics if not on map page
      fetchMetrics();
    }

    // Disable buttons until location is validated
    [
      "generate-boundary",
      "generate-streets",
      "generate-coverage",
      "preprocess-streets",
    ].forEach((id) => {
      const btn = getElement(id, false);
      if (btn) btn.disabled = true;
    });
  }

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", initialize);

  // Clean up resources when page is unloaded
  window.addEventListener("beforeunload", () => {
    // Clear all polling timers
    Object.values(AppState.polling.timers).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });

    // Set polling to inactive
    AppState.polling.active = false;
  });

  // Export functions to make them available globally while preserving module pattern
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
    getFilterParams,
    updateDatePickersAndStore,
    generateStreetCoverage,
    fitMapBounds,
    showCoverageForLocation,
    preprocessStreets,
    validateLocation,
    generateOSMData,
    mapMatchTrips,
    fetchTripsInRange,
  };
})();
