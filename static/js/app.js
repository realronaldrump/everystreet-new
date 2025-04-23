/* eslint-disable complexity */
/* global handleError , DateUtils, L, $ */
/* eslint-disable no-unused-vars */ // Keep this if you have variables intentionally unused globally (like AppState itself sometimes)

"use strict";

(function () {
  // Configuration object for map settings, storage keys, and error messages
  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129], // Default map center coordinates (US center)
      defaultZoom: 4, // Default map zoom level
      tileLayerUrls: {
        // URLs for different map tile layers
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
        satellite:
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        streets: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      },
      tileLayerAttribution: {
        // Attribution text for tile layers
        dark: "",
        light: "",
        satellite: "",
        streets: "",
      },
      maxZoom: 19, // Maximum allowed zoom level
      recentTripThreshold: 6 * 60 * 60 * 1000, // Time threshold (6 hours) to highlight recent trips
      debounceDelay: 100, // Delay for debouncing map updates (ms)
    },
    STORAGE_KEYS: {
      // Keys for storing data in localStorage
      startDate: "startDate",
      endDate: "endDate",
      selectedLocation: "selectedLocation",
      sidebarState: "sidebarCollapsed",
    },
    ERROR_MESSAGES: {
      // Standard error messages
      mapInitFailed: "Failed to initialize map. Please refresh the page.",
      fetchTripsFailed: "Error loading trips. Please try again.",
      locationValidationFailed: "Location not found. Please check your input.",
    },
  };

  // Default settings for different map layers
  const LAYER_DEFAULTS = {
    trips: {
      order: 1, // Z-index order
      color: "#BB86FC", // Default line color
      opacity: 0.6, // Default line opacity
      visible: true, // Default visibility
      highlightColor: "#FFD700", // Color when selected/highlighted
      name: "Trips", // Display name
      weight: 2, // Line weight
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

  // Application state object holding map instance, layers, data, etc.
  const AppState = {
    map: null, // Leaflet map instance
    layerGroup: null, // Leaflet layer group for dynamic layers
    mapLayers: { ...LAYER_DEFAULTS }, // Current state of map layers, initialized with defaults
    mapInitialized: false, // Flag indicating if the map has been initialized
    mapSettings: { highlightRecentTrips: true }, // User-configurable map settings
    trips: [], // Array to hold trip data (potentially redundant if layers hold data)
    selectedTripId: null, // ID of the currently selected trip
    polling: {
      // Settings for data polling (if any)
      active: true,
      interval: 5000,
      timers: {},
    },
    dom: {}, // Cache for frequently accessed DOM elements
    baseLayer: null, // Current base tile layer
    geoJsonLayers: {}, // Cache for GeoJSON layer instances
    liveTracker: null, // Instance of LiveTripTracker
  };

  // --- Utility Functions ---

  /**
   * Gets a DOM element using a selector, optionally caching it.
   * @param {string} selector - CSS selector or element ID (auto-prefixed with # if needed).
   * @param {boolean} [useCache=true] - Whether to use the AppState.dom cache.
   * @param {Document|Element} [context=document] - Context to search within.
   * @returns {Element|null} The found element or null.
   */
  const getElement = (selector, useCache = true, context = document) => {
    if (useCache && AppState.dom[selector]) return AppState.dom[selector];

    // Normalize selector to ensure it works with querySelector (e.g., add # for IDs)
    const normalizedSelector =
      selector.startsWith("#") ||
      selector.includes(" ") ||
      selector.startsWith(".")
        ? selector
        : `#${selector}`; // Assume ID if simple string without prefix/space
    try {
      const element = context.querySelector(normalizedSelector);
      if (useCache && element) AppState.dom[selector] = element;
      return element;
    } catch (e) {
      console.error(
        `Error finding element with selector: ${normalizedSelector}`,
        e,
      );
      return null;
    }
  };

  /**
   * Shows a notification using a global notification manager if available.
   * @param {string} message - The message to display.
   * @param {'info'|'success'|'warning'|'danger'} [type='info'] - Notification type.
   * @returns {boolean} True if the notification was shown, false otherwise.
   */
  const showNotification = (message, type = "info") => {
    // Check if a global notification manager exists and has a 'show' method
    if (window.notificationManager?.show) {
      window.notificationManager.show(message, type);
      return true;
    }
    console.warn("Notification Manager not found. Message:", message); // Fallback log
    return false;
  };

  /**
   * Adds an event listener to an element, ensuring it's only added once per handler signature.
   * @param {string|Element} element - Selector string or DOM element.
   * @param {string} eventType - The type of event (e.g., 'click').
   * @param {Function} handler - The event handler function.
   * @returns {boolean} True if the listener was added, false otherwise.
   */
  const addSingleEventListener = (element, eventType, handler) => {
    const el = typeof element === "string" ? getElement(element) : element;
    if (!el) {
      // console.warn(`Element not found for selector/object: ${element}`); // Reduce noise
      return false;
    }

    // Initialize a cache on the element if it doesn't exist
    if (!el._eventHandlers) el._eventHandlers = {};

    // Create a simple key based on event type and handler function (prone to collisions for complex handlers)
    const handlerKey = `${eventType}_${handler
      .toString()
      .substring(0, 50) // Use a portion of the function string
      .replace(/\s+/g, "")}`; // Remove whitespace

    // Check if this specific handler is already attached
    if (el._eventHandlers[handlerKey]) return false; // Already added

    // Add the event listener and store a reference
    el.addEventListener(eventType, handler);
    el._eventHandlers[handlerKey] = handler;
    return true;
  };

  /**
   * Gets an item from localStorage, using a global utility if available.
   * @param {string} key - The storage key.
   * @param {*} [defaultValue=null] - Value to return if key not found.
   * @returns {*} The stored value or the default value.
   */
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

  /**
   * Sets an item in localStorage, using a global utility if available.
   * @param {string} key - The storage key.
   * @param {string} value - The value to store (must be a string).
   * @returns {boolean} True if successful, false otherwise.
   */
  const setStorageItem =
    window.utils?.setStorage ||
    ((key, value) => {
      try {
        localStorage.setItem(key, String(value)); // Ensure value is string
        return true;
      } catch (e) {
        console.warn(`Error writing to localStorage: ${e.message}`);
        return false;
      }
    });

  /** Debounced version of the updateMap function */
  const debouncedUpdateMap = window.utils?.debounce
    ? window.utils.debounce(updateMap, CONFIG.MAP.debounceDelay)
    : updateMap;

  /** Gets the start date from storage or defaults to today */
  const getStartDate = () => {
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.startDate);
    return storedDate
      ? DateUtils.formatDate(storedDate) // Ensure consistent format
      : DateUtils.getCurrentDate();
  };

  /** Gets the end date from storage or defaults to today */
  const getEndDate = () => {
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.endDate);
    return storedDate
      ? DateUtils.formatDate(storedDate) // Ensure consistent format
      : DateUtils.getCurrentDate();
  };

  /**
   * Determines the style for a trip feature based on its properties (recent, selected, matched).
   * @param {object} feature - GeoJSON feature object.
   * @param {object} layerInfo - Configuration info for the layer (color, opacity, etc.).
   * @returns {object} Leaflet path style options.
   */
  const getTripFeatureStyle = (feature, layerInfo) => {
    const { properties } = feature;
    if (!properties)
      return {
        color: layerInfo.color,
        weight: layerInfo.weight,
        opacity: layerInfo.opacity,
      }; // Basic default

    const { transactionId, startTime } = properties;
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const tripStartTime = new Date(startTime).getTime();
    const isRecent =
      AppState.mapSettings.highlightRecentTrips &&
      !isNaN(tripStartTime) && // Check if date is valid
      tripStartTime > sixHoursAgo;
    const isSelected = transactionId === AppState.selectedTripId;

    // Check if this trip or the selected trip is a matched pair
    const isMatchedPair =
      isSelected ||
      (AppState.selectedTripId &&
        transactionId &&
        (AppState.selectedTripId.replace("MATCHED-", "") === transactionId ||
          transactionId.replace("MATCHED-", "") === AppState.selectedTripId));

    // Determine style based on state
    let color = layerInfo.color;
    let weight = layerInfo.weight || 2;
    let opacity = layerInfo.opacity;

    if (isSelected) {
      color = layerInfo.highlightColor || "#FFD700"; // Use specific highlight color
      weight = 3; // Thicker line
      opacity = 1; // Fully opaque
    } else if (isMatchedPair) {
      color = "#03DAC6"; // Teal color for matched pairs
      weight = 2.5;
      opacity = 0.8;
    } else if (isRecent) {
      color = "#FFA500"; // Orange color for recent trips
      weight = 2.5;
      opacity = 0.9;
    }

    return {
      color,
      weight,
      opacity,
      lineCap: "round", // Style for line ends
      lineJoin: "round", // Style for line corners
      className: isRecent ? "recent-trip" : "", // CSS class for potential extra styling
    };
  };

  /** Refreshes the styles of all trip features on the map based on current state. */
  function refreshTripStyles() {
    if (!AppState.layerGroup) return;

    AppState.layerGroup.eachLayer((layer) => {
      // Check if it's a GeoJSON layer added by our app (it should have a feature property)
      if (layer.feature?.properties && typeof layer.setStyle === "function") {
        // Determine if it's a regular or matched trip based on feature properties
        const isMatched =
          layer.feature.properties.isMatched ||
          layer.feature.properties.transactionId?.startsWith("MATCHED-");
        const layerInfo = isMatched
          ? AppState.mapLayers.matchedTrips
          : AppState.mapLayers.trips;

        // Apply the appropriate style
        layer.setStyle(getTripFeatureStyle(layer.feature, layerInfo));

        // Bring the selected trip to the front if it's this layer
        if (
          layer.feature.properties.transactionId === AppState.selectedTripId
        ) {
          layer.bringToFront();
        }
      }
      // Handle potential hit layers (opacity 0) - they don't need visual refresh
      else if (layer.options?.opacity === 0) {
        // Do nothing for hit layers
      }
      // Handle nested LayerGroups if necessary (though current structure might not need it)
      else if (
        layer instanceof L.LayerGroup &&
        typeof layer.eachLayer === "function"
      ) {
        layer.eachLayer((featureLayer) => {
          if (
            featureLayer.feature?.properties &&
            typeof featureLayer.setStyle === "function"
          ) {
            const isMatched =
              featureLayer.feature.properties.isMatched ||
              featureLayer.feature.properties.transactionId?.startsWith(
                "MATCHED-",
              );
            const layerInfo = isMatched
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

  /** Checks if the map is fully initialized and ready for operations. */
  const isMapReady = () =>
    AppState.map && AppState.mapInitialized && AppState.layerGroup;

  /**
   * Initializes the Leaflet map instance and its basic components.
   * async is required here because the caller uses .then()
   * @returns {Promise<boolean>} True if initialization was successful, false otherwise.
   */
  async function initializeMap() {
    try {
      // Prevent re-initialization
      if (AppState.map) return true;

      const mapElement = getElement("map");
      if (!mapElement) {
        showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
        return false;
      }

      // Create the Leaflet map instance
      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: false, // Disable default zoom control (added manually later)
        attributionControl: false, // Disable default attribution (added manually later)
        minZoom: 2,
        maxZoom: CONFIG.MAP.maxZoom,
        zoomSnap: 0.5, // Snap zoom levels to 0.5 increments
        zoomDelta: 0.5, // Amount zoom changes per step
        wheelPxPerZoomLevel: 120, // How many scroll pixels per zoom level
        fadeAnimation: true, // Enable fade animations
        markerZoomAnimation: true, // Enable marker zoom animations
        inertia: true, // Enable map inertia
        worldCopyJump: true, // Allow map to wrap horizontally
      });

      // Make map instance globally accessible (consider avoiding this if possible)
      window.map = AppState.map;

      // Determine the current theme (dark/light) for appropriate tile layer
      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";

      // Select tile layer URL and attribution based on theme
      const tileUrl =
        CONFIG.MAP.tileLayerUrls[theme] || CONFIG.MAP.tileLayerUrls.dark; // Default to dark
      const attribution =
        CONFIG.MAP.tileLayerAttribution[theme] ||
        CONFIG.MAP.tileLayerAttribution.dark;

      // Create and add the base tile layer
      AppState.baseLayer = L.tileLayer(tileUrl, {
        attribution,
        maxZoom: CONFIG.MAP.maxZoom,
        crossOrigin: true, // Necessary for some tile servers
      }).addTo(AppState.map);

      // Add zoom control manually to the top-right
      L.control
        .zoom({
          position: "topright",
        })
        .addTo(AppState.map);

      // Add attribution control manually
      L.control
        .attribution({
          position: "bottomright", // Or your preferred position
          prefix: "", // Optional: Remove Leaflet prefix
        })
        .addTo(AppState.map);
      // Update attribution text
      AppState.map.attributionControl.setPrefix(false); // Remove Leaflet prefix if desired
      AppState.map.attributionControl.addAttribution(attribution);

      // Create the main layer group for trips, etc.
      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      // Define available basemaps for the layer control
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

      // Set the initially active basemap based on the theme
      const defaultBasemap = theme === "light" ? "Light" : "Dark";
      if (basemaps[defaultBasemap]) {
        basemaps[defaultBasemap].addTo(AppState.map);
        AppState.baseLayer = basemaps[defaultBasemap]; // Update AppState.baseLayer reference
      } else {
        basemaps.Dark.addTo(AppState.map); // Fallback to Dark
        AppState.baseLayer = basemaps.Dark;
      }

      // Add the layers control (for switching basemaps)
      L.control
        .layers(basemaps, null, {
          // Pass basemaps, no overlays initially
          position: "topright",
          collapsed: true, // Keep it collapsed by default
        })
        .addTo(AppState.map);

      // Update URL hash with map state (zoom, lat, lng) - debounced
      const debouncedUpdateUrlWithMapState = debounce(
        updateUrlWithMapState,
        200,
      );
      AppState.map.on("zoomend", debouncedUpdateUrlWithMapState);
      AppState.map.on("moveend", debouncedUpdateUrlWithMapState);

      // Dispatch a custom event indicating map initialization is complete
      document.dispatchEvent(new CustomEvent("mapInitialized"));

      AppState.mapInitialized = true;
      console.info("Map initialized successfully.");
      return true;
    } catch (error) {
      // Use global error handler if available
      if (typeof handleError === "function") {
        handleError(error, "Map initialization");
      } else {
        console.error("Map initialization error:", error);
      }
      showNotification(
        `${CONFIG.ERROR_MESSAGES.mapInitFailed}: ${error.message}`,
        "danger",
      );
      return false;
    }
  }

  /** Updates the browser URL's query parameters with the current map state. */
  function updateUrlWithMapState() {
    if (!AppState.map || !window.history || !window.history.replaceState)
      return; // Check for API availability

    try {
      const center = AppState.map.getCenter();
      const zoom = AppState.map.getZoom();
      const lat = center.lat.toFixed(5);
      const lng = center.lng.toFixed(5);

      const url = new URL(window.location.href);
      url.searchParams.set("zoom", zoom);
      url.searchParams.set("lat", lat);
      url.searchParams.set("lng", lng);

      // Replace the current history state without adding a new entry
      window.history.replaceState({}, "", url.toString());
    } catch (error) {
      console.warn("Failed to update URL with map state:", error);
      // Optionally use handleError if it's critical
      // if (typeof handleError === 'function') handleError(error, "Update URL State");
    }
  }

  /** Initializes the LiveTripTracker if available. */
  function initializeLiveTracker() {
    // Check if the tracker library and map are available
    if (!window.LiveTripTracker || !AppState.map) return;

    try {
      // Initialize only if it hasn't been already
      if (!AppState.liveTracker) {
        // Use AppState to track instance
        AppState.liveTracker = new window.LiveTripTracker(AppState.map);
        // window.liveTracker = AppState.liveTracker; // Avoid global if possible, use AppState.liveTracker
        console.info("LiveTripTracker initialized.");
      }
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "LiveTripTracker Initialization");
      } else {
        console.error("LiveTripTracker Initialization error:", error);
      }
    }
  }

  /** Sets up the layer control UI elements (toggles, color pickers, etc.). */
  function initializeLayerControls() {
    const layerToggles = getElement("layer-toggles");
    if (!layerToggles) {
      console.warn("Layer toggles container not found.");
      return;
    }
    // Create UI elements for each layer
    batchLayerControls(layerToggles, AppState.mapLayers);
    // Add event listeners for interaction
    delegateLayerControls(layerToggles);
    // Update the layer order display
    updateLayerOrderUI();

    // --- Prevent map interaction through controls ---
    // Apply to the container holding the toggles and potentially the layer order
    const controlsContainer = getElement("#map-controls-container"); // Assuming a parent container ID
    if (controlsContainer) {
      L.DomEvent.disableClickPropagation(controlsContainer);
      L.DomEvent.disableScrollPropagation(controlsContainer);
      console.info(
        "Disabled click/scroll propagation on map controls container.",
      );
    } else {
      // Apply individually if no single container
      const layerTogglesEl = getElement("#layer-toggles");
      const layerOrderEl = getElement("#layer-order");
      if (layerTogglesEl) {
        L.DomEvent.disableClickPropagation(layerTogglesEl);
        L.DomEvent.disableScrollPropagation(layerTogglesEl); // Also disable scroll/wheel zoom
      }
      if (layerOrderEl) {
        L.DomEvent.disableClickPropagation(layerOrderEl);
        L.DomEvent.disableScrollPropagation(layerOrderEl); // Also disable scroll/wheel zoom
      }
    }
  }

  /**
   * Toggles the visibility of a map layer.
   * @param {string} name - The name of the layer (key in AppState.mapLayers).
   * @param {boolean} visible - The desired visibility state.
   */
  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) {
      console.warn(`Layer info not found for "${name}"`);
      return;
    }

    console.log(`Toggling layer "${name}" to visible: ${visible}`); // Debug log

    layerInfo.visible = visible;
    localStorage.setItem(`layer_visible_${name}`, visible); // Persist visibility state

    // Special handling for specific layers
    if (name === "customPlaces" && window.customPlaces) {
      window.customPlaces.toggleVisibility(visible); // Use dedicated method if available
    } else if (name === "undrivenStreets" && visible) {
      // Fetch data only when layer is turned on, ensure flag is reset if needed
      undrivenStreetsLoaded = false; // Reset flag to allow re-fetch if toggled off/on
      lazyFetchUndrivenStreets();
    } else {
      // For standard layers like trips/matchedTrips, just update the map
      debouncedUpdateMap();
    }

    updateLayerOrderUI(); // Refresh the layer order display

    // Notify other parts of the application about the change
    document.dispatchEvent(
      new CustomEvent("layerVisibilityChanged", {
        detail: { layer: name, visible },
      }),
    );
  }

  /**
   * Changes the color of a map layer.
   * @param {string} name - The layer name.
   * @param {string} color - The new hex color code.
   */
  function changeLayerColor(name, color) {
    if (!AppState.mapLayers[name]) return;
    AppState.mapLayers[name].color = color;
    debouncedUpdateMap(); // Update map to reflect color change
  }

  /**
   * Changes the opacity of a map layer.
   * @param {string} name - The layer name.
   * @param {number} opacity - The new opacity value (0.0 to 1.0).
   */
  function changeLayerOpacity(name, opacity) {
    if (!AppState.mapLayers[name]) return;
    AppState.mapLayers[name].opacity = opacity;
    debouncedUpdateMap(); // Update map to reflect opacity change
  }

  /** Updates the UI element that shows the order of visible layers. */
  function updateLayerOrderUI() {
    const layerOrderEl = getElement("layer-order");
    if (!layerOrderEl) return;

    // Get visible layers that have actual layer data, sorted by current order (descending for top-down UI)
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(
        ([, info]) =>
          info.visible &&
          (info.layer ||
            info === AppState.mapLayers.customPlaces ||
            info.name === "Custom Places"),
      ) // Include customPlaces even if its layer is managed externally
      .sort(([, a], [, b]) => b.order - a.order); // Higher order number means higher up (rendered last/on top)

    // Efficiently update the DOM
    batchLayerOrderUI(layerOrderEl, visibleLayers);
    // Re-initialize drag and drop for the updated list
    initializeDragAndDrop();
  }

  /** Initializes drag and drop functionality for reordering layers in the UI. */
  function initializeDragAndDrop() {
    const list = getElement("layer-order-list"); // Get the list element
    if (!list) return;

    // Ensure propagation is stopped on the list itself for dragging
    L.DomEvent.disableClickPropagation(list);

    let draggedItem = null; // Keep track of the item being dragged

    // Use event delegation on the list container
    addSingleEventListener(list, "dragstart", (e) => {
      // Only act on list items
      if (e.target.tagName === "LI" && e.target.draggable) {
        draggedItem = e.target;
        if (e.dataTransfer) {
          // Check if dataTransfer exists
          e.dataTransfer.effectAllowed = "move";
          // Optionally set drag data (might be needed for some browsers/setups)
          e.dataTransfer.setData("text/plain", e.target.dataset.layer);
        }
        // Add visual cue shortly after drag starts
        setTimeout(() => {
          if (draggedItem) draggedItem.classList.add("dragging");
        }, 0);
      } else {
        e.preventDefault(); // Prevent dragging other elements within the list
      }
    });

    addSingleEventListener(list, "dragover", (e) => {
      e.preventDefault(); // Necessary to allow dropping
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "move"; // Indicate it's a move operation
      }
      const target = e.target.closest("li"); // Find the list item being hovered over
      // Ensure we have a valid target, it's not the item being dragged, and dragging is in progress
      if (target && draggedItem && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        // Determine if dragging over the top or bottom half of the target item
        const midpoint = rect.top + rect.height / 2;
        if (e.clientY > midpoint) {
          // Insert below the target
          list.insertBefore(draggedItem, target.nextSibling);
        } else {
          // Insert above the target
          list.insertBefore(draggedItem, target);
        }
      }
    });

    addSingleEventListener(list, "drop", (e) => {
      e.preventDefault(); // Prevent default drop behavior (like navigating)
      // The actual reordering is handled by dragover, dragend updates the state
      // If data was set in dragstart, you could potentially use it here, but not strictly necessary with current logic
      // const layerName = e.dataTransfer.getData('text/plain');
      // console.log(`Dropped layer: ${layerName}`);
    });

    addSingleEventListener(list, "dragend", (/* e */) => {
      // e is unused
      if (draggedItem) {
        draggedItem.classList.remove("dragging"); // Remove visual cue
        draggedItem = null; // Reset dragged item
        updateLayerOrder(); // Update the actual layer order in AppState
      }
    });
  }

  /** Updates the `order` property in AppState.mapLayers based on the UI list. */
  function updateLayerOrder() {
    const list = getElement("layer-order-list");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("li"));
    const total = items.length;

    // Update the order based on the new sequence in the list (top item gets highest order)
    items.forEach((item, i) => {
      const layerName = item.dataset.layer;
      if (AppState.mapLayers[layerName]) {
        AppState.mapLayers[layerName].order = total - i; // Higher index = lower order number
      }
    });
    console.log("Updated layer order:", AppState.mapLayers); // Debug log
    debouncedUpdateMap(); // Redraw map with new layer order
  }

  /** Fetches trip data from the API based on the selected date range. */
  async function fetchTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification(
        "Invalid date range selected for fetching trips.",
        "warning",
      );
      return;
    }

    // Update date input fields visually (optional)
    if (AppState.dom.startDateInput)
      AppState.dom.startDateInput.value = startDate;
    if (AppState.dom.endDateInput) AppState.dom.endDateInput.value = endDate;

    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
    });

    if (window.loadingManager)
      window.loadingManager.startOperation("FetchTrips", 100);
    try {
      const response = await fetch(`/api/trips?${params.toString()}`);
      window.modernUI?.updateProgress(10, "Fetching trips..."); // Progress update
      if (!response.ok) {
        throw new Error(
          `HTTP error fetching trips: ${response.status} ${response.statusText}`,
        );
      }

      // Use 'let' because it might be reassigned if data is invalid
      let geojson = await response.json();

      // Validate fetched data and provide a default structure if invalid
      if (!geojson || !Array.isArray(geojson.features)) {
        // Check if features is an array
        console.warn(
          "Received invalid GeoJSON data for trips (features missing or not an array).",
        );
        geojson = { type: "FeatureCollection", features: [] }; // Ensure valid structure
      }

      // Update the data table (if it exists)
      if (window.updateTripsTable) {
        // Check if function exists globally or in scope
        await window.updateTripsTable(geojson);
      } else {
        await updateTripsTable(geojson); // Assume it's in scope
      }

      // Update the map layer data
      await updateMapWithTrips(geojson); // Make sure updateMapWithTrips handles async correctly if needed

      // Fetch corresponding matched trips (can run concurrently or sequentially)
      window.modernUI?.updateProgress(60, "Fetching matched trips..."); // Progress update
      try {
        await fetchMatchedTrips(); // Assumes fetchMatchedTrips updates its own layer
      } catch (err) {
        // Use global error handler or log
        if (typeof handleError === "function") {
          handleError(err, "Fetching Matched Trips");
        } else {
          console.error("Error fetching matched trips:", err);
        }
        // Decide if this error should prevent further execution
      }

      // Explicitly trigger a map update after all data fetching/processing
      window.modernUI?.updateProgress(80, "Rendering map..."); // Progress update
      await updateMap();

      // Notify other parts of the app that trips are loaded
      document.dispatchEvent(
        new CustomEvent("tripsLoaded", {
          detail: { count: geojson.features.length },
        }),
      );
      showNotification(`Loaded ${geojson.features.length} trips.`, "success");
      window.modernUI?.updateProgress(100, "Trips loaded!"); // Progress update
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Fetch Trips Main");
      } else {
        console.error("Error in fetchTrips:", error);
      }
      showNotification(CONFIG.ERROR_MESSAGES.fetchTripsFailed, "danger");
    } finally {
      // if (window.loadingManager) window.loadingManager.finish("FetchTrips"); // Removed: Let the event listener handle hiding the overlay
    }
  }

  /**
   * Updates the DataTable with new trip data.
   * @param {object} geojson - GeoJSON FeatureCollection of trips.
   */
  function updateTripsTable(geojson) {
    // Check if the DataTable library and instance are available
    if (!window.tripsTable || !$.fn.DataTable?.isDataTable("#tripsTable")) {
      // console.warn("Trips DataTable not initialized or library not found."); // Reduce noise
      return; // Exit if table doesn't exist or isn't initialized
    }

    // Ensure geojson.features is an array before mapping
    const features = Array.isArray(geojson?.features) ? geojson.features : [];

    // Format trip features for the DataTable
    const formattedTrips = features.map((trip) => {
      const props = trip.properties || {}; // Ensure properties object exists
      const geometry = trip.geometry;

      // Provide defaults for potentially missing properties
      return {
        transactionId: props.transactionId || "N/A",
        imei: props.imei || "N/A",
        startTime: props.startTime, // Keep raw start time if needed elsewhere
        endTime: props.endTime, // Keep raw end time if needed elsewhere
        startTimeFormatted: props.startTime
          ? DateUtils.formatForDisplay(props.startTime, {
              dateStyle: "short",
              timeStyle: "short",
            })
          : "N/A",
        endTimeFormatted: props.endTime
          ? DateUtils.formatForDisplay(props.endTime, {
              dateStyle: "short",
              timeStyle: "short",
            })
          : "N/A",
        duration: props.duration
          ? DateUtils.formatSecondsToHMS(props.duration)
          : "N/A",
        distance:
          typeof props.distance === "number"
            ? props.distance.toFixed(2)
            : "N/A",
        startOdometer: props.startOdometer ?? "N/A",
        endOdometer: props.endOdometer ?? "N/A",
        currentSpeed:
          typeof props.currentSpeed === "number"
            ? props.currentSpeed.toFixed(1)
            : "N/A",
        avgSpeed:
          typeof (props.avgSpeed ?? props.averageSpeed) === "number"
            ? (props.avgSpeed ?? props.averageSpeed).toFixed(1)
            : "N/A",
        maxSpeed:
          typeof props.maxSpeed === "number"
            ? props.maxSpeed.toFixed(1)
            : "N/A",
        pointsRecorded: props.pointsRecorded ?? "N/A",
        totalIdlingTime: props.totalIdlingTime
          ? DateUtils.formatSecondsToHMS(props.totalIdlingTime)
          : "N/A",
        fuelConsumed:
          typeof props.fuelConsumed === "number"
            ? props.fuelConsumed.toFixed(2)
            : "N/A",
        lastUpdate: props.lastUpdate
          ? DateUtils.formatForDisplay(props.lastUpdate, {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : "N/A",
        destination: props.destination || "N/A", // Keep original fallbacks if needed
        startLocation: props.startLocation || "N/A",
        // Include geometry if the table needs it, otherwise omit
        // gps: geometry,
      };
    });

    try {
      // Clear existing data, add new data, and redraw the table
      window.tripsTable.clear().rows.add(formattedTrips).draw(false); // 'false' prevents resetting page
      // console.info(`Trips table updated with ${formattedTrips.length} trips.`); // Reduce noise
    } catch (error) {
      console.error("Error updating DataTable:", error);
      showNotification("Failed to update the trips table.", "danger");
      // Optionally use handleError
      // if (typeof handleError === 'function') handleError(error, "Update Trips Table");
    }
  }

  /**
   * Updates the map layer data for regular trips.
   * @param {object} geojson - GeoJSON FeatureCollection.
   */
  async function updateMapWithTrips(geojson) {
    // Ensure geojson.features is an array
    if (!Array.isArray(geojson?.features)) {
      console.warn("No valid features array found in GeoJSON for trips layer.");
      // Ensure the layer exists even if empty
      AppState.mapLayers.trips.layer = {
        type: "FeatureCollection",
        features: [],
      };
    } else {
      AppState.mapLayers.trips.layer = geojson; // Assign the new data
    }
    // No need to call updateMap here; let the calling function (fetchTrips) handle the final update.
  }

  /**
   * Updates the map layer data for undriven streets.
   * @param {object} geojson - GeoJSON FeatureCollection.
   */
  async function updateMapWithUndrivenStreets(geojson) {
    // Ensure geojson.features is an array
    if (!Array.isArray(geojson?.features)) {
      console.warn(
        "No valid features array found in GeoJSON for undriven streets layer.",
      );
      AppState.mapLayers.undrivenStreets.layer = {
        type: "FeatureCollection",
        features: [],
      };
    } else {
      AppState.mapLayers.undrivenStreets.layer = geojson;
    }
    // No need to call updateMap here; let the calling function (fetchUndrivenStreets) handle the final update.
  }

  /** Fetches matched trip data from the API. */
  function fetchMatchedTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    if (!startDate || !endDate) {
      console.warn("Cannot fetch matched trips without valid dates.");
      return Promise.reject(new Error("Invalid date range for matched trips")); // Return rejected promise
    }
    const url = `/api/matched_trips?start_date=${startDate}&end_date=${endDate}`;

    // Use cachedFetch if appropriate, otherwise standard fetch
    return cachedFetch(url, {}, 60000) // Cache for 60 seconds
      .then((data) => {
        // Ensure data.features is an array
        if (!data || !Array.isArray(data.features)) {
          // console.warn("No valid data received for matched trips."); // Reduce noise
          // Ensure layer exists but is empty
          AppState.mapLayers.matchedTrips.layer = {
            type: "FeatureCollection",
            features: [],
          };
          AppState.mapLayers.matchedTrips.visible =
            localStorage.getItem("layer_visible_matchedTrips") === "true"; // Keep visibility based on toggle
        } else {
          // console.info(`Fetched ${data.features.length} matched trips.`); // Reduce noise
          // Assign data to the layer
          AppState.mapLayers.matchedTrips.layer = data;
          // Keep visibility based on toggle state
          AppState.mapLayers.matchedTrips.visible =
            localStorage.getItem("layer_visible_matchedTrips") === "true";
        }
      })
      .catch((error) => {
        console.error("Error fetching matched trips:", error);
        // Ensure layer exists but is empty on error
        AppState.mapLayers.matchedTrips.layer = {
          type: "FeatureCollection",
          features: [],
        };
        AppState.mapLayers.matchedTrips.visible = false; // Hide on error? Or keep toggle state?
        // Use global error handler
        if (typeof handleError === "function") {
          handleError(error, "Fetch Matched Trips"); // Pass error object
        } else {
          showNotification("Failed to load matched trips.", "danger");
        }
        // Re-throw or return rejected promise to signal failure to caller
        throw error;
      });
  }

  /** Fetches undriven streets data for a selected location. */
  async function fetchUndrivenStreets() {
    let location = null; // Define location outside try block

    try {
      const locationSelect = document.getElementById(
        "undriven-streets-location",
      );
      if (
        !locationSelect ||
        !locationSelect.value ||
        locationSelect.value === ""
      ) {
        // Don't show notification if dropdown is just empty, only if layer is visible
        if (AppState.mapLayers.undrivenStreets?.visible) {
          showNotification(
            "Please select a location from the dropdown to show undriven streets.",
            "warning",
          );
        }
        AppState.mapLayers.undrivenStreets.visible = false; // Ensure layer is marked as not visible
        AppState.mapLayers.undrivenStreets.layer = {
          type: "FeatureCollection",
          features: [],
        }; // Clear data
        await updateMap(); // Update map to remove layer if it was visible
        return null; // Indicate failure or no action taken
      }

      // Parse the selected location value (assuming it's JSON stringified)
      try {
        location = JSON.parse(locationSelect.value);
        // Basic validation of the parsed object
        if (
          !location ||
          typeof location !== "object" ||
          !location.display_name // Check for a key property
        ) {
          throw new Error(
            "Parsed location data is invalid or missing key properties.",
          );
        }
      } catch (parseError) {
        console.error("Error parsing location data from dropdown:", parseError);
        showNotification(
          `Invalid location data selected: ${parseError.message}. Please re-select.`,
          "warning",
        );
        AppState.mapLayers.undrivenStreets.visible = false;
        AppState.mapLayers.undrivenStreets.layer = {
          type: "FeatureCollection",
          features: [],
        };
        await updateMap();
        return null;
      }

      // Store the selected location identifier (e.g., _id or display_name)
      localStorage.setItem(
        "selectedLocationForUndrivenStreets",
        location._id || location.display_name, // Use a reliable identifier
      );

      showNotification(
        `Loading undriven streets for ${location.display_name}...`,
        "info",
      );

      // Make the API request
      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(location), // Send the full location object
      });

      if (!response.ok) {
        let errorDetail = `Failed to load undriven streets (HTTP ${response.status})`;
        try {
          // Try to get more specific error message from response body
          const errorData = await response.json();
          errorDetail = errorData.detail || errorData.message || errorDetail;
        } catch (e) {
          // Ignore if response body is not JSON or empty
        }
        throw new Error(errorDetail);
      }

      const geojson = await response.json();

      // Validate received GeoJSON structure
      if (!geojson || !geojson.type || !Array.isArray(geojson.features)) {
        throw new Error(
          "Invalid GeoJSON structure received for undriven streets.",
        );
      }

      if (geojson.features.length === 0) {
        showNotification(
          `No undriven streets found in the selected area: ${location.display_name}`,
          "info",
        );
      } else {
        showNotification(
          `Loaded ${geojson.features.length} undriven street segments for ${location.display_name}`,
          "success",
        );
      }

      // Update the map layer data
      await updateMapWithUndrivenStreets(geojson);
      // Trigger a final map update
      await updateMap();
      return geojson; // Return the data
    } catch (error) {
      console.error("Error fetching undriven streets:", error);
      if (typeof handleError === "function") {
        handleError(error, "Fetch Undriven Streets");
      } else {
        showNotification(
          `Failed to load undriven streets: ${error.message}`,
          "danger",
        );
      }
      // Reset layer state on error
      AppState.mapLayers.undrivenStreets.visible = false;
      AppState.mapLayers.undrivenStreets.layer = {
        type: "FeatureCollection",
        features: [],
      };
      const toggle = document.getElementById("undrivenStreets-toggle");
      if (toggle) toggle.checked = false; // Uncheck the toggle visually
      await updateMap();
      return null; // Indicate failure
    }
  }

  /**
   * Redraws all visible layers on the map based on current AppState.
   * async is kept for potential future awaits, though none currently exist.
   * @param {boolean} [fitBounds=false] - Whether to adjust map bounds to fit all visible layers.
   */
  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      // console.warn("Map not ready, skipping update."); // Reduce noise
      return;
    }

    // Clear existing dynamic layers (trips, undriven streets, etc.)
    AppState.layerGroup.clearLayers();
    const tripLayers = new Map(); // To keep track of individual trip layers for highlighting

    // Get layers that are visible and have data, sorted by drawing order
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(
        ([name, info]) =>
          info.visible && // Is the layer toggled on?
          ((info.layer &&
            ((Array.isArray(info.layer.features) &&
              info.layer.features.length > 0) ||
              info.layer instanceof L.LayerGroup)) || // Does it have GeoJSON features or is it a LayerGroup?
            (name === "customPlaces" && window.customPlaces?.isVisible())), // Special handling for customPlaces if managed externally
      )
      .sort(([, a], [, b]) => a.order - b.order); // Sort by order (lower first, higher on top)

    // Iterate and add layers to the map's layer group
    for (const [name, info] of visibleLayers) {
      try {
        // Ensure layer data has features before attempting to add
        const features = info.layer?.features;
        const hasFeatures = Array.isArray(features) && features.length > 0;

        if (name === "customPlaces" && window.customPlaces?.getLayerGroup()) {
          // Add the custom places layer group directly if managed externally
          window.customPlaces.getLayerGroup().addTo(AppState.layerGroup);
        } else if (["trips", "matchedTrips"].includes(name) && hasFeatures) {
          // Create/update the GeoJSON layer for trips or matched trips
          const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info), // Dynamic styling
            onEachFeature: (feature, layer) => {
              // Store reference for potential interaction
              if (feature.properties?.transactionId) {
                tripLayers.set(feature.properties.transactionId, layer);
              }
              // Attach click handler
              layer.on("click", (e) => handleTripClick(e, feature, layer));
              // Attach popupopen handler for dynamic content/listeners
              layer.on("popupopen", () =>
                setupPopupEventListeners(layer, feature),
              );
              // Bind the popup content with autoPan disabled
              layer.bindPopup(createTripPopupContent(feature), {
                autoPan: false,
              }); // FIX: Disable auto pan
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);

          // Add invisible wider lines for easier clicking (hit layer)
          const hitLayer = L.geoJSON(info.layer, {
            style: {
              color: "#000000", // Doesn't matter, it's invisible
              opacity: 0, // Invisible
              weight: 20, // Wide for easier clicking/tapping
              interactive: true, // Make it interactive
            },
            onEachFeature: (f, layer) => {
              // Attach click handler to the hit layer as well
              layer.on("click", (e) => handleTripClick(e, f, layer));
              // Bind the same popup with autoPan disabled
              layer.bindPopup(createTripPopupContent(f), { autoPan: false }); // FIX: Disable auto pan
            },
          });
          hitLayer.addTo(AppState.layerGroup);
        } else if (name === "undrivenStreets" && hasFeatures) {
          // Create/update the GeoJSON layer for undriven streets
          const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
            style: () => ({
              // Static style for undriven streets
              color: info.color,
              weight: 3, // Slightly thicker for visibility
              opacity: info.opacity,
              className: "undriven-street", // CSS class for potential styling
            }),
            onEachFeature: (feature, layer) => {
              // Add tooltip with street details if available
              if (feature.properties?.street_name) {
                const props = feature.properties;
                const streetName = props.street_name;
                const segmentLength =
                  typeof props.segment_length === "number"
                    ? props.segment_length.toFixed(2)
                    : "Unknown";
                const streetType = props.highway || "street"; // Use 'highway' tag or default
                layer.bindTooltip(
                  `<strong>${streetName}</strong><br>Type: ${streetType}<br>Length: ${segmentLength}m`,
                  { sticky: true }, // Tooltip follows the mouse
                );
              }
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);
        } else if (info.visible && !hasFeatures && name !== "customPlaces") {
          // Layer is toggled visible but has no features
        }
      } catch (layerError) {
        console.error(`Error processing layer "${name}":`, layerError);
        if (typeof handleError === "function")
          handleError(layerError, `Update Map - Layer ${name}`);
        // Continue processing other layers
      }
    }

    // Bring the selected trip's visible layer to the front
    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      const selectedLayer = tripLayers.get(AppState.selectedTripId);
      if (selectedLayer) {
        selectedLayer.bringToFront();
        // Also bring corresponding hit layer to front? Maybe not necessary if visible layer is on top.
      }
    }

    // Adjust map bounds if requested
    if (fitBounds) {
      fitMapBounds();
    }

    // Ensure map size is correct, especially after container resizes
    AppState.map.invalidateSize();

    // Notify that the map has been updated
    document.dispatchEvent(new CustomEvent("mapUpdated"));
  }

  /**
   * Handles clicks on trip features.
   * @param {L.LeafletMouseEvent} e - The Leaflet event object.
   * @param {object} feature - The clicked GeoJSON feature.
   * @param {L.Layer} layer - The Leaflet layer instance that was clicked (could be visible or hit layer).
   */
  function handleTripClick(e, feature, layer) {
    L.DomEvent.stopPropagation(e); // Prevent click from propagating to map FIRST
    const clickedTripId = feature.properties?.transactionId;

    if (clickedTripId) {
      AppState.selectedTripId = clickedTripId; // Update selected trip ID
      refreshTripStyles(); // Update styles to highlight the selected trip

      // Find the visible layer corresponding to this feature to open the popup on it
      let visibleLayer = null;
      AppState.layerGroup.eachLayer((l) => {
        if (
          l.feature?.properties?.transactionId === clickedTripId &&
          l.options?.opacity > 0 &&
          l.options?.weight > 0
        ) {
          visibleLayer = l;
        }
      });

      // Open popup on the visible layer if found, otherwise fallback to the clicked layer (which might be hit layer)
      const layerToOpenPopupOn = visibleLayer || layer;
      if (
        layerToOpenPopupOn.bindPopup &&
        typeof layerToOpenPopupOn.openPopup === "function"
      ) {
        // Open popup at the location of the click event
        layerToOpenPopupOn.openPopup(e.latlng);
      } else {
        console.warn(
          "Could not find a layer with a popup to open for trip:",
          clickedTripId,
        );
      }

      console.log(`Trip clicked: ${clickedTripId}`);
    } else {
      console.warn("Clicked trip feature missing transactionId.");
    }
  }

  /**
   * Creates action buttons (Delete, Re-match) for the trip popup.
   * @param {object} feature - The GeoJSON feature for the trip.
   * @returns {string} HTML string for the buttons.
   */
  function createActionButtons(feature) {
    const tripId = feature.properties?.transactionId;
    if (!tripId) return ""; // No actions if no ID

    // Check if it's a matched trip (e.g., based on ID prefix or a specific property)
    const isMatched =
      Boolean(feature.properties.matchedTripId) ||
      (typeof tripId === "string" && tripId.startsWith("MATCHED-")); // Added type check for startsWith

    return `
      <div class="trip-actions mt-2" data-trip-id="${tripId}">
        ${
          isMatched
            ? `<button class="btn btn-sm btn-danger delete-matched-trip me-1">Delete Matched</button>
               <button class="btn btn-sm btn-warning rematch-trip">Re-match</button>`
            : `<button class="btn btn-sm btn-danger delete-trip">Delete Trip</button>`
        }
      </div>
    `;
  }

  /**
   * Creates the HTML content for a trip's popup.
   * @param {object} feature - The GeoJSON feature.
   * @returns {string} HTML string for the popup.
   */
  function createTripPopupContent(feature) {
    const props = feature.properties || {}; // Ensure props exist

    // Helper for formatting, returns 'N/A' if value is null/undefined
    const format = (value, formatter) =>
      value != null ? formatter(value) : "N/A";
    const formatNum = (value, digits = 1) =>
      format(value, (v) => parseFloat(v).toFixed(digits));
    const formatTime = (value) =>
      format(value, (v) =>
        DateUtils.formatForDisplay(v, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      );
    const formatDuration = (value) =>
      format(value, (v) => DateUtils.formatSecondsToHMS(v));

    // Use regular string literal as there's no interpolation needed here
    const detailsHtml =
      "<h4>Trip Details</h4>" +
      '<table class="table table-sm table-borderless table-dark popup-data small mb-0">' + // Added Bootstrap table classes
      "<tbody>" +
      `<tr><th scope="row" class="fw-bold">Trip ID</th><td>${props.transactionId || "N/A"}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">IMEI</th><td>${props.imei || "N/A"}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Start Time</th><td>${formatTime(props.startTime)}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">End Time</th><td>${formatTime(props.endTime)}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Duration</th><td>${formatDuration(props.duration)}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Distance</th><td>${formatNum(props.distance, 2)} mi</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Avg Speed</th><td>${formatNum(props.avgSpeed ?? props.averageSpeed)} mph</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Max Speed</th><td>${formatNum(props.maxSpeed)} mph</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Points Recorded</th><td>${props.pointsRecorded ?? "N/A"}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Idling Time</th><td>${formatDuration(props.totalIdleDuration)}</td></tr>` +
      `<tr><th scope="row" class="fw-bold">Fuel Consumed</th><td>${formatNum(props.fuelConsumed, 2)} gal</td></tr>` +
      "</tbody>" +
      "</table>";

    return `
      <div class="popup-content trip-popup bg-dark text-light p-1 rounded"> ${/* Added basic styling */ ""}
        ${detailsHtml}
        <div class="popup-actions border-top border-secondary pt-1 mt-1"> ${/* Separator */ ""}
          ${createActionButtons(feature)}
        </div>
      </div>
    `;
  }

  /**
   * Sets up event listeners for action buttons within an open popup.
   * @param {L.Layer} layer - The layer whose popup is open.
   * @param {object} feature - The GeoJSON feature associated with the popup.
   */
  function setupPopupEventListeners(layer, feature) {
    const popupEl = layer.getPopup()?.getElement(); // Get the popup's DOM element
    if (!popupEl) return; // Exit if popup element not found

    // Define the handler function for clicks within the popup
    const handlePopupClick = async (e) => {
      const target = e.target.closest("button"); // Find the clicked button
      if (!target) return; // Exit if click was not on a button

      e.stopPropagation(); // Prevent click from closing popup or propagating to map
      L.DomEvent.stopPropagation(e); // Leaflet specific stop propagation

      const tripId = target.closest(".trip-actions")?.dataset.tripId;
      if (!tripId) return; // Exit if trip ID not found on parent container

      // Determine which action button was clicked
      if (target.classList.contains("delete-matched-trip")) {
        e.preventDefault(); // Prevent default button behavior
        await handleDeleteMatchedTrip(tripId, layer);
      } else if (target.classList.contains("delete-trip")) {
        e.preventDefault();
        await handleDeleteTrip(tripId, layer);
      } else if (target.classList.contains("rematch-trip")) {
        e.preventDefault();
        await handleRematchTrip(tripId, layer, feature);
      }
    };

    // Add the event listener to the popup element
    // Use addSingleEventListener to prevent duplicates if popup re-opens quickly
    addSingleEventListener(popupEl, "click", handlePopupClick);

    // Clean up the event listener when the popup closes
    layer.once("popupclose", () => {
      // Use 'once' to ensure it only runs once per close
      if (popupEl && popupEl._eventHandlers) {
        const handlerKey = `click_${handlePopupClick.toString().substring(0, 50).replace(/\s+/g, "")}`;
        popupEl.removeEventListener("click", handlePopupClick);
        delete popupEl._eventHandlers[handlerKey]; // Clean up cache
      }
    });
  }

  /**
   * Handles the deletion of a matched trip.
   * @param {string} tripId - The ID of the matched trip to delete.
   * @param {L.Layer} layer - The layer associated with the popup (to close it).
   */
  async function handleDeleteMatchedTrip(tripId, layer) {
    // Use confirmation dialog if available, otherwise use standard confirm
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Matched Trip",
          message: `Are you sure you want to delete matched trip ${tripId}? The original trip will remain.`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        })
      : confirm(`Are you sure you want to delete matched trip ${tripId}?`); // Fallback confirm

    if (!confirmed) return; // Abort if user cancels

    if (window.loadingManager)
      window.loadingManager.startOperation("DeleteMatchedTrip", 100);
    try {
      const res = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        let errorMsg = `Failed to delete matched trip ${tripId}`;
        try {
          const errData = await res.json();
          errorMsg += `: ${errData.detail || errData.message || res.statusText}`;
        } catch (_) {
          /* Ignore if response is not JSON */
        }
        throw new Error(errorMsg);
      }

      layer.closePopup(); // Close the popup
      await fetchTrips(); // Refresh all trip data
      showNotification(
        `Matched trip ${tripId} deleted successfully.`,
        "success",
      );
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Deleting Matched Trip");
      } else {
        console.error("Error deleting matched trip:", error);
        showNotification(
          `Error deleting matched trip: ${error.message}`,
          "danger",
        );
      }
    } finally {
      if (window.loadingManager)
        window.loadingManager.finish("DeleteMatchedTrip");
    }
  }

  /**
   * Handles the deletion of an original trip (and its corresponding matched trip).
   * @param {string} tripId - The ID of the original trip.
   * @param {L.Layer} layer - The layer associated with the popup.
   */
  async function handleDeleteTrip(tripId, layer) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Delete Original Trip",
          message: `Delete original trip ${tripId}? This will ALSO delete its corresponding matched trip, if one exists. This action cannot be undone.`,
          confirmText: "Delete Both",
          confirmButtonClass: "btn-danger",
        })
      : confirm(
          // Fallback confirm
          `Delete original trip ${tripId}? This will also delete its matched trip. Are you sure?`,
        );

    if (!confirmed) return;

    if (window.loadingManager)
      window.loadingManager.startOperation("DeleteTrip", 100);
    try {
      // Attempt to delete the original trip first
      const tripRes = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!tripRes.ok) {
        let errorMsg = `Failed to delete original trip ${tripId}`;
        try {
          const errData = await tripRes.json();
          errorMsg += `: ${errData.detail || errData.message || tripRes.statusText}`;
        } catch (_) {
          /* Ignore */
        }
        // Decide if we should proceed to delete matched trip even if original fails
        console.warn(errorMsg); // Log warning but proceed
        // throw new Error(errorMsg); // Alternatively, stop here
      }

      // Attempt to delete the matched trip (ignore if it doesn't exist or fails)
      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
        // No error handling needed here, it's best effort
      } catch (_) {
        console.warn(
          `Could not delete potential matched trip for ${tripId} (might not exist).`,
        );
      }

      layer.closePopup();
      await fetchTrips(); // Refresh data
      showNotification(
        `Trip ${tripId} (and its matched trip, if any) deleted.`,
        "success",
      );
    } catch (error) {
      // Catch error from deleting original trip if thrown
      if (typeof handleError === "function") {
        handleError(error, "Deleting Trip and Matched Trip");
      } else {
        console.error("Error deleting trip:", error);
        showNotification(`Error deleting trip: ${error.message}`, "danger");
      }
    } finally {
      if (window.loadingManager) window.loadingManager.finish("DeleteTrip");
    }
  }

  /**
   * Handles the re-matching of a trip (deletes existing matched, triggers new match).
   * @param {string} tripId - The ID of the trip to re-match.
   * @param {L.Layer} layer - The layer associated with the popup.
   * @param {object} feature - The GeoJSON feature of the trip.
   */
  async function handleRematchTrip(tripId, layer, feature) {
    const confirmed = window.confirmationDialog
      ? await window.confirmationDialog.show({
          title: "Re-match Trip",
          message: `Re-match trip ${tripId}? This will delete the existing matched trip data and attempt to generate a new one based on the original trip points.`,
          confirmText: "Re-match",
          confirmButtonClass: "btn-warning",
        })
      : confirm(
          // Fallback confirm
          `Re-match trip ${tripId}? This deletes the current matched version.`,
        );

    if (!confirmed) return;

    if (!feature.properties?.startTime || !feature.properties?.endTime) {
      showNotification(
        "Cannot re-match: Trip is missing start or end time.",
        "warning",
      );
      return;
    }

    if (window.loadingManager)
      window.loadingManager.startOperation("RematchTrip", 100);
    try {
      // 1. Delete the existing matched trip (best effort)
      try {
        const deleteRes = await fetch(`/api/matched_trips/${tripId}`, {
          method: "DELETE",
        });
        if (!deleteRes.ok && deleteRes.status !== 404) {
          // Ignore 404 Not Found
          console.warn(
            `Failed to delete existing matched trip ${tripId} before re-match (status: ${deleteRes.status}). Proceeding anyway.`,
          );
        }
      } catch (deleteError) {
        console.warn(
          "Error occurred while deleting existing matched trip:",
          deleteError,
        );
      }

      // 2. Trigger the re-match process for the specific trip ID
      // const startTime = DateUtils.formatDate(feature.properties.startTime); // Ensure correct format if needed by API
      // const endTime = DateUtils.formatDate(feature.properties.endTime);

      const rematchRes = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // API might expect dates or just the ID
          // start_date: startTime,
          // end_date: endTime,
          trip_id: tripId, // Send the specific trip ID to rematch
        }),
      });

      if (!rematchRes.ok) {
        let errorMsg = `Failed to re-match trip ${tripId}`;
        try {
          const errData = await rematchRes.json();
          errorMsg += `: ${errData.detail || errData.message || rematchRes.statusText}`;
        } catch (_) {
          /* Ignore */
        }
        throw new Error(errorMsg);
      }

      const result = await rematchRes.json(); // Get result message if any

      layer.closePopup();
      await fetchTrips(); // Refresh data to show the new matched trip
      showNotification(
        result.message || `Trip ${tripId} successfully re-matched.`,
        "success",
      );
    } catch (error) {
      if (typeof handleError === "function") {
        handleError(error, "Re-matching Trip");
      } else {
        console.error("Error re-matching trip:", error);
        showNotification(`Error re-matching trip: ${error.message}`, "danger");
      }
    } finally {
      if (window.loadingManager) window.loadingManager.finish("RematchTrip");
    }
  }

  /** Adjusts the map view to fit the bounds of all visible layers. */
  function fitMapBounds() {
    if (!AppState.map) return;

    const bounds = L.latLngBounds(); // Create empty bounds object
    let validBoundsExist = false; // Flag to track if any valid bounds were found

    // Iterate through all potentially visible layers
    Object.values(AppState.mapLayers).forEach((info) => {
      // Check if layer is visible and has data
      if (!info.visible || !info.layer) return;

      try {
        let layerBounds = null;
        // Get bounds differently depending on layer type
        if (typeof info.layer.getBounds === "function") {
          // Standard Leaflet layers (GeoJSON, TileLayer, etc.)
          layerBounds = info.layer.getBounds();
        } else if (info.layer.type === "FeatureCollection") {
          // Plain GeoJSON object, create temporary layer to get bounds
          if (info.layer.features && info.layer.features.length > 0) {
            layerBounds = L.geoJSON(info.layer).getBounds();
          }
        }
        // Special handling for custom places if needed
        else if (
          info === AppState.mapLayers.customPlaces &&
          window.customPlaces?.getBounds
        ) {
          layerBounds = window.customPlaces.getBounds();
        }

        // If valid bounds were obtained, extend the main bounds object
        if (layerBounds?.isValid()) {
          bounds.extend(layerBounds);
          validBoundsExist = true;
        }
      } catch (_) {
        // Removed unused 'e'
        // Ignore errors during bounds calculation for a single layer
        // console.warn(`Could not get bounds for layer: ${info.name || 'Unnamed'}`); // Reduce noise
      }
    });

    // Fit the map to the calculated bounds if any valid bounds were found
    if (validBoundsExist) {
      // console.info("Fitting map bounds to visible layers."); // Reduce noise
      AppState.map.fitBounds(bounds, { padding: [30, 30] }); // Add some padding
    } else {
      // console.info("No valid bounds found for visible layers, not fitting bounds."); // Reduce noise
    }
  }

  /** Triggers the map matching process for trips within the selected date range. */
  async function mapMatchTrips() {
    const startDate = getStartDate(); // Use formatted date from getter
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification(
        "Please select valid start and end dates before map matching.",
        "warning",
      );
      return;
    }

    // Use loading manager if available
    const loadingManager = window.loadingManager || {
      startOperation: () => {}, // Empty stub
      finish: () => {}, // Empty stub
    };

    loadingManager.startOperation("MapMatching", 100);
    showNotification(
      `Starting map matching for trips between ${startDate} and ${endDate}...`,
      "info",
    );

    try {
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        let errorData = {
          message: `Map matching failed (HTTP ${response.status})`,
        };
        try {
          errorData = await response.json();
        } catch (_) {
          /* Ignore if response not JSON */
        }
        throw new Error(
          errorData.detail ||
            errorData.message ||
            `HTTP error! status: ${response.status}`,
        );
      }

      const results = await response.json();
      showNotification(
        results.message || "Map matching process completed.",
        "success",
      );
      await fetchTrips(); // Refresh trips to show newly matched ones

      // Dispatch event for other components if needed
      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", {
          detail: { results }, // Pass results if they contain useful info
        }),
      );
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Map Matching");
      } else {
        console.error("Map Matching error:", err);
        showNotification(`Map matching failed: ${err.message}`, "danger");
      }
    } finally {
      loadingManager.finish("MapMatching");
    }
  }

  /** Fetches raw trip data from an external source for the selected date range. */
  async function fetchTripsInRange() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      showNotification(
        "Select valid start and end dates before fetching.",
        "warning",
      );
      return;
    }

    if (window.loadingManager)
      window.loadingManager.startOperation("FetchTripsRange", 100);
    showNotification(
      `Fetching raw trip data between ${startDate} and ${endDate}...`,
      "info",
    );

    try {
      const response = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        let errorData = {
          message: `Fetching trips failed (HTTP ${response.status})`,
        };
        try {
          errorData = await response.json();
        } catch (_) {
          /* Ignore */
        }
        throw new Error(
          errorData.detail ||
            errorData.message ||
            `HTTP error! status: ${response.status}`,
        );
      }

      const data = await response.json();

      if (data.status === "success") {
        showNotification(
          data.message || "Successfully fetched raw trip data.",
          "success",
        );
        await fetchTrips(); // Refresh the displayed trips after fetching raw data
      } else {
        // Throw error if status is not success, using message from response
        throw new Error(
          data.message || "An unknown error occurred while fetching trips.",
        );
      }
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Fetching Trips in Range");
      } else {
        console.error("Error fetching trips in range:", err);
        showNotification(`Error fetching trip data: ${err.message}`, "danger");
      }
    } finally {
      if (window.loadingManager)
        window.loadingManager.finish("FetchTripsRange");
    }
  }

  /** Fetches and displays summary metrics for the selected date range and IMEI. */
  async function fetchMetrics() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    // Get IMEI value safely, default to empty string if element not found
    const imei = getElement("imei")?.value || "";

    if (!startDate || !endDate) {
      // console.warn("Cannot fetch metrics without valid dates."); // Reduce noise
      return; // Don't proceed without dates
    }

    try {
      // Construct URL with query parameters
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      if (imei) {
        // Only add IMEI if it has a value
        params.append("imei", imei);
      }

      // Use cachedFetch for metrics, maybe with shorter cache time
      const metrics = await cachedFetch(
        `/api/metrics?${params.toString()}`,
        {},
        30000,
      ); // Cache for 30s

      if (!metrics) {
        throw new Error("Received no data for metrics.");
      }

      // Map API response keys to DOM element IDs
      const metricMap = {
        "total-trips": metrics.total_trips ?? "N/A",
        "total-distance":
          typeof metrics.total_distance === "number"
            ? `${metrics.total_distance.toFixed(2)} mi`
            : "N/A",
        "avg-distance":
          typeof metrics.avg_distance === "number"
            ? `${metrics.avg_distance.toFixed(2)} mi`
            : "N/A",
        "avg-start-time": metrics.avg_start_time ?? "N/A", // Assuming this is pre-formatted
        "avg-driving-time": metrics.avg_driving_time ?? "N/A", // Assuming this is pre-formatted
        "avg-speed":
          typeof metrics.avg_speed === "number"
            ? `${metrics.avg_speed.toFixed(1)} mph`
            : "N/A",
        "max-speed":
          typeof metrics.max_speed === "number"
            ? `${metrics.max_speed.toFixed(1)} mph`
            : "N/A",
      };

      // Update DOM elements with metric values
      for (const [id, value] of Object.entries(metricMap)) {
        const el = getElement(id, false); // Don't cache metric elements if they might be recreated
        if (el) {
          el.textContent = value;
        } else {
          // console.warn(`Metric element with ID "${id}" not found.`);
        }
      }

      // Dispatch event for other components
      document.dispatchEvent(
        new CustomEvent("metricsUpdated", {
          detail: { metrics },
        }),
      );
      // console.info("Metrics updated."); // Reduce noise
    } catch (err) {
      if (typeof handleError === "function") {
        handleError(err, "Fetching Metrics");
      } else {
        console.error("Error fetching metrics:", err);
      }
      showNotification(`Failed to load metrics: ${err.message}`, "warning");
    }
  }

  /** Fetches available coverage area definitions from the API. */
  async function fetchCoverageAreas() {
    try {
      // Use cache, coverage areas likely don't change often
      const data = await cachedFetch("/api/coverage_areas", {}, 300000); // Cache for 5 minutes
      // Return the areas array, defaulting to empty if structure is wrong
      return data?.areas || [];
    } catch (error) {
      console.error("Error fetching coverage areas:", error);
      showNotification(
        `Failed to load coverage areas: ${error.message}`,
        "warning",
      );
      if (typeof handleError === "function")
        handleError(error, "Fetch Coverage Areas");
      return []; // Return empty array on error
    }
  }

  /** Populates the location dropdown for undriven streets with fetched coverage areas. */
  async function populateLocationDropdown() {
    const dropdown = document.getElementById("undriven-streets-location");
    if (!dropdown) {
      console.warn("Undriven streets location dropdown not found.");
      return;
    }

    // Clear existing options except the placeholder
    while (dropdown.options.length > 1) {
      dropdown.remove(1);
    }

    const coverageAreas = await fetchCoverageAreas();

    if (coverageAreas.length === 0) {
      // Add a disabled option indicating none are available
      const option = document.createElement("option");
      option.textContent = "No coverage areas defined";
      option.disabled = true;
      dropdown.appendChild(option);
      return; // Exit early
    }

    // Populate dropdown with fetched areas
    coverageAreas.forEach((area) => {
      if (area.location && area.location.display_name) {
        // Ensure required data exists
        const option = document.createElement("option");
        // Store the full location object as JSON string in the value
        option.value = JSON.stringify(area.location);
        option.textContent = area.location.display_name; // Display name for user
        dropdown.appendChild(option);
      } else {
        console.warn(
          "Skipping coverage area due to missing location data:",
          area,
        );
      }
    });

    // Try to re-select the previously selected location from localStorage
    const savedLocationId = localStorage.getItem(
      "selectedLocationForUndrivenStreets",
    );
    let locationFound = false;
    if (savedLocationId) {
      for (let i = 0; i < dropdown.options.length; i++) {
        const value = dropdown.options[i].value;
        if (!value) continue; // Skip empty values (like the placeholder)
        try {
          // Parse the location object back from the option value
          const optionLocation = JSON.parse(value);
          // Check if the stored ID or name matches the current option's location
          if (
            optionLocation &&
            (optionLocation._id === savedLocationId ||
              optionLocation.display_name === savedLocationId)
          ) {
            dropdown.selectedIndex = i; // Select the matching option
            locationFound = true;
            // If the layer was previously visible, fetch its data now
            if (
              localStorage.getItem("layer_visible_undrivenStreets") === "true"
            ) {
              // Ensure the layer is marked as visible before fetching
              if (AppState.mapLayers.undrivenStreets) {
                AppState.mapLayers.undrivenStreets.visible = true;
              }
              fetchUndrivenStreets(); // Fetch data for the pre-selected location
            }
            break; // Stop searching once found
          }
        } catch (_) {
          // Removed unused 'e'
          // Ignore errors parsing option value (shouldn't happen if populated correctly)
          console.warn(
            "Error parsing JSON from location dropdown option value.",
          );
        }
      }
    }
    if (savedLocationId && !locationFound) {
      console.warn(
        "Previously selected location for undriven streets not found in current list.",
      );
      // Optionally clear the saved value if it's no longer valid
      // localStorage.removeItem("selectedLocationForUndrivenStreets");
    }
  }

  /** Initializes main application event listeners. */
  function initializeEventListeners() {
    // --- Controls Toggle ---
    const controlsToggle = getElement("controls-toggle");
    const controlsContent = getElement("controls-content");
    if (controlsToggle && controlsContent) {
      const icon = controlsToggle.querySelector("i"); // Assuming FontAwesome icon

      // Function to update icon based on collapse state
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

      // Set initial icon state
      updateIcon();

      // Add listeners for Bootstrap collapse events
      controlsContent.addEventListener("show.bs.collapse", updateIcon);
      controlsContent.addEventListener("hide.bs.collapse", updateIcon);
    } else {
      // console.warn("Controls toggle or content element not found."); // Reduce noise
    }

    // --- Button Listeners ---
    addSingleEventListener("map-match-trips", "click", mapMatchTrips);
    addSingleEventListener("fetch-trips-range", "click", fetchTripsInRange); // Assuming button exists

    // --- Checkbox Listener ---
    addSingleEventListener(
      "highlight-recent-trips",
      "change",
      function (event) {
        // Use function for 'this'
        if (event.target.type === "checkbox") {
          AppState.mapSettings.highlightRecentTrips = event.target.checked;
          refreshTripStyles(); // Update styles immediately
        }
      },
    );

    // --- Dropdown Listener ---
    const locationDropdown = document.getElementById(
      "undriven-streets-location",
    );
    if (locationDropdown) {
      locationDropdown.addEventListener("change", function () {
        // Fetch data only if the undriven streets layer is currently visible
        if (AppState.mapLayers.undrivenStreets?.visible) {
          fetchUndrivenStreets();
        }
      });
    }

    // --- Custom Event Listener ---
    // Listen for events from other modules (e.g., a separate filter module)
    document.addEventListener("filtersApplied", async (e) => { // Make listener async
      console.info("Filters applied event received:", e.detail);
      // Show loading overlay from modern-ui
      window.modernUI?.showLoading("Applying filters and loading data...");

      try {
        // Refetch data based on new filters
        await Promise.all([
          fetchTrips(), // Await the fetchTrips call
          fetchMetrics(), // Await the fetchMetrics call
        ]);
      } catch (error) {
        console.error("Error fetching data after filters applied:", error);
        window.notificationManager?.show(
          "Error loading data for the selected date range.",
          "danger",
        );
      } finally {
        // Hide loading overlay regardless of success or error
        window.modernUI?.hideLoading();
      }
    });

    // --- Unselect trip on map background click ---
    if (AppState.map) {
      AppState.map.on("click", function () {
        // Only unselect if no popup is open
        if (!AppState.map._popup || !AppState.map._popup.isOpen()) {
          if (AppState.selectedTripId) {
            AppState.selectedTripId = null;
            refreshTripStyles();
          }
        }
      });
    }
  }

  /** Caches references to frequently used DOM elements. */
  function initializeDOMCache() {
    AppState.dom.map = getElement("map");
    AppState.dom.layerToggles = getElement("layer-toggles");
    AppState.dom.layerOrder = getElement("layer-order");
    AppState.dom.controlsToggle = getElement("controls-toggle");
    AppState.dom.controlsContent = getElement("controls-content");
    AppState.dom.startDateInput = getElement("start-date");
    AppState.dom.endDateInput = getElement("end-date");
    AppState.dom.applyFiltersBtn = getElement("apply-filters"); // Assuming exists
    AppState.dom.mapMatchTripsBtn = getElement("map-match-trips");
    AppState.dom.fetchTripsRangeBtn = getElement("fetch-trips-range"); // Assuming exists
    AppState.dom.highlightRecentTrips = getElement("highlight-recent-trips");
    AppState.dom.imeiInput = getElement("imei"); // Assuming exists
    AppState.dom.locationDropdown = getElement("undriven-streets-location");
    AppState.dom.layerOrderList = getElement("layer-order-list"); // Cache list for drag/drop
    AppState.dom.mapControlsContainer = getElement("#map-controls-container"); // Cache potential container
  }

  /** Sets initial start and end dates in localStorage if they don't exist. */
  function setInitialDates() {
    const today = DateUtils.getCurrentDate(); // Get today's date in YYYY-MM-DD format
    // Set start date to today if not already set
    if (!getStorageItem(CONFIG.STORAGE_KEYS.startDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.startDate, today);
    }
    // Set end date to today if not already set
    if (!getStorageItem(CONFIG.STORAGE_KEYS.endDate)) {
      setStorageItem(CONFIG.STORAGE_KEYS.endDate, today);
    }
  }

  /** Initializes date pickers for start and end date inputs. */
  function initializeDatePickers() {
    // Ensure DOM elements are cached or retrieved
    AppState.dom.startDateInput =
      AppState.dom.startDateInput || getElement("start-date");
    AppState.dom.endDateInput =
      AppState.dom.endDateInput || getElement("end-date");

    if (!AppState.dom.startDateInput || !AppState.dom.endDateInput) {
      // console.warn("Date input elements not found, skipping date picker initialization."); // Reduce noise
      return;
    }

    // Get stored dates or default to today
    const storedStartDate =
      getStorageItem(CONFIG.STORAGE_KEYS.startDate) ||
      DateUtils.getCurrentDate();
    const storedEndDate =
      getStorageItem(CONFIG.STORAGE_KEYS.endDate) || DateUtils.getCurrentDate();

    // Common configuration for Flatpickr
    // const today = new Date();
    const config = {
      // maxDate: today, // Allow selecting today, but not future dates
      dateFormat: "Y-m-d", // Ensure format matches storage/API
      altInput: true, // Show user-friendly format
      altFormat: "M j, Y", // User-friendly display format
      static: false, // Position relative to input
      appendTo: document.body, // Append to body to avoid overflow issues
      theme:
        document.documentElement.getAttribute("data-bs-theme") === "light"
          ? "light"
          : "dark", // Match theme
      // position: "auto", // Auto position
      disableMobile: true, // Use native date picker on mobile if preferred (false) or force flatpickr (true)
      onChange(selectedDates, dateStr /*, instance*/) {
        // 'this' refers to the flatpickr instance
        const input = this.input;
        const formattedDate = DateUtils.formatDate(dateStr); // Ensure YYYY-MM-DD
        const isStartDate = input.id === "start-date";
        const key = isStartDate
          ? CONFIG.STORAGE_KEYS.startDate
          : CONFIG.STORAGE_KEYS.endDate;
        setStorageItem(key, formattedDate); // Store the selected date

        // Optional: Trigger filter application automatically on change
        // document.dispatchEvent(new CustomEvent('filtersApplied', { detail: { dateChanged: key } }));
      },
    };

    // Initialize date pickers using DateUtils helper or directly
    if (DateUtils.initDatePicker) {
      AppState.dom.startDatePicker = DateUtils.initDatePicker(
        AppState.dom.startDateInput,
        config,
      );
      AppState.dom.endDatePicker = DateUtils.initDatePicker(
        AppState.dom.endDateInput,
        config,
      );
    } else if (window.flatpickr) {
      // Fallback to direct flatpickr call
      AppState.dom.startDatePicker = window.flatpickr(
        AppState.dom.startDateInput,
        config,
      );
      AppState.dom.endDatePicker = window.flatpickr(
        AppState.dom.endDateInput,
        config,
      );
    } else {
      console.warn("Date picker library (Flatpickr) not found.");
      // Set values directly if library is missing
      AppState.dom.startDateInput.value = storedStartDate;
      AppState.dom.endDateInput.value = storedEndDate;
      return; // Skip setting dates via picker instances
    }

    // Set initial dates in the pickers
    if (AppState.dom.startDatePicker) {
      AppState.dom.startDatePicker.setDate(storedStartDate, false); // Set without triggering onChange
    }
    if (AppState.dom.endDatePicker) {
      AppState.dom.endDatePicker.setDate(storedEndDate, false); // Set without triggering onChange
    }
  }

  /** Main initialization function for the application. */
  function initialize() {
    console.info("Initializing application...");
    setInitialDates(); // Ensure dates are set in storage first
    initializeDOMCache(); // Cache DOM elements
    initializeDatePickers(); // Setup date inputs
    initializeEventListeners(); // Setup button clicks, etc.

    // Initialize map only if the map container exists and not on specific pages
    if (AppState.dom.map && !document.getElementById("visits-page")) {
      // Example condition
      initializeMap() // Returns a Promise<boolean>
        .then((mapInitializedOk) => {
          if (!mapInitializedOk || !isMapReady()) {
            // Handle map initialization failure more gracefully
            console.error("Map or essential components failed to initialize.");
            showNotification(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
            // Reject the promise chain to prevent further map-dependent operations
            return Promise.reject(new Error("Map initialization failed")); // Reject with Error object
          }
          console.info("Map initialized, setting up controls and data...");

          // Setup map-dependent components
          initializeLayerControls(); // Includes disabling event propagation
          initializeLiveTracker(); // Initialize after map is ready

          // Restore layer visibility state from localStorage
          Object.keys(AppState.mapLayers).forEach((layerName) => {
            const savedVisibility = localStorage.getItem(
              `layer_visible_${layerName}`,
            );
            const toggle = document.getElementById(`${layerName}-toggle`);

            if (savedVisibility !== null) {
              const isVisible = savedVisibility === "true";
              AppState.mapLayers[layerName].visible = isVisible;
              if (toggle) toggle.checked = isVisible;
            } else {
              // If no saved state, use default and update toggle accordingly
              if (toggle)
                toggle.checked = AppState.mapLayers[layerName].visible;
            }

            // Special case: Ensure undriven streets layer is empty if not visible initially
            if (
              layerName === "undrivenStreets" &&
              !AppState.mapLayers[layerName].visible
            ) {
              AppState.mapLayers[layerName].layer = {
                type: "FeatureCollection",
                features: [],
              };
            }
          });
          updateLayerOrderUI(); // Update UI based on restored visibility

          // Populate location dropdown *after* layer controls are set up
          return populateLocationDropdown(); // Returns a Promise
        })
        .then(() => {
          // Fetch initial data *after* map and controls are ready
          console.info("Fetching initial trips and metrics...");
          // Run fetches concurrently
          return Promise.all([fetchTrips(), fetchMetrics()]);
        })
        .then(() => {
          console.info("Initial data loaded.");
          // Check if there are trips and zoom to the last one
          if (AppState.mapLayers.trips?.layer?.features?.length > 0) {
            zoomToLastTrip(); // Animate map to the latest trip location
          } else {
            // console.info("No initial trips found to zoom to."); // Reduce noise
            // Optionally fit bounds to default or based on other layers
            // fitMapBounds();
          }
          // Dispatch event indicating all initial setup is complete
          document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        })
        .catch((error) => {
          // Catch errors from any part of the initialization chain
          console.error("Error during application initialization:", error);
          if (typeof handleError === "function") {
            handleError(error, "Application Initialization");
          } else {
            showNotification(
              `Initialization Error: ${error.message}`,
              "danger",
            );
          }
        })
        .finally(() => {
          // Ensure loading overlay is hidden after all initialization attempts
          console.log("INITIALIZE: Hiding loading overlay (finally block).");
          window.modernUI?.hideLoading();
        });
    } else {
      console.info(
        "Map container not found or on excluded page, skipping map initialization.",
      );
      // Perform non-map related initializations if any
    }

    // Expose AppState globally AFTER basic init but potentially before async data fetch
    // This ensures modern-ui.js can access it when it initializes
    window.AppState = AppState; // Make AppState directly available for simplicity
    window.EveryStreet = window.EveryStreet || {};
    window.EveryStreet.App = {
      // Continue namespacing other exports
      fetchTrips,
      updateMap,
      refreshTripStyles,
      updateTripsTable,
      toggleLayer,
      fetchMetrics,
      initializeMap, // Expose if needed externally
      // handleError, // Expose global error handler if defined elsewhere
      getStartDate, // Expose date getters if needed
      getEndDate,
      fitMapBounds,
      mapMatchTrips,
      fetchTripsInRange,
      AppState, // Expose state carefully if needed for debugging or other modules
      CONFIG,   // Expose config if needed
    };

    // Dispatch an event indicating core app structure is ready
    console.log("Dispatching appReady event.");
    document.dispatchEvent(new CustomEvent("appReady"));
  }

  // --- Event Listeners ---

  // Start initialization when the DOM is fully loaded
  document.addEventListener("DOMContentLoaded", initialize);

  // Cleanup polling timers on page unload
  window.addEventListener("beforeunload", () => {
    Object.values(AppState.polling.timers).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    AppState.polling.active = false; // Mark polling as inactive
  });

  // --- Global Exposure (Consider reducing) ---
  // Expose necessary functions/state globally under a namespace
  // MOVED THE GLOBAL ASSIGNMENT INTO initialize() function right before dispatching appReady
  /*
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.App = {
    fetchTrips,
    updateMap,
    refreshTripStyles,
    updateTripsTable,
    toggleLayer,
    fetchMetrics,
    initializeMap, // Expose if needed externally
    // handleError, // Expose global error handler if defined elsewhere
    getStartDate, // Expose date getters if needed
    getEndDate,
    fitMapBounds,
    mapMatchTrips,
    fetchTripsInRange,
    AppState, // Expose state carefully if needed for debugging or other modules
    CONFIG,   // Expose config if needed
  };
  */

  // --- Helper Functions (Debounce, Throttle, Cache) ---

  /**
   * Debounce function: Limits the rate at which a function can fire.
   * @param {Function} func - The function to debounce.
   * @param {number} wait - The timeout duration in milliseconds.
   * @returns {Function} The debounced function.
   */
  function debounce(func, wait) {
    let timeout = null; // Initialize with null
    return function (...args) {
      const context = this; // Preserve context
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null; // Clear timeout ID after execution
        func.apply(context, args);
      }, wait);
    };
  }

  /**
   * Throttle function: Ensures a function is called at most once per limit period.
   * @param {Function} func - The function to throttle.
   * @param {number} limit - The throttle duration in milliseconds.
   * @returns {Function} The throttled function.
   */
  function throttle(func, limit) {
    let inThrottle = false; // Initialize with false
    let lastResult = null; // Store last result
    return function (...args) {
      const context = this;
      if (!inThrottle) {
        lastResult = func.apply(context, args);
        inThrottle = true;
        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
      return lastResult; // Return the last result immediately
    };
  }

  // Simple in-memory cache for API responses
  const apiCache = {};
  /**
   * Fetches data from a URL, using a cache to avoid redundant requests.
   * @param {string} url - The URL to fetch.
   * @param {object} [options={}] - Fetch options (method, headers, etc.).
   * @param {number} [cacheTime=10000] - Cache duration in milliseconds.
   * @returns {Promise<any>} The fetched JSON data.
   */
  async function cachedFetch(url, options = {}, cacheTime = 10000) {
    const key = url + JSON.stringify(options); // Create cache key
    const now = Date.now();

    // Check cache validity
    if (apiCache[key] && now - apiCache[key].ts < cacheTime) {
      // console.info(`Cache hit for: ${url}`); // Reduce noise
      return apiCache[key].data; // Return cached data
    }

    // console.info(`Cache miss or expired for: ${url}. Fetching...`); // Reduce noise
    const response = await fetch(url, options);
    if (!response.ok) {
      let errorMsg = `API request failed for ${url} (Status: ${response.status})`;
      try {
        const errData = await response.json();
        errorMsg += `: ${errData.detail || errData.message || response.statusText}`;
      } catch (_) {
        /* Ignore if response not JSON */
      }
      throw new Error(errorMsg);
    }
    const data = await response.json();
    apiCache[key] = { data, ts: now }; // Store fetched data and timestamp in cache
    return data;
  }

  // --- DOM Batch Update Functions ---

  /**
   * Efficiently creates and updates layer control UI elements.
   * @param {Element} layerTogglesContainer - The container element for layer controls.
   * @param {object} layers - The AppState.mapLayers object.
   */
  function batchLayerControls(layerTogglesContainer, layers) {
    const fragment = document.createDocumentFragment(); // Use fragment for performance

    Object.entries(layers).forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className =
        "layer-control d-flex align-items-center mb-1 p-1 border rounded"; // Basic styling
      div.dataset.layerName = name;

      // Checkbox for visibility toggle
      const checkboxId = `${name}-toggle`;
      const checkboxLabel = document.createElement("label");
      checkboxLabel.className = "custom-checkbox me-2"; // Margin end
      // Ensure the input is INSIDE the label for better accessibility/clicking
      checkboxLabel.innerHTML = `
        <input type="checkbox" id="${checkboxId}" ${info.visible ? "checked" : ""}>
        <span class="checkmark"></span>
      `;

      // Label for the layer name (clickable)
      const nameLabel = document.createElement("label");
      nameLabel.htmlFor = checkboxId; // Associate with checkbox
      nameLabel.textContent = info.name || name;
      nameLabel.className = "me-auto"; // Push controls to the right
      nameLabel.style.cursor = "pointer"; // Indicate it's clickable

      div.appendChild(checkboxLabel);
      div.appendChild(nameLabel);

      // Add color and opacity controls only for relevant layers
      if (!["customPlaces"].includes(name)) {
        // Exclude layers without these controls
        // Color picker
        const colorControl = document.createElement("input");
        colorControl.type = "color";
        colorControl.id = `${name}-color`;
        colorControl.value = info.color;
        colorControl.className =
          "form-control form-control-sm layer-color-picker me-1"; // Styling
        colorControl.title = `Layer color for ${info.name || name}`; // Tooltip
        colorControl.style.width = "30px"; // Make color picker smaller
        div.appendChild(colorControl);

        // Opacity slider
        const opacitySlider = document.createElement("input");
        opacitySlider.type = "range";
        opacitySlider.id = `${name}-opacity`;
        opacitySlider.min = "0";
        opacitySlider.max = "1";
        opacitySlider.step = "0.1";
        opacitySlider.value = info.opacity;
        opacitySlider.className = "form-range layer-opacity-slider"; // Styling
        opacitySlider.title = `Layer opacity for ${info.name || name}`; // Tooltip
        opacitySlider.style.width = "60px"; // Make slider smaller
        div.appendChild(opacitySlider);
      }

      fragment.appendChild(div);
    });

    // Clear previous controls and append the new fragment
    layerTogglesContainer.innerHTML = "";
    layerTogglesContainer.appendChild(fragment);
  }

  /**
   * Efficiently creates and updates the layer order UI list.
   * @param {Element} layerOrderEl - The container element for the layer order list.
   * @param {Array<[string, object]>} visibleLayers - Sorted array of visible layer entries.
   */
  function batchLayerOrderUI(layerOrderEl, visibleLayers) {
    // Add heading if it doesn't exist or clear previous content
    layerOrderEl.innerHTML =
      '<h4 class="h6 mb-1">Layer Order (Drag to Reorder)</h4>'; // Added instruction

    const ul = document.createElement("ul");
    ul.id = "layer-order-list";
    ul.className = "list-group layer-order-list"; // Use specific class
    const fragment = document.createDocumentFragment();

    // Create list items for each visible layer
    visibleLayers.forEach(([name, info]) => {
      const li = document.createElement("li");
      li.textContent = info.name || name;
      li.draggable = true; // Make item draggable
      li.dataset.layer = name; // Store layer name for identification
      li.className =
        "list-group-item list-group-item-action list-group-item-dark p-1"; // Styling
      li.style.cursor = "grab"; // Indicate draggability
      fragment.appendChild(li);
    });

    ul.appendChild(fragment);
    layerOrderEl.appendChild(ul);

    // Update cached DOM reference
    AppState.dom.layerOrderList = ul;
  }

  /**
   * Sets up delegated event listeners for layer controls (toggle, color, opacity).
   * @param {Element} layerTogglesContainer - The container holding the layer controls.
   */
  function delegateLayerControls(layerTogglesContainer) {
    // Use event delegation for efficiency
    layerTogglesContainer.addEventListener("change", (e) => {
      const target = e.target;
      // FIX: Target the input directly by ID pattern or within the specific label structure
      // if (target.matches('input[type="checkbox"].custom-checkbox input')) { // Old selector
      if (target.matches('label.custom-checkbox input[type="checkbox"]')) {
        // More specific selector
        const layerName = target.id.replace("-toggle", "");
        // console.log('Toggle event detected for:', layerName, target.checked); // Debug log
        toggleLayer(layerName, target.checked);
      }
    });

    // Use 'input' event for real-time updates on color/opacity
    layerTogglesContainer.addEventListener("input", (e) => {
      const target = e.target;
      const layerName = target.closest(".layer-control")?.dataset.layerName;
      if (!layerName) return;

      // Handle color pickers
      if (target.matches('input[type="color"].layer-color-picker')) {
        changeLayerColor(layerName, target.value);
      }
      // Handle opacity sliders
      else if (target.matches('input[type="range"].layer-opacity-slider')) {
        changeLayerOpacity(layerName, parseFloat(target.value));
      }
    });
  }

  /**
   * Gets or creates a Leaflet GeoJSON layer, updating data if it exists.
   * @param {string} name - The unique name/key for the layer.
   * @param {object} data - The GeoJSON data.
   * @param {object} options - Leaflet GeoJSON layer options (style, onEachFeature, etc.).
   * @returns {L.GeoJSON} The Leaflet GeoJSON layer instance.
   */
  function getOrCreateGeoJsonLayer(name, data, options) {
    if (!AppState.geoJsonLayers[name]) {
      // Create new layer if it doesn't exist
      AppState.geoJsonLayers[name] = L.geoJSON(data, options);
    } else {
      // Update existing layer: clear old data, add new data, apply new options
      const layer = AppState.geoJsonLayers[name];
      layer.clearLayers();
      layer.addData(data);
      // Re-apply options, especially style, as it might depend on new data or state
      if (options) {
        // Merge options carefully if needed, preserving essential ones
        layer.options = { ...L.GeoJSON.prototype.options, ...options }; // Reset to defaults + new options
        if (options.style) {
          layer.setStyle(options.style); // Re-apply style function/object
        }
        // Re-bind onEachFeature - necessary if options change behavior
        if (options.onEachFeature) {
          layer.eachLayer((featureLayer) => {
            options.onEachFeature(featureLayer.feature, featureLayer);
          });
        }
      }
    }
    return AppState.geoJsonLayers[name];
  }

  // Flag to track if undriven streets have been loaded once
  let undrivenStreetsLoaded = false;
  /**
   * Lazily fetches undriven streets data only if needed and not already loaded.
   * Now correctly awaits the async fetch function.
   * @returns {Promise<object|null>} GeoJSON data or null.
   */
  async function lazyFetchUndrivenStreets() {
    // Fetch only if the layer is marked visible and not already loaded
    if (AppState.mapLayers.undrivenStreets?.visible && !undrivenStreetsLoaded) {
      undrivenStreetsLoaded = true; // Mark as loading/loaded
      try {
        // Await the actual fetch function
        const data = await fetchUndrivenStreets();
        // If fetch fails, reset the flag to allow retrying
        if (!data) {
          undrivenStreetsLoaded = false; // Reset if fetch failed
        }
        return data;
      } catch (error) {
        undrivenStreetsLoaded = false; // Reset on error
        return null;
      }
    } else if (
      undrivenStreetsLoaded &&
      AppState.mapLayers.undrivenStreets?.layer
    ) {
      // If already loaded, return the existing data
      return AppState.mapLayers.undrivenStreets.layer;
    }
    // Return null if not visible or already loaded without data
    return null;
  }

  // --- Keyboard Navigation ---
  /** Adds basic keyboard controls for map navigation (zoom, pan). */
  window.addEventListener("keydown", function (e) {
    if (!AppState.map) return; // Only act if map exists

    // Ignore key events if user is typing in an input, textarea, or select
    const activeElement = document.activeElement;
    const isInputFocused =
      activeElement &&
      (activeElement.tagName === "INPUT" ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.tagName === "SELECT");
    if (isInputFocused) return;

    switch (e.key) {
      case "+": // Plus key
      case "=": // Equals key (often shares key with plus)
        AppState.map.zoomIn();
        break;
      case "-": // Minus key
      case "_": // Underscore key (often shares key with minus)
        AppState.map.zoomOut();
        break;
      case "ArrowUp":
        AppState.map.panBy([0, -100]); // Pan up
        break;
      case "ArrowDown":
        AppState.map.panBy([0, 100]); // Pan down
        break;
      case "ArrowLeft":
        AppState.map.panBy([-100, 0]); // Pan left
        break;
      case "ArrowRight":
        AppState.map.panBy([100, 0]); // Pan right
        break;
      default:
        // No action needed for other keys
        break; // Added default case
    }
  });

  /**
   * Animates the map view to the last point of the most recent trip.
   * @param {number} [targetZoom=14] - The desired zoom level after animation.
   * @param {number} [duration=2] - The animation duration in seconds.
   */
  function zoomToLastTrip(targetZoom = 14, duration = 2) {
    if (!AppState.map || !AppState.mapLayers.trips?.layer?.features) {
      // console.warn("Cannot zoom to last trip: Map or trips layer data not available."); // Reduce noise
      return;
    }

    const features = AppState.mapLayers.trips.layer.features;
    if (features.length === 0) {
      // console.info("No trips available to zoom to."); // Reduce noise
      return; // No trips, nothing to do
    }

    // Find the most recent trip based on endTime
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

    if (!lastTripFeature) {
      console.warn(
        "Could not determine the most recent trip (missing or invalid end times?).",
      );
      return;
    }

    // Extract the last coordinate from the geometry
    let lastCoord = null; // Initialize with null
    const geomType = lastTripFeature.geometry?.type;
    const coords = lastTripFeature.geometry?.coordinates;

    if (
      geomType === "LineString" &&
      Array.isArray(coords) &&
      coords.length > 0
    ) {
      lastCoord = coords[coords.length - 1]; // Last coordinate pair [lng, lat]
    } else if (geomType === "Point" && Array.isArray(coords)) {
      lastCoord = coords; // Point coordinate pair [lng, lat]
    } else {
      console.warn(
        `Unsupported geometry type (${geomType}) or empty/invalid coordinates for the last trip.`,
      );
      return; // Cannot proceed without valid coordinates
    }

    // Validate the extracted coordinate and fly to it
    if (
      Array.isArray(lastCoord) &&
      lastCoord.length === 2 &&
      typeof lastCoord[0] === "number" &&
      typeof lastCoord[1] === "number"
    ) {
      const targetLatLng = [lastCoord[1], lastCoord[0]]; // Convert [lng, lat] to Leaflet's [lat, lng]
      // console.info( // Reduce noise
      //   `Animating map to last trip end point at [${targetLatLng.join(", ")}]`,
      // );
      // Use flyTo for smooth animation
      AppState.map.flyTo(targetLatLng, targetZoom, {
        animate: true,
        duration: duration, // Animation duration
        easeLinearity: 0.25, // Animation easing
      });
    } else {
      console.warn(
        "Could not determine valid coordinates for the last point of the most recent trip.",
      );
    }
  }
})(); // End of IIFE
