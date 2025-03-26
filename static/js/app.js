/* global L, bootstrap, $, DateUtils, DOMHelper */
/* global notificationManager, confirmationDialog, loadingManager, utils, handleError */

/**
 * Main application module for Every Street mapping functionality
 */
"use strict";

(function () {
  // --- Configuration ---
  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129],
      defaultZoom: 4,
      tileLayerUrls: {
        // Kept here for potential direct use, though modern-ui manages active layer
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      },
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours in ms
      debounceDelay: 150, // Slightly increased for potentially complex style updates
      mapBoundsPadding: [30, 30], // Padding for fitBounds
    },
    STORAGE_KEYS: {
      // Aligned with modern-ui.js where applicable
      startDate: "startDate",
      endDate: "endDate",
      // selectedLocation: "selectedLocation", // Keep if used elsewhere, otherwise remove
      // sidebarState: "sidebarCollapsed", // Keep if used elsewhere, otherwise remove
    },
    ERROR_MESSAGES: {
      mapInitFailed: "Failed to initialize map. Please refresh the page.",
      fetchTripsFailed: "Error loading trips. Please try again.",
      // locationValidationFailed: "Location not found. Please check your input.", // Keep if used
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
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.4,
      visible: false,
      highlightColor: "#40E0D0",
      name: "Matched Trips",
    },
    customPlaces: {
      order: 7,
      color: "#FF9800",
      opacity: 0.5,
      visible: false,
      name: "Custom Places",
    },
  };

  // --- Application State ---
  const AppState = {
    map: null,
    layerGroup: null,
    mapLayers: JSON.parse(JSON.stringify(LAYER_DEFAULTS)), // Deep copy defaults
    mapInitialized: false,
    mapSettings: { highlightRecentTrips: true },
    selectedTripId: null,
    liveTracker: null, // Reference to the live tracker instance
    dom: {}, // Cache for frequently accessed DOM elements
  };

  // --- DOM Cache Utility ---
  const getElement = (selector, useCache = true, context = document) => {
    if (useCache && AppState.dom[selector]) return AppState.dom[selector];

    // Use a more robust selector check if needed, this assumes IDs or simple selectors
    const element = context.querySelector(
      selector.startsWith("#") ||
        selector.includes(" ") ||
        selector.startsWith(".")
        ? selector
        : `#${selector}`
    );

    if (useCache && element) AppState.dom[selector] = element;
    return element;
  };

  // --- Event Listener Utility ---
  // Prevents adding the same listener multiple times
  const addSingleEventListener = (element, eventType, handler) => {
    const el = typeof element === "string" ? getElement(element) : element;
    if (!el) {
      console.warn(`Element not found for listener: ${element}`);
      return false;
    }

    if (!el._eventHandlers) el._eventHandlers = {};

    // Create a simple key based on event type and handler function (might not be foolproof for complex handlers)
    const handlerKey = `${eventType}_${handler
      .toString()
      .substring(0, 50)
      .replace(/\s+/g, "")}`;

    if (el._eventHandlers[handlerKey]) {
      // console.log(`Listener already attached: ${eventType} on ${el.id || el.tagName}`);
      return false; // Listener already exists
    }

    el.addEventListener(eventType, handler);
    el._eventHandlers[handlerKey] = handler; // Store reference
    // console.log(`Attached listener: ${eventType} on ${el.id || el.tagName}`);
    return true;
  };

  // Debounced map update function using utils.debounce
  const debouncedUpdateMap = utils.debounce(
    updateMap,
    CONFIG.MAP.debounceDelay
  );

  // --- Date & Filter Functions ---
  // Get the currently applied start/end dates from storage
  const getStartDate = () =>
    DateUtils.formatDate(
      utils.getStorage(
        CONFIG.STORAGE_KEYS.startDate,
        DateUtils.getCurrentDate()
      )
    );
  const getEndDate = () =>
    DateUtils.formatDate(
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate, DateUtils.getCurrentDate())
    );

  // --- Trip Styling Functions ---
  const getTripFeatureStyle = (feature, layerInfo) => {
    const { properties } = feature;
    const { transactionId, startTime } = properties;
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const tripStartTime = DateUtils.parseDate(startTime)?.getTime();
    const isRecent =
      AppState.mapSettings.highlightRecentTrips &&
      tripStartTime &&
      tripStartTime > sixHoursAgo;
    const isSelected = transactionId === AppState.selectedTripId;

    // Simplified check for matched pair highlighting
    const isMatchedPair =
      isSelected ||
      (AppState.selectedTripId &&
        transactionId &&
        (AppState.selectedTripId.replace("MATCHED-", "") === transactionId ||
          transactionId.replace("MATCHED-", "") === AppState.selectedTripId));

    let color = layerInfo.color;
    let weight = 2;
    let opacity = layerInfo.opacity;
    let className = "";
    let zIndexOffset = 0;

    if (isSelected) {
      color = layerInfo.highlightColor;
      weight = 5;
      opacity = 0.9;
      className = "highlighted-trip";
      zIndexOffset = 1000;
    } else if (isMatchedPair) {
      // Use the appropriate highlight color based on which layer it actually is
      color =
        feature.properties.isMatched ||
        layerInfo === AppState.mapLayers.matchedTrips
          ? AppState.mapLayers.matchedTrips.highlightColor
          : AppState.mapLayers.trips.highlightColor;
      weight = 5;
      opacity = 0.9;
      className = "highlighted-matched-trip";
      zIndexOffset = 1000; // Bring matched pair to front too
    } else if (isRecent) {
      color = "#FF5722"; // Distinct recent color
      weight = 4;
      opacity = 0.8;
      className = "recent-trip";
      zIndexOffset = 500; // Bring recent trips above normal ones
    }

    return { color, weight, opacity, className, zIndexOffset };
  };

  function refreshTripStyles() {
    if (!AppState.layerGroup) return;

    AppState.layerGroup.eachLayer((layer) => {
      // Check if it's a GeoJSON layer group created by L.geoJSON
      if (layer.eachLayer) {
        layer.eachLayer((featureLayer) => {
          if (featureLayer.feature?.properties && featureLayer.setStyle) {
            // Determine which layer config this feature belongs to
            const layerInfo = featureLayer.feature.properties.isMatched
              ? AppState.mapLayers.matchedTrips
              : AppState.mapLayers.trips;

            featureLayer.setStyle(
              getTripFeatureStyle(featureLayer.feature, layerInfo)
            );

            // Ensure selected/matched trips are brought to the front within their layer group
            if (
              featureLayer.options.zIndexOffset > 0 &&
              featureLayer.bringToFront
            ) {
              featureLayer.bringToFront();
            }
          }
        });
      }
    });
    // console.log("Trip styles refreshed.");
  }

  // --- Map Initialization & Controls ---
  const isMapReady = () =>
    AppState.map && AppState.mapInitialized && AppState.layerGroup;

  async function initializeMap() {
    const mapContainer = getElement("map");
    if (!mapContainer) {
      console.error("Map container element (#map) not found.");
      return; // Stop initialization if container is missing
    }

    try {
      // Ensure Leaflet is loaded
      if (typeof L === "undefined") {
        throw new Error("Leaflet library (L) is not loaded.");
      }

      // Determine initial theme based on modern-ui.js preference
      const initialTheme = document.body.classList.contains("light-mode")
        ? "light"
        : "dark";
      const tileUrl =
        CONFIG.MAP.tileLayerUrls[initialTheme] || CONFIG.MAP.tileLayerUrls.dark;

      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: true, // Keep Leaflet's default zoom control
        attributionControl: false, // Assuming attribution is handled elsewhere or not needed
        maxBounds: [
          [-90, -180],
          [90, 180],
        ], // Prevent panning outside world bounds
        maxBoundsViscosity: 1.0, // Makes bounds fully solid
      });

      // Expose map instance globally if needed by other scripts (like custom-places.js)
      window.map = AppState.map;

      L.tileLayer(tileUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        attribution: "", // Keep attribution clean
      }).addTo(AppState.map);

      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      // Initialize layer containers (simple structure for GeoJSON)
      Object.keys(AppState.mapLayers).forEach((layerName) => {
        AppState.mapLayers[layerName].layer =
          layerName === "customPlaces"
            ? L.layerGroup() // customPlaces uses its own manager, needs a LayerGroup
            : { type: "FeatureCollection", features: [] }; // Other layers store GeoJSON data
      });

      // Map click event to deselect trips
      AppState.map.on("click", (e) => {
        // Check if the click was on a feature (handled by feature click) or the map itself
        if (
          AppState.selectedTripId &&
          !e.originalEvent?.target?.closest(".leaflet-interactive")
        ) {
          AppState.selectedTripId = null;
          refreshTripStyles();
          document.dispatchEvent(
            new CustomEvent("tripSelected", { detail: { id: null } })
          );
        }
      });

      // Listen for theme changes from modern-ui.js to refresh styles
      document.addEventListener("themeChanged", (e) => {
        // modern-ui.js handles the tile layer change
        // We just need to refresh our feature styles if needed
        console.log("Theme changed detected in app.js, refreshing styles.");
        refreshTripStyles();
      });

      initializeLiveTracker(); // Initialize the live tracker component

      // Attempt to center map, fall back gracefully
      try {
        await centerMapOnLastPosition();
      } catch (error) {
        handleError(error, "Centering map on last position");
        // Fallback to default view if centering fails
        AppState.map.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      }

      AppState.mapInitialized = true;
      // Invalidate map size after a short delay to ensure container dimensions are stable
      setTimeout(() => AppState.map?.invalidateSize(), 200);
      document.dispatchEvent(new CustomEvent("mapInitialized"));
      console.log("Map initialized successfully.");
    } catch (error) {
      handleError(error, "Map Initialization");
      notificationManager.show(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
      // Clean up partially initialized map if error occurred
      if (AppState.map) {
        AppState.map.remove();
        AppState.map = null;
        window.map = null;
      }
      AppState.mapInitialized = false;
    }
  }

  function initializeLiveTracker() {
    // Ensure LiveTripTracker class is available and map is ready
    if (!window.LiveTripTracker || !AppState.map) {
      if (!window.LiveTripTracker)
        console.warn("LiveTripTracker class not found.");
      return;
    }

    try {
      // Initialize only if it hasn't been initialized yet
      if (!AppState.liveTracker) {
        AppState.liveTracker = new window.LiveTripTracker(AppState.map);
        // Optionally expose globally if needed, but prefer AppState reference
        // window.liveTracker = AppState.liveTracker;
        console.log("LiveTripTracker initialized.");
      }
    } catch (error) {
      handleError(error, "LiveTripTracker Initialization");
    }
  }

  async function centerMapOnLastPosition() {
    try {
      const response = await fetch("/api/last_trip_point");
      if (!response.ok) {
        // Don't throw an error for 404 or similar, just log and use default
        if (response.status !== 404) {
          console.warn(
            `Failed to fetch last trip point: ${response.status} ${response.statusText}`
          );
        } else {
          console.log("No last trip point found in API.");
        }
        // Use a sensible default if no last point is available
        AppState.map?.setView([31.55002, -97.123354], 14); // Example: Waco, TX
        return;
      }

      const data = await response.json();
      if (data.lastPoint && AppState.map) {
        const [lng, lat] = data.lastPoint; // Assuming [longitude, latitude]
        if (typeof lat === "number" && typeof lng === "number") {
          console.log(`Centering map on last known position: [${lat}, ${lng}]`);
          AppState.map.flyTo([lat, lng], 11, {
            // Zoom level 11 might be suitable
            duration: 1.5, // Faster animation
            easeLinearity: 0.5,
          });
        } else {
          console.warn("Received invalid coordinates for last trip point.");
          AppState.map?.setView([31.55002, -97.123354], 14);
        }
      } else {
        // API responded OK but no point data, use default
        console.log("API responded OK but no last trip point data found.");
        AppState.map?.setView([31.55002, -97.123354], 14);
      }
    } catch (error) {
      // Network or parsing error, let caller handle fallback
      throw error; // Re-throw to be caught by initializeMap
    }
  }

  // --- Layer Controls ---
  function initializeLayerControls() {
    const layerTogglesContainer = getElement("layer-toggles");
    if (!layerTogglesContainer) return;

    layerTogglesContainer.innerHTML = ""; // Clear existing controls

    // Create controls based on AppState.mapLayers definition order or a specific order
    Object.entries(AppState.mapLayers)
      .sort(([, a], [, b]) => (a.order || 99) - (b.order || 99)) // Sort by order for consistent UI
      .forEach(([name, info]) => {
        const controlIdBase = `${name}-layer`;
        const isSpecialLayer = name === "customPlaces"; // Add other non-standard layers here if needed

        const div = DOMHelper.create("div", {
          class: "layer-control mb-2",
          "data-layer-name": name,
        });

        const toggleLabel = DOMHelper.create("label", {
          class: "form-check form-switch d-flex align-items-center",
        });
        const toggleInput = DOMHelper.create("input", {
          class: "form-check-input me-2",
          type: "checkbox",
          role: "switch",
          id: `${controlIdBase}-toggle`,
          checked: info.visible,
        });
        const toggleText = DOMHelper.create(
          "span",
          { class: "form-check-label" },
          info.name || name
        );

        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(toggleText);
        div.appendChild(toggleLabel);

        // Add color and opacity controls only for standard trip layers
        if (!isSpecialLayer) {
          const controlsDiv = DOMHelper.create("div", {
            class: "layer-sub-controls d-flex align-items-center ms-4 mt-1",
          });

          // Color Picker
          const colorInput = DOMHelper.create("input", {
            type: "color",
            id: `${controlIdBase}-color`,
            value: info.color,
            class: "form-control form-control-color form-control-sm me-2",
            title: "Layer Color",
          });
          controlsDiv.appendChild(colorInput);

          // Opacity Slider
          const opacityInput = DOMHelper.create("input", {
            type: "range",
            id: `${controlIdBase}-opacity`,
            min: "0",
            max: "1",
            step: "0.1",
            value: info.opacity,
            class: "form-range form-range-sm flex-grow-1",
            title: "Layer Opacity",
          });
          controlsDiv.appendChild(opacityInput);
          div.appendChild(controlsDiv);
        }

        layerTogglesContainer.appendChild(div);
      });

    // Use event delegation on the container for efficiency
    layerTogglesContainer.addEventListener("change", (e) => {
      const target = e.target;
      const layerControlDiv = target.closest(".layer-control");
      if (!layerControlDiv) return;
      const layerName = layerControlDiv.dataset.layerName;

      if (target.matches('input[type="checkbox"]')) {
        toggleLayer(layerName, target.checked);
      } else if (target.matches('input[type="color"]')) {
        changeLayerColor(layerName, target.value);
      }
    });

    // Use 'input' event for sliders for real-time feedback
    layerTogglesContainer.addEventListener("input", (e) => {
      const target = e.target;
      const layerControlDiv = target.closest(".layer-control");
      if (!layerControlDiv) return;
      const layerName = layerControlDiv.dataset.layerName;

      if (target.matches('input[type="range"]')) {
        changeLayerOpacity(layerName, parseFloat(target.value));
      }
    });

    updateLayerOrderUI(); // Initialize the layer order list
  }

  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;

    layerInfo.visible = visible;

    // Special handling for custom places layer visibility
    if (name === "customPlaces" && window.customPlaces?.toggleVisibility) {
      window.customPlaces.toggleVisibility(visible);
    } else {
      // For standard GeoJSON layers, updateMap will handle visibility
      debouncedUpdateMap();
    }

    updateLayerOrderUI(); // Update draggable list based on visibility
    document.dispatchEvent(
      new CustomEvent("layerVisibilityChanged", {
        detail: { layer: name, visible },
      })
    );
  }

  function changeLayerColor(name, color) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo || layerInfo.color === color) return; // No change
    layerInfo.color = color;
    // Update styles immediately for visual feedback, then redraw map if needed
    refreshTripStyles();
    // debouncedUpdateMap(); // May not be needed if only color changes, refreshTripStyles might suffice
  }

  function changeLayerOpacity(name, opacity) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo || layerInfo.opacity === opacity) return; // No change
    layerInfo.opacity = opacity;
    // Update styles immediately
    refreshTripStyles();
    // debouncedUpdateMap(); // Opacity change requires style refresh
  }

  function updateLayerOrderUI() {
    const layerOrderContainer = getElement("layer-order"); // Container div
    if (!layerOrderContainer) return;

    // Clear previous list, keep the heading
    const existingList = getElement(
      "layer-order-list",
      false,
      layerOrderContainer
    );
    if (existingList) existingList.remove();

    // Filter visible layers and sort by current order (descending for top-to-bottom UI)
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer) // Ensure layer data exists
      .sort(([, a], [, b]) => (b.order || 0) - (a.order || 0)); // Higher order on top

    if (visibleLayers.length === 0) {
      // Optionally show a message if no layers are visible
      layerOrderContainer.querySelector("h4").textContent =
        "Layer Order (None Visible)";
      return;
    }
    layerOrderContainer.querySelector("h4").textContent = "Layer Order";

    const ul = DOMHelper.create("ul", {
      id: "layer-order-list",
      class: "list-group", // Use Bootstrap list group styling
    });

    visibleLayers.forEach(([name, info]) => {
      const li = DOMHelper.create("li", {
        "data-layer": name,
        draggable: true,
        class:
          "list-group-item list-group-item-action d-flex justify-content-between align-items-center py-1 px-2", // Compact style
      });
      li.textContent = info.name || name; // Display layer name
      // Add a drag handle icon (optional but good UX)
      const handle = DOMHelper.create("i", {
        class: "fas fa-grip-vertical text-muted ms-2 drag-handle",
        style: { cursor: "grab" },
      });
      li.appendChild(handle);
      ul.appendChild(li);
    });

    layerOrderContainer.appendChild(ul);
    initializeDragAndDrop(); // Re-initialize drag and drop on the new list
  }

  function initializeDragAndDrop() {
    const list = getElement("layer-order-list");
    if (!list) return;

    let draggedItem = null;

    // Use event delegation on the list for dragstart
    list.addEventListener("dragstart", (e) => {
      // Only allow dragging by the handle if it exists
      if (
        e.target.classList.contains("drag-handle") ||
        e.target.closest("li")
      ) {
        draggedItem = e.target.closest("li");
        if (!draggedItem) return;

        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggedItem.dataset.layer); // Necessary for Firefox
        // Add dragging style with a slight delay
        setTimeout(
          () =>
            draggedItem?.classList.add("dragging", "border", "border-primary"),
          0
        );
      } else {
        e.preventDefault(); // Prevent drag if not started on handle/item
      }
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault(); // Necessary to allow drop
      e.dataTransfer.dropEffect = "move";

      const target = e.target.closest("li");
      // Ensure we are over a different list item
      if (target && draggedItem && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        // Determine if dragging above or below the midpoint of the target item
        const midpointY = rect.top + rect.height / 2;
        if (e.clientY > midpointY) {
          // Insert below target
          list.insertBefore(draggedItem, target.nextSibling);
        } else {
          // Insert above target
          list.insertBefore(draggedItem, target);
        }
      }
    });

    list.addEventListener("dragend", (e) => {
      if (draggedItem) {
        draggedItem.classList.remove("dragging", "border", "border-primary");
        draggedItem = null;
        updateLayerOrder(); // Update the internal order state and redraw map
      }
    });

    // Prevent dragover default on the container to avoid issues
    const layerOrderContainer = getElement("layer-order");
    if (layerOrderContainer) {
      layerOrderContainer.addEventListener("dragover", (e) =>
        e.preventDefault()
      );
    }
  }

  function updateLayerOrder() {
    const list = getElement("layer-order-list");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("li"));
    const totalVisible = items.length;

    // Update the 'order' property based on the new DOM order
    // Higher index in the DOM means lower order value (drawn first)
    // We want top item in UI (index 0) to have highest order number
    items.forEach((item, index) => {
      const layerName = item.dataset.layer;
      if (AppState.mapLayers[layerName]) {
        // Assign order descending from totalVisible
        AppState.mapLayers[layerName].order = totalVisible - index;
      }
    });

    console.log("Layer order updated:", AppState.mapLayers);
    debouncedUpdateMap(); // Redraw map with new layer order
  }

  // --- API Calls & Map Data ---
  // Wrapper for operations with loading indicator support
  async function withLoading(operationId, operation) {
    // Use modern-ui's loading manager if available
    const lm = window.loadingManager || {
      startOperation: (id) => console.log(`Loading started: ${id}`),
      finish: (id) => console.log(`Loading finished: ${id}`),
      updateProgress: (id, p, msg) =>
        console.log(`Loading progress ${id}: ${p}% ${msg || ""}`),
    };

    try {
      lm.startOperation(operationId);
      // Basic progress simulation
      lm.updateProgress(operationId, 10, "Starting...");
      const result = await operation(lm, operationId); // Pass lm and id if needed
      lm.updateProgress(operationId, 100, "Completed.");
      return result;
    } catch (error) {
      handleError(error, operationId); // Use global error handler
      lm.error?.(operationId, `Error during ${operationId}: ${error.message}`); // Use lm error if available
      throw error; // Re-throw if necessary for calling function
    } finally {
      lm.finish(operationId);
    }
  }

  async function fetchTrips() {
    return withLoading("FetchingTrips", async (lm, opId) => {
      const startDate = getStartDate();
      const endDate = getEndDate();

      if (!startDate || !endDate) {
        notificationManager.show("Invalid date range selected.", "warning");
        return; // Stop if dates are invalid
      }

      lm.updateProgress(opId, 20, "Requesting trip data...");
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const response = await fetch(`/api/trips?${params.toString()}`);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch trips: ${response.status} ${response.statusText}`
        );
      }

      const geojson = await response.json();
      lm.updateProgress(opId, 50, "Processing trip data...");

      // Update map and table concurrently
      await Promise.all([
        updateTripsTable(geojson), // Update DataTable if available
        updateMapWithTrips(geojson), // Update map layer data
      ]);

      lm.updateProgress(opId, 70, "Fetching matched trips...");
      // Fetch matched trips after main trips are processed
      try {
        await fetchMatchedTrips(); // Fetches and updates matchedTrips layer data
        lm.updateProgress(opId, 90, "Updating map display...");
        await updateMap(); // Update map display with both trip types
      } catch (err) {
        // Don't fail the whole operation if matched trips fail
        handleError(err, "Fetching Matched Trips");
      }

      document.dispatchEvent(
        new CustomEvent("tripsLoaded", {
          detail: { count: geojson?.features?.length || 0 },
        })
      );
      console.log(`Fetched ${geojson?.features?.length || 0} trips.`);
    });
  }

  async function updateTripsTable(geojson) {
    // Check if the trips table and its DataTable instance exist
    if (!window.tripsTable || typeof window.tripsTable.clear !== "function") {
      // console.log("Trips table or DataTable instance not found, skipping table update.");
      return;
    }

    try {
      const formattedTrips = geojson.features.map((feature) => {
        const props = feature.properties;
        return {
          ...props, // Include all original properties
          gps: feature.geometry, // Keep geometry if needed by table
          // Use DateUtils for consistent formatting
          startTimeFormatted: DateUtils.formatForDisplay(props.startTime, {
            dateStyle: "short",
            timeStyle: "short",
          }),
          endTimeFormatted: DateUtils.formatForDisplay(props.endTime, {
            dateStyle: "short",
            timeStyle: "short",
          }),
          startTimeRaw: props.startTime, // Keep raw dates if needed for sorting/filtering
          endTimeRaw: props.endTime,
          // Provide defaults for potentially missing properties
          destination: props.destination || "N/A",
          startLocation: props.startLocation || "N/A",
          distance:
            typeof props.distance === "number"
              ? props.distance.toFixed(2)
              : "0.00",
        };
      });

      // Use Promise to ensure draw completes before resolving
      return new Promise((resolve) => {
        window.tripsTable.clear().rows.add(formattedTrips).draw(false); // 'false' prevents resetting pagination
        // Allow a short time for DataTable to render
        setTimeout(resolve, 150);
      });
    } catch (error) {
      handleError(error, "Updating Trips Table");
      return Promise.reject(error); // Propagate error
    }
  }

  async function updateMapWithTrips(geojson) {
    // Basic validation of input
    if (!geojson || !Array.isArray(geojson.features)) {
      console.warn("Invalid GeoJSON data received for updating map trips.");
      AppState.mapLayers.trips.layer = {
        type: "FeatureCollection",
        features: [],
      }; // Clear layer data
    } else {
      // Assign the received GeoJSON directly to the layer's data store
      AppState.mapLayers.trips.layer = geojson;
    }
    // No need to call updateMap here; fetchTrips will call it after matched trips are fetched
    // await updateMap();
  }

  async function fetchMatchedTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      console.warn("Invalid date range for fetching matched trips.");
      AppState.mapLayers.matchedTrips.layer = {
        type: "FeatureCollection",
        features: [],
      }; // Clear layer
      return;
    }

    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const response = await fetch(`/api/matched_trips?${params.toString()}`);

      if (!response.ok) {
        // Handle non-OK responses gracefully, e.g., clear the layer
        console.warn(
          `Failed to fetch matched trips: ${response.status} ${response.statusText}`
        );
        AppState.mapLayers.matchedTrips.layer = {
          type: "FeatureCollection",
          features: [],
        };
        // Optionally throw if it's a critical error (e.g., 500)
        if (response.status >= 500) {
          throw new Error(
            `HTTP error fetching matched trips: ${response.status}`
          );
        }
        return; // Continue without matched trips for client errors like 404
      }

      const geojson = await response.json();
      // Assign fetched data, ensuring it's valid GeoJSON structure
      AppState.mapLayers.matchedTrips.layer =
        geojson && Array.isArray(geojson.features)
          ? geojson
          : { type: "FeatureCollection", features: [] };

      console.log(
        `Fetched ${AppState.mapLayers.matchedTrips.layer.features.length} matched trips.`
      );
    } catch (error) {
      // Catch network errors or JSON parsing errors
      console.error("Error during fetchMatchedTrips:", error);
      AppState.mapLayers.matchedTrips.layer = {
        type: "FeatureCollection",
        features: [],
      }; // Clear layer on error
      throw error; // Re-throw to be handled by the caller (fetchTrips)
    }
  }

  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      console.warn("Map not ready for update. Deferring.");
      // Optionally, set a flag or use a promise to retry later
      return;
    }

    AppState.layerGroup.clearLayers(); // Clear existing layers from the map group

    // Get layers sorted by draw order (ascending, lower order drawn first)
    const layersToDraw = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer) // Only visible layers with data
      .sort(([, a], [, b]) => (a.order || 99) - (b.order || 99));

    const tripLayerFeatures = new Map(); // To easily find layer by trip ID for bringToFront

    // Process each layer type
    await Promise.all(
      layersToDraw.map(async ([name, info]) => {
        try {
          if (name === "customPlaces") {
            // Custom places are managed externally, assume info.layer is an L.LayerGroup
            if (info.layer instanceof L.Layer) {
              info.layer.addTo(AppState.layerGroup);
            } else {
              console.warn(
                "Custom places layer data is not a valid Leaflet layer."
              );
            }
          } else if (
            ["trips", "matchedTrips"].includes(name) &&
            info.layer.features?.length > 0
          ) {
            // Standard GeoJSON layers (Trips, Matched Trips)
            const geoJsonLayer = L.geoJSON(info.layer, {
              style: (feature) => getTripFeatureStyle(feature, info), // Use styling function
              onEachFeature: (feature, layer) => {
                // Store reference for potential interactions
                if (feature.properties?.transactionId) {
                  tripLayerFeatures.set(
                    feature.properties.transactionId,
                    layer
                  );
                }
                // Attach click handler for popups and selection
                layer.on("click", (e) =>
                  handleTripClick(e, feature, layer, info, name)
                );
                // Add listener to setup popup events when popup opens
                layer.on("popupopen", () =>
                  setupPopupEventListeners(layer, feature)
                );
              },
              // Use pointToLayer for point features if needed (e.g., start/end markers)
              // pointToLayer: (feature, latlng) => { ... }
            });
            geoJsonLayer.addTo(AppState.layerGroup);
          }
        } catch (error) {
          handleError(error, `Processing layer ${name}`);
        }
      })
    );

    // After all layers are added, bring the selected trip to the front if it exists
    if (
      AppState.selectedTripId &&
      tripLayerFeatures.has(AppState.selectedTripId)
    ) {
      const selectedLayer = tripLayerFeatures.get(AppState.selectedTripId);
      if (selectedLayer?.bringToFront) {
        selectedLayer.bringToFront();
      }
    }

    // Fit map bounds if requested and layers were added
    if (fitBounds && layersToDraw.length > 0) {
      fitMapToBounds();
    }

    document.dispatchEvent(new CustomEvent("mapUpdated"));
    // console.log("Map display updated.");
  }

  function handleTripClick(e, feature, layer, layerInfo, layerName) {
    // Stop propagation to prevent map click event from firing (which deselects)
    L.DomEvent.stopPropagation(e);

    const clickedId = feature.properties?.transactionId;
    if (!clickedId) return; // Ignore clicks on features without an ID

    const wasSelected = AppState.selectedTripId === clickedId;

    // Toggle selection
    AppState.selectedTripId = wasSelected ? null : clickedId;

    // Close any existing popups before opening a new one or deselecting
    AppState.layerGroup.eachLayer((l) => {
      if (l.closePopup) l.closePopup();
    });

    if (!wasSelected) {
      // Create and open popup only if selecting
      try {
        const popupContent = createTripPopupContent(feature, layerName);
        layer
          .bindPopup(popupContent, {
            className: "trip-popup", // Custom class for styling
            maxWidth: 350,
            autoPan: true,
            autoPanPadding: L.point(50, 50), // Padding when panning
            closeButton: true,
          })
          .openPopup(e.latlng || layer.getBounds().getCenter()); // Open at click point or center
      } catch (error) {
        handleError(error, "Creating or opening trip popup");
        notificationManager.show("Error displaying trip details.", "danger");
        AppState.selectedTripId = null; // Deselect if popup fails
      }
    }

    // Refresh styles for all trips to reflect selection change
    refreshTripStyles();

    // Dispatch event for other components (like table highlighting)
    document.dispatchEvent(
      new CustomEvent("tripSelected", {
        detail: {
          id: AppState.selectedTripId, // Send current selected ID (null if deselected)
          tripData: wasSelected ? null : feature.properties,
        },
      })
    );
  }

  function createTripPopupContent(feature, layerName) {
    const props = feature.properties || {};
    const isMatched = layerName === "matchedTrips";

    // Normalize data using defaults and DateUtils
    const tripData = {
      id: props.tripId || props.id || props.transactionId || "N/A",
      startTime: props.startTime,
      endTime: props.endTime,
      distance: typeof props.distance === "number" ? props.distance : null,
      maxSpeed: props.maxSpeed ?? props.max_speed ?? null,
      averageSpeed: props.averageSpeed ?? props.average_speed ?? null,
      startLocation: props.startLocation || null,
      destination: props.destination || null,
      hardBrakingCount: parseInt(props.hardBrakingCount || 0, 10),
      hardAccelerationCount: parseInt(props.hardAccelerationCount || 0, 10),
      totalIdleDurationFormatted: props.totalIdleDurationFormatted || null, // Assumes pre-formatted string
    };

    // Format for display
    const startTimeDisplay = tripData.startTime
      ? DateUtils.formatForDisplay(tripData.startTime, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Unknown";
    const endTimeDisplay = tripData.endTime
      ? DateUtils.formatForDisplay(tripData.endTime, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "Unknown";
    const distanceDisplay =
      tripData.distance !== null
        ? `${tripData.distance.toFixed(2)} mi`
        : "Unknown";
    const durationDisplay =
      tripData.startTime && tripData.endTime
        ? DateUtils.formatDurationHMS(tripData.startTime, tripData.endTime)
        : "Unknown";

    // Format speed (assuming speed is in km/h, convert to mph)
    const formatSpeed = (speedKmh) => {
      if (speedKmh === null || speedKmh === undefined) return "Unknown";
      const speedMph = parseFloat(speedKmh) * 0.621371;
      return isNaN(speedMph) ? "Unknown" : `${speedMph.toFixed(1)} mph`;
    };
    const maxSpeedDisplay = formatSpeed(tripData.maxSpeed);
    const avgSpeedDisplay = formatSpeed(tripData.averageSpeed);

    // Build HTML using template literals for readability
    let html = `
      <div class="trip-popup-content">
        <h5 class="mb-2">${isMatched ? "Matched Trip" : "Trip"} Details</h5>
        <table class="table table-sm table-borderless popup-data mb-2">
          <tbody>
            ${
              tripData.startTime
                ? `<tr><th scope="row">Start:</th><td>${startTimeDisplay}</td></tr>`
                : ""
            }
            ${
              tripData.endTime
                ? `<tr><th scope="row">End:</th><td>${endTimeDisplay}</td></tr>`
                : ""
            }
            ${
              durationDisplay !== "Unknown"
                ? `<tr><th scope="row">Duration:</th><td>${durationDisplay}</td></tr>`
                : ""
            }
            ${
              distanceDisplay !== "Unknown"
                ? `<tr><th scope="row">Distance:</th><td>${distanceDisplay}</td></tr>`
                : ""
            }
            ${
              tripData.startLocation
                ? `<tr><th scope="row">From:</th><td title="${
                    typeof tripData.startLocation === "string"
                      ? tripData.startLocation
                      : ""
                  }">${
                    typeof tripData.startLocation === "object"
                      ? tripData.startLocation.formatted_address || "Unknown"
                      : tripData.startLocation
                  }</td></tr>`
                : ""
            }
            ${
              tripData.destination
                ? `<tr><th scope="row">To:</th><td title="${
                    typeof tripData.destination === "string"
                      ? tripData.destination
                      : ""
                  }">${
                    typeof tripData.destination === "object"
                      ? tripData.destination.formatted_address || "Unknown"
                      : tripData.destination
                  }</td></tr>`
                : ""
            }
            ${
              maxSpeedDisplay !== "Unknown"
                ? `<tr><th scope="row">Max Speed:</th><td>${maxSpeedDisplay}</td></tr>`
                : ""
            }
            ${
              avgSpeedDisplay !== "Unknown"
                ? `<tr><th scope="row">Avg Speed:</th><td>${avgSpeedDisplay}</td></tr>`
                : ""
            }
            ${
              tripData.totalIdleDurationFormatted
                ? `<tr><th scope="row">Idle Time:</th><td>${tripData.totalIdleDurationFormatted}</td></tr>`
                : ""
            }
            ${
              tripData.hardBrakingCount > 0
                ? `<tr><th scope="row">Hard Braking:</th><td>${tripData.hardBrakingCount}</td></tr>`
                : ""
            }
            ${
              tripData.hardAccelerationCount > 0
                ? `<tr><th scope="row">Hard Accel:</th><td>${tripData.hardAccelerationCount}</td></tr>`
                : ""
            }
          </tbody>
        </table>
        <div class="trip-actions d-flex justify-content-end" data-trip-id="${
          tripData.id
        }">`;

    // Action Buttons
    if (isMatched) {
      html += `<button class="btn btn-sm btn-outline-danger delete-matched-trip">Delete Match</button>`;
    } else {
      html += `
          <button class="btn btn-sm btn-outline-warning me-2 rematch-trip">Rematch</button>
          <button class="btn btn-sm btn-outline-danger delete-trip">Delete Trip</button>
      `;
    }

    html += `</div></div>`;
    return html;
  }

  function setupPopupEventListeners(layer, feature) {
    const popup = layer.getPopup();
    if (!popup) return;

    const popupEl = popup.getElement();
    if (!popupEl) return;

    // Use a named function for easier removal
    const handlePopupActionClick = async (e) => {
      const target = e.target.closest(
        "button[data-trip-id], button.delete-matched-trip, button.delete-trip, button.rematch-trip"
      );
      if (!target) return;

      // Prevent click from propagating further (e.g., closing popup immediately)
      e.stopPropagation();
      // L.DomEvent.stopPropagation(e); // Already done by browser's stopPropagation

      const tripId = target.closest(".trip-actions")?.dataset.tripId;
      if (!tripId) {
        console.warn("Could not find trip ID for popup action.");
        return;
      }

      // Determine action based on button class
      if (target.classList.contains("delete-matched-trip")) {
        await handleDeleteMatchedTrip(tripId, layer);
      } else if (target.classList.contains("delete-trip")) {
        await handleDeleteTrip(tripId, layer);
      } else if (target.classList.contains("rematch-trip")) {
        await handleRematchTrip(tripId, layer, feature);
      }
    };

    // Add listener using event delegation on the popup content
    popupEl.addEventListener("click", handlePopupActionClick);

    // Clean up listener when popup closes
    layer.off("popupclose"); // Remove previous listeners first
    layer.on("popupclose", () => {
      popupEl.removeEventListener("click", handlePopupActionClick);
      // console.log("Popup listeners removed for trip:", feature.properties?.transactionId);

      // Deselect trip when popup is closed manually by user
      // Check if the popup closing corresponds to the currently selected trip
      if (AppState.selectedTripId === feature.properties?.transactionId) {
        // Deselect only if the popup was closed explicitly, not due to another click
        // This logic might need refinement depending on exact desired behavior
        // setTimeout(() => { // Delay check slightly
        //     if (!AppState.map.hasLayer(popup)) { // Check if popup is truly gone
        //         AppState.selectedTripId = null;
        //         refreshTripStyles();
        //         document.dispatchEvent(new CustomEvent("tripSelected", { detail: { id: null } }));
        //     }
        // }, 50);
      }
    });
    // console.log("Popup listeners added for trip:", feature.properties?.transactionId);
  }

  async function handleDeleteMatchedTrip(tripId, layer) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Matched Trip",
      message: `Are you sure you want to delete the matched data for trip ID ${tripId}? The original trip will remain.`,
      confirmText: "Delete Match",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) return;

    layer.closePopup(); // Close popup before making request
    return withLoading(`DeleteMatchedTrip_${tripId}`, async () => {
      const response = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          `Failed to delete matched trip: ${response.statusText}`
        );
      }
      notificationManager.show("Matched trip data deleted.", "success");
      await fetchTrips(); // Refresh all trip data
    });
  }

  async function handleDeleteTrip(tripId, layer) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message: `Delete trip ID ${tripId}? This action cannot be undone and will also remove any associated matched trip data.`,
      confirmText: "Delete Permanently",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) return;

    layer.closePopup();
    return withLoading(`DeleteTrip_${tripId}`, async () => {
      // Attempt to delete both original and matched trip, ignore error on matched if it doesn't exist
      const tripRes = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!tripRes.ok && tripRes.status !== 404) {
        // Allow 404 if already deleted
        throw new Error(
          `Failed to delete original trip: ${tripRes.statusText}`
        );
      }

      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      } catch (e) {
        console.warn(
          `Could not delete matched trip for ${tripId} (may not exist): ${e.message}`
        );
      }

      notificationManager.show("Trip deleted successfully.", "success");
      await fetchTrips(); // Refresh all trip data
    });
  }

  async function handleRematchTrip(tripId, layer, feature) {
    const confirmed = await confirmationDialog.show({
      title: "Re-match Trip",
      message: `Re-match trip ID ${tripId}? This will replace any existing matched data for this specific trip.`,
      confirmText: "Re-match",
      confirmButtonClass: "btn-warning",
    });

    if (!confirmed) return;

    layer.closePopup();
    return withLoading(`RematchTrip_${tripId}`, async () => {
      // Get precise start/end times for the specific trip if possible
      const startTime = feature.properties?.startTime
        ? DateUtils.formatDate(feature.properties.startTime, null)
        : null; // Use ISO format
      const endTime = feature.properties?.endTime
        ? DateUtils.formatDate(feature.properties.endTime, null)
        : null;

      if (!startTime || !endTime) {
        throw new Error(
          "Cannot re-match trip without valid start and end times."
        );
      }

      // No need to explicitly delete first, the map_match endpoint should handle replacement or update
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Send specific trip ID and its time range for targeted matching
          trip_id: tripId,
          start_date: startTime,
          end_date: endTime,
          force_rematch: true, // Explicitly force this single trip
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})); // Try to get error details
        throw new Error(
          `Failed to re-match trip: ${errorData.message || response.statusText}`
        );
      }

      const result = await response.json();
      notificationManager.show(
        `Trip re-matched successfully. ${
          result.matched_count || 0
        } segments updated.`,
        "success"
      );
      await fetchTrips(); // Refresh all trip data
    });
  }

  function fitMapToBounds() {
    if (!AppState.map) return;

    const bounds = L.latLngBounds();
    let hasValidBounds = false;

    // Iterate through visible layers to calculate combined bounds
    Object.values(AppState.mapLayers).forEach((info) => {
      if (info.visible && info.layer) {
        let layerBounds = null;
        try {
          if (info.layer instanceof L.Layer) {
            // Handle Leaflet LayerGroups (like customPlaces)
            if (typeof info.layer.getBounds === "function") {
              layerBounds = info.layer.getBounds();
            }
          } else if (
            info.layer.type === "FeatureCollection" &&
            info.layer.features?.length > 0
          ) {
            // Handle GeoJSON data by creating a temporary layer
            layerBounds = L.geoJSON(info.layer).getBounds();
          }

          if (layerBounds?.isValid()) {
            bounds.extend(layerBounds);
            hasValidBounds = true;
          }
        } catch (e) {
          console.warn("Could not get bounds for a visible layer:", e);
        }
      }
    });

    // Fit bounds if valid bounds were found
    if (hasValidBounds) {
      AppState.map.flyToBounds(bounds, {
        padding: CONFIG.MAP.mapBoundsPadding, // Add padding
        maxZoom: CONFIG.MAP.maxZoom, // Don't zoom in too far
        duration: 1.0, // Animation duration
      });
    } else {
      console.log(
        "No valid bounds found for visible layers, cannot fit bounds."
      );
      // Optionally reset to default view if no bounds found
      // AppState.map.flyTo(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
    }
  }

  // --- Standalone Actions (called via UI or other modules) ---
  async function mapMatchTrips() {
    // This function triggers matching for the *currently selected date range*
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      notificationManager.show(
        "Select a valid date range before map matching.",
        "warning"
      );
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Map Match Trips",
      message: `Map match all trips between ${startDate} and ${endDate}? This may take some time and overwrite existing matched data in this range.`,
      confirmText: "Start Matching",
      confirmButtonClass: "btn-primary",
    });

    if (!confirmed) return;

    return withLoading("MapMatchingRange", async (lm, opId) => {
      lm.updateProgress(opId, 10, "Sending map match request...");
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          // force_rematch: false // Default to not forcing unless specified
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Map matching failed: ${errorData.message || response.statusText}`
        );
      }

      const results = await response.json();
      lm.updateProgress(opId, 80, "Map matching complete, refreshing data...");
      notificationManager.show(
        `Map matching completed. ${
          results.matched_count || 0
        } trips processed.`,
        "success"
      );

      await fetchTrips(); // Refresh map and table data

      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", { detail: { results } })
      );
    });
  }

  async function fetchTripsInRange() {
    // This function triggers fetching *raw* trips from an external source for the selected range
    const startDate = getStartDate();
    const endDate = getEndDate();

    if (!startDate || !endDate) {
      notificationManager.show(
        "Select a valid date range before fetching.",
        "warning"
      );
      return;
    }

    const confirmed = await confirmationDialog.show({
      title: "Fetch Trips from Source",
      message: `Fetch raw trip data from the source system for the period ${startDate} to ${endDate}? This might take time and potentially retrieve many trips.`,
      confirmText: "Fetch Data",
      confirmButtonClass: "btn-info",
    });

    if (!confirmed) return;

    return withLoading("FetchTripsRange", async (lm, opId) => {
      lm.updateProgress(opId, 10, "Requesting data fetch...");
      const response = await fetch("/api/fetch_trips_range", {
        // Ensure this endpoint exists and does what's expected
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Failed to fetch trips from source: ${
            errorData.message || response.statusText
          }`
        );
      }

      const data = await response.json();
      lm.updateProgress(
        opId,
        80,
        "Fetch request successful, refreshing data..."
      );

      if (data.status === "success") {
        notificationManager.show(
          data.message || "Successfully fetched trips from source.",
          "success"
        );
        await fetchTrips(); // Refresh map and table with newly fetched data
      } else {
        // Handle cases where the API call succeeded but the operation failed server-side
        throw new Error(
          data.message ||
            "Unknown error occurred while fetching trips from source."
        );
      }
    });
  }

  async function fetchMetrics() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    // const imei = getElement("imei")?.value || ""; // Get IMEI if filter exists

    if (!startDate || !endDate) return; // Don't fetch if date range is invalid

    try {
      // Add IMEI to params if available and needed by the endpoint
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      // if (imei) params.append('imei', imei);

      const response = await fetch(`/api/metrics?${params.toString()}`);
      if (!response.ok) {
        // Don't show error for 404 (no data), just clear metrics
        if (response.status === 404) {
          console.log("No metrics data found for the selected range.");
          clearMetricsUI();
          return;
        }
        throw new Error(`Failed to fetch metrics: ${response.statusText}`);
      }

      const metrics = await response.json();
      updateMetricsUI(metrics);

      document.dispatchEvent(
        new CustomEvent("metricsUpdated", { detail: { metrics } })
      );
    } catch (err) {
      handleError(err, "Fetching Metrics");
      clearMetricsUI(); // Clear UI on error
    }
  }

  function updateMetricsUI(metrics) {
    // Map API metric names to DOM element IDs (adjust if IDs differ)
    const metricMap = {
      "total-trips": metrics.total_trips ?? 0,
      "total-distance": metrics.total_distance?.toFixed(1) ?? "0.0",
      "avg-distance": metrics.avg_distance?.toFixed(1) ?? "0.0",
      "avg-start-time": metrics.avg_start_time || "--:--",
      "avg-driving-time": metrics.avg_driving_time || "--:--",
      "avg-speed": metrics.avg_speed?.toFixed(1) ?? "0.0", // Value only
      "max-speed": metrics.max_speed?.toFixed(1) ?? "0.0", // Value only
    };

    for (const [id, value] of Object.entries(metricMap)) {
      const el = getElement(id, false); // Don't cache metric elements if they might be recreated
      if (el) {
        // Handle elements that need units appended
        if (id.includes("-speed")) {
          el.textContent = `${value} mph`;
        } else if (id.includes("-distance")) {
          el.textContent = `${value} miles`;
        } else {
          el.textContent = value;
        }
      } else {
        // console.warn(`Metric element #${id} not found.`);
      }
    }
  }

  function clearMetricsUI() {
    const metricIds = [
      "total-trips",
      "total-distance",
      "avg-distance",
      "avg-start-time",
      "avg-driving-time",
      "avg-speed",
      "max-speed",
    ];
    metricIds.forEach((id) => {
      const el = getElement(id, false);
      if (el) {
        if (id.includes("-speed")) el.textContent = "0 mph";
        else if (id.includes("-distance")) el.textContent = "0 miles";
        else if (id.includes("-time")) el.textContent = "--:--";
        else el.textContent = "0";
      }
    });
    console.log("Metrics UI cleared.");
  }

  // --- Event Listeners Setup ---
  function initializeEventListeners() {
    // Listen for filter changes applied via modern-ui.js
    document.addEventListener("filtersApplied", (e) => {
      console.log("Filters applied event received:", e.detail);
      // Fetch data based on the new date range stored by modern-ui
      fetchTrips();
      fetchMetrics();
    });

    // Listener for toggling controls panel (managed within app.js)
    addSingleEventListener("controls-toggle", "click", function () {
      const mapControls = getElement("map-controls");
      const controlsContent = getElement("controls-content");
      const icon = this.querySelector("i");

      if (mapControls) {
        const isMinimized = mapControls.classList.toggle("minimized");

        // Use Bootstrap's Collapse API if available
        if (controlsContent && window.bootstrap?.Collapse) {
          const bsCollapse =
            bootstrap.Collapse.getOrCreateInstance(controlsContent);
          isMinimized ? bsCollapse.hide() : bsCollapse.show();
        } else {
          // Fallback basic toggle (might not have animations)
          controlsContent.style.display = isMinimized ? "none" : "";
        }

        // Update icon
        if (icon) {
          icon.classList.toggle("fa-chevron-up", !isMinimized);
          icon.classList.toggle("fa-chevron-down", isMinimized);
        }
        // Invalidate map size after animation to ensure it redraws correctly
        setTimeout(() => AppState.map?.invalidateSize(), 350);
      }
    });

    // Listener for highlight recent trips toggle
    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      refreshTripStyles(); // Update styles immediately
    });

    // --- Map Controls Interaction Blocker ---
    const mapControlsElement = getElement("map-controls");
    if (mapControlsElement && typeof L !== "undefined" && L.DomEvent) {
      const eventsToStop = [
        "mousedown",
        "wheel",
        "dblclick",
        "touchstart",
        "pointerdown",
        "mousemove",
        "touchmove", // Stop move events too for robustness
      ];

      eventsToStop.forEach((eventType) => {
        // Stop propagation to prevent events reaching the map
        L.DomEvent.on(
          mapControlsElement,
          eventType,
          L.DomEvent.stopPropagation
        );

        // Additionally, prevent default wheel behavior (scrolling page) when over controls
        if (eventType === "wheel") {
          L.DomEvent.on(
            mapControlsElement,
            eventType,
            L.DomEvent.preventDefault
          );
        }
      });
      console.log("Attached map interaction blockers to #map-controls.");
    } else {
      console.warn(
        "Could not attach map interaction blockers: #map-controls or L.DomEvent missing."
      );
    }

    // Listen for actions triggered by modern-ui's FAB or other UI elements
    document.addEventListener("fabActionTriggered", (e) => {
      const action = e.detail?.action;
      console.log(`FAB Action received: ${action}`);
      switch (action) {
        case "map-match":
          mapMatchTrips();
          break;
        case "fetch-trips": // Assuming this means fetch from source
          fetchTripsInRange();
          break;
        // Add cases for other actions if needed
      }
    });

    // Add listener for custom place drawing start if needed
    // document.addEventListener('startPlaceDrawing', () => { ... });
  }

  // --- Initialization ---
  function initializeDOMCache() {
    // Cache static elements likely to be reused
    AppState.dom["map"] = getElement("map");
    AppState.dom["map-controls"] = getElement("map-controls");
    AppState.dom["controls-toggle"] = getElement("controls-toggle");
    AppState.dom["controls-content"] = getElement("controls-content");
    AppState.dom["layer-toggles"] = getElement("layer-toggles");
    AppState.dom["layer-order"] = getElement("layer-order");
    AppState.dom["highlight-recent-trips"] = getElement(
      "highlight-recent-trips"
    );
    // Add other frequently used static elements if necessary
  }

  function setInitialDates() {
    // Ensure default dates are set in storage if not already present
    // modern-ui.js also handles this, but this provides a fallback
    const today = DateUtils.getCurrentDate();
    if (utils.getStorage(CONFIG.STORAGE_KEYS.startDate) === null) {
      utils.setStorage(CONFIG.STORAGE_KEYS.startDate, today);
    }
    if (utils.getStorage(CONFIG.STORAGE_KEYS.endDate) === null) {
      utils.setStorage(CONFIG.STORAGE_KEYS.endDate, today);
    }
  }

  async function initialize() {
    console.log("Initializing EveryStreet App...");
    setInitialDates();
    initializeDOMCache();
    initializeEventListeners(); // Set up listeners early

    // Initialize map only if the map container exists
    if (AppState.dom.map) {
      try {
        await initializeMap(); // Initialize map and center it

        if (!isMapReady()) {
          // Error handled within initializeMap, but double-check
          throw new Error("Map components failed to initialize properly.");
        }

        initializeLayerControls(); // Setup layer toggles/order based on mapLayers

        // Perform initial data fetch after map is ready
        console.log("Performing initial data fetch...");
        await Promise.all([fetchTrips(), fetchMetrics()]);

        document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        console.log("EveryStreet App initialized successfully.");
      } catch (error) {
        handleError(error, "Application Initialization");
        // No need for notification here, initializeMap or fetch functions handle their errors
      }
    } else {
      console.log(
        "Map container not found, skipping map initialization and data fetch."
      );
    }
  }

  // --- Global Event Listeners ---
  document.addEventListener("DOMContentLoaded", initialize);

  // --- Public API ---
  // Expose functions needed by other modules or for debugging
  window.EveryStreet = window.EveryStreet || {};
  window.EveryStreet.App = {
    fetchTrips,
    fetchMetrics,
    updateMap,
    refreshTripStyles,
    toggleLayer,
    fitMapToBounds,
    mapMatchTrips,
    fetchTripsInRange,
  };
})(); // End IIFE
