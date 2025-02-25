/* global L, flatpickr, notificationManager, LiveTripTracker, loadingManager, confirmationDialog */

(() => {
  "use strict";

  // ==============================
  // Configuration & Constants
  // ==============================

  const CONFIG = {
    MAP: {
      defaultCenter: [37.0902, -95.7129],
      defaultZoom: 4,
      tileLayerUrl:
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours in milliseconds
      debounceDelay: 100,
    },
    REFRESH: {
      minPollingInterval: 1000, // Minimum time between street coverage polls
      maxPollDelay: 8000, // Maximum polling delay after retries
    },
  };

  const LAYER_DEFAULTS = {
    trips: {
      order: 1,
      color: "#BB86FC",
      opacity: 0.4,
      visible: true,
      highlightColor: "#FFD700",
    },
    historicalTrips: {
      order: 2,
      color: "#03DAC6",
      opacity: 0.4,
      visible: false,
      highlightColor: "#FFD700",
    },
    matchedTrips: {
      order: 3,
      color: "#CF6679",
      opacity: 0.4,
      visible: false,
      highlightColor: "#40E0D0",
    },
    osmBoundary: {
      order: 4,
      color: "#03DAC6",
      opacity: 0.7,
      visible: false,
    },
    osmStreets: {
      order: 5,
      color: "#FF0266",
      opacity: 0.7,
      visible: false,
    },
    streetCoverage: {
      order: 6,
      color: "#00FF00",
      opacity: 0.7,
      name: "Street Coverage",
      visible: false,
    },
    customPlaces: {
      order: 7,
      color: "#FF9800",
      opacity: 0.5,
      visible: false,
    },
  };

  // ==============================
  // Utility Functions
  // ==============================

  /**
   * Safely queries a DOM element with optional warning
   * @param {string} selector - CSS selector for the element
   * @param {Document|Element} context - Context for the query (defaults to document)
   * @param {boolean} warnOnMissing - Whether to log a warning if element is not found
   * @returns {Element|null} - The found element or null
   */
  const safeQuerySelector = (
    selector,
    context = document,
    warnOnMissing = true,
  ) => {
    const element = context.querySelector(selector);
    if (!element && warnOnMissing) {
      console.warn(`Element not found: ${selector}`);
    }
    return element;
  };

  /**
   * Returns a debounced version of the provided function.
   * @param {Function} func - The function to debounce.
   * @param {number} delay - Delay in ms.
   * @returns {Function}
   */
  const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(null, args), delay);
    };
  };

  /**
   * Central error handler that logs the error and shows a notification.
   * @param {Error} error - The error object
   * @param {string} context - Context where the error occurred
   * @param {Function} [onComplete] - Optional callback after error handling
   */
  const handleError = (error, context = "", onComplete = null) => {
    console.error(`Error in ${context}:`, error);
    notificationManager.show(`Error in ${context}: ${error.message}`, "danger");
    if (typeof onComplete === "function") {
      onComplete();
    }
  };

  // ==============================
  // State & Global Variables
  // ==============================

  // DOM Cache for frequently accessed elements
  const DOMCache = {};

  // Map state
  const mapLayers = { ...LAYER_DEFAULTS };
  const mapSettings = { highlightRecentTrips: true };

  let map, layerGroup, liveTracker;
  let mapInitialized = false;
  let selectedTripId = null;

  // Debounced functions
  const debouncedUpdateMap = debounce(
    () => updateMap(),
    CONFIG.MAP.debounceDelay,
  );

  // ==============================
  // Date & Filter Helper Functions
  // ==============================

  /**
   * Gets the start date from input or localStorage
   * @returns {string} The start date in YYYY-MM-DD format
   */
  const getStartDate = () => {
    return (
      (DOMCache.startDateInput && DOMCache.startDateInput.value) ||
      document.getElementById("start-date")?.value
    );
  };

  /**
   * Gets the end date from input or localStorage
   * @returns {string} The end date in YYYY-MM-DD format
   */
  const getEndDate = () => {
    return (
      (DOMCache.endDateInput && DOMCache.endDateInput.value) ||
      document.getElementById("end-date")?.value
    );
  };

  /**
   * Creates URL parameters for date filtering
   * @returns {URLSearchParams} The URL parameters
   */
  const getFilterParams = () => {
    return new URLSearchParams({
      start_date: getStartDate(),
      end_date: getEndDate(),
    });
  };

  /**
   * Updates the date pickers and stores in localStorage
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   */
  const updateDatePickersAndStore = (startDate, endDate) => {
    const startFP = DOMCache.startDateInput?._flatpickr;
    const endFP = DOMCache.endDateInput?._flatpickr;

    if (startFP && endFP) {
      startFP.setDate(startDate);
      endFP.setDate(endDate);
    }

    localStorage.setItem("startDate", startDate.toISOString().split("T")[0]);
    localStorage.setItem("endDate", endDate.toISOString().split("T")[0]);
  };

  // ==============================
  // Map Feature Styling
  // ==============================

  /**
   * Generates styling for trip features
   * @param {Object} feature - GeoJSON feature
   * @param {Object} info - Layer info
   * @returns {Object} Leaflet path style options
   */
  const getTripFeatureStyle = (feature, info) => {
    const sixHoursAgo = Date.now() - CONFIG.MAP.recentTripThreshold;
    const startTime = new Date(feature.properties.startTime).getTime();
    const highlight =
      mapSettings.highlightRecentTrips && startTime > sixHoursAgo;
    const isSelected = feature.properties.transactionId === selectedTripId;
    const isMatchedPair =
      feature.properties.transactionId === selectedTripId ||
      (selectedTripId &&
        feature.properties.transactionId &&
        (selectedTripId.replace("MATCHED-", "") ===
          feature.properties.transactionId ||
          feature.properties.transactionId.replace("MATCHED-", "") ===
            selectedTripId));

    return {
      color: isSelected
        ? info.highlightColor
        : isMatchedPair
          ? info === mapLayers.matchedTrips
            ? mapLayers.matchedTrips.highlightColor
            : mapLayers.trips.highlightColor
          : highlight
            ? "#FF5722"
            : info.color,
      weight: isSelected || isMatchedPair ? 5 : highlight ? 4 : 2,
      opacity:
        isSelected || isMatchedPair ? 0.9 : highlight ? 0.8 : info.opacity,
      className: highlight ? "recent-trip" : "",
      zIndexOffset: isSelected || isMatchedPair ? 1000 : 0,
    };
  };

  // ==============================
  // Map Initialization & Controls
  // ==============================

  /**
   * Initializes the map and base layers
   * @returns {Promise<void>}
   */
  const initializeMap = async () => {
    if (mapInitialized || !document.getElementById("map")) return;

    try {
      map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: true,
        attributionControl: false,
        maxBounds: [
          [-90, -180],
          [90, 180],
        ],
      });

      window.map = map;

      L.tileLayer(CONFIG.MAP.tileLayerUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        attribution: "",
      }).addTo(map);

      layerGroup = L.layerGroup().addTo(map);
      mapLayers.customPlaces.layer = L.layerGroup();

      // Initialize live trip tracker
      initializeLiveTracker();

      try {
        // Try to center map on last known position
        await centerMapOnLastPosition();
      } catch (error) {
        handleError(error, "Fetching Last Trip Point");
        map.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      } finally {
        mapInitialized = true;
      }
    } catch (error) {
      handleError(error, "Map Initialization");
    }
  };

  /**
   * Initializes the live trip tracker
   */
  const initializeLiveTracker = () => {
    if (!window.liveTracker) {
      try {
        window.liveTracker = new LiveTripTracker(map);
      } catch (error) {
        handleError(error, "LiveTripTracker Initialization");
      }
    }
  };

  /**
   * Centers the map on the last known position
   * @returns {Promise<void>}
   */
  const centerMapOnLastPosition = async () => {
    const response = await fetch("/api/last_trip_point");
    const data = await response.json();
    const lastPoint = data.lastPoint;

    if (lastPoint) {
      map.flyTo([lastPoint[1], lastPoint[0]], 11, {
        duration: 2,
        easeLinearity: 0.25,
      });
    } else {
      map.setView([31.55002, -97.123354], 14);
    }
  };

  /**
   * Initializes layer control UI elements
   */
  const initializeLayerControls = () => {
    DOMCache.layerToggles = document.getElementById("layer-toggles");
    if (!DOMCache.layerToggles) {
      console.warn("No 'layer-toggles' element found.");
      return;
    }

    DOMCache.layerToggles.innerHTML = "";

    Object.entries(mapLayers).forEach(([name, info]) => {
      const showControls = !["streetCoverage", "customPlaces"].includes(name);

      const colorPicker = showControls
        ? `<input type="color" id="${name}-color" value="${info.color}">`
        : "";

      const opacitySlider = showControls
        ? `<label for="${name}-opacity">Opacity:</label>
           <input type="range" id="${name}-opacity" min="0" max="1" step="0.1" value="${info.opacity}">`
        : "";

      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${info.visible ? "checked" : ""}>
          <span class="checkmark"></span>
        </label>
        <label for="${name}-toggle">${info.name || name}</label>
        ${colorPicker}
        ${opacitySlider}
      `;

      DOMCache.layerToggles.appendChild(div);
    });

    // Use event delegation for layer controls
    DOMCache.layerToggles.addEventListener("change", handleLayerControlsChange);
    DOMCache.layerToggles.addEventListener("input", handleLayerControlsInput);

    updateLayerOrderUI();
  };

  /**
   * Handles change events on layer control checkboxes
   * @param {Event} e - The change event
   */
  const handleLayerControlsChange = (e) => {
    const target = e.target;
    if (target.matches('input[type="checkbox"]')) {
      const layerName = target.id.replace("-toggle", "");
      toggleLayer(layerName, target.checked);
    }
  };

  /**
   * Handles input events on layer control sliders and color pickers
   * @param {Event} e - The input event
   */
  const handleLayerControlsInput = (e) => {
    const target = e.target;
    if (target.matches('input[type="color"]')) {
      const layerName = target.id.replace("-color", "");
      changeLayerColor(layerName, target.value);
    }
    if (target.matches('input[type="range"]')) {
      const layerName = target.id.replace("-opacity", "");
      changeLayerOpacity(layerName, parseFloat(target.value));
    }
  };

  /**
   * Toggles visibility of a map layer
   * @param {string} name - Layer name
   * @param {boolean} visible - Visibility state
   */
  const toggleLayer = (name, visible) => {
    if (mapLayers[name]) {
      mapLayers[name].visible = visible;
      if (name === "customPlaces" && window.customPlaces) {
        window.customPlaces.toggleVisibility(visible);
      } else {
        debouncedUpdateMap();
      }
      updateLayerOrderUI();
    } else {
      console.warn(`Layer "${name}" not found.`);
    }
  };

  /**
   * Changes the color of a map layer
   * @param {string} name - Layer name
   * @param {string} color - Color value
   */
  const changeLayerColor = (name, color) => {
    if (mapLayers[name]) {
      mapLayers[name].color = color;
      debouncedUpdateMap();
    }
  };

  /**
   * Changes the opacity of a map layer
   * @param {string} name - Layer name
   * @param {number} opacity - Opacity value (0-1)
   */
  const changeLayerOpacity = (name, opacity) => {
    if (mapLayers[name]) {
      mapLayers[name].opacity = opacity;
      debouncedUpdateMap();
    }
  };

  /**
   * Updates the layer order UI
   */
  const updateLayerOrderUI = () => {
    DOMCache.layerOrder = document.getElementById("layer-order");
    if (!DOMCache.layerOrder) {
      console.warn("layer-order element not found.");
      return;
    }

    DOMCache.layerOrder.innerHTML = '<h4 class="h6">Layer Order</h4>';

    const ordered = Object.entries(mapLayers)
      .filter(([, v]) => v.visible)
      .sort(([, a], [, b]) => b.order - a.order);

    const ul = document.createElement("ul");
    ul.id = "layer-order-list";
    ul.className = "list-group bg-dark";

    ordered.forEach(([lname]) => {
      const li = document.createElement("li");
      li.textContent = lname;
      li.draggable = true;
      li.dataset.layer = lname;
      li.className = "list-group-item bg-dark text-white";
      ul.appendChild(li);
    });

    DOMCache.layerOrder.appendChild(ul);
    initializeDragAndDrop();
  };

  /**
   * Initializes drag and drop for layer order
   */
  const initializeDragAndDrop = () => {
    const list = document.getElementById("layer-order-list");
    if (!list) return;

    let dragged = null;

    list.addEventListener("dragstart", (e) => {
      dragged = e.target;
      e.dataTransfer.effectAllowed = "move";
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target.closest("li");
      if (target && target !== dragged) {
        const rect = target.getBoundingClientRect();
        const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
        list.insertBefore(dragged, next ? target.nextSibling : target);
      }
    });

    list.addEventListener("dragend", debounce(updateLayerOrder, 50));
  };

  /**
   * Updates the map layer order from UI
   */
  const updateLayerOrder = () => {
    const list = document.getElementById("layer-order-list");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("li"));
    const total = items.length;

    items.forEach((item, i) => {
      const lname = item.dataset.layer;
      if (mapLayers[lname]) {
        mapLayers[lname].order = total - i;
      }
    });

    debouncedUpdateMap();
  };

  // ==============================
  // API Calls & Map Data Functions
  // ==============================

  /**
   * Fetches trips data and updates the map
   * @returns {Promise<void>}
   */
  const fetchTrips = async () => {
    loadingManager.startOperation("Fetching and Displaying Trips", 100);
    loadingManager.addSubOperation(
      "Fetching and Displaying Trips",
      "Fetching Data",
      50,
    );
    loadingManager.addSubOperation(
      "Fetching and Displaying Trips",
      "Processing Data",
      30,
    );
    loadingManager.addSubOperation(
      "Fetching and Displaying Trips",
      "Displaying Data",
      20,
    );

    try {
      const startDate = localStorage.getItem("startDate");
      const endDate = localStorage.getItem("endDate");

      if (!startDate || !endDate) {
        console.warn("No dates selected for fetching trips.");
        loadingManager.finish("Fetching and Displaying Trips");
        return;
      }

      if (DOMCache.startDateInput) DOMCache.startDateInput.value = startDate;
      if (DOMCache.endDateInput) DOMCache.endDateInput.value = endDate;

      loadingManager.updateSubOperation(
        "Fetching and Displaying Trips",
        "Fetching Data",
        25,
      );

      const params = getFilterParams();
      const response = await fetch(`/api/trips?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const geojson = await response.json();

      loadingManager.updateSubOperation(
        "Fetching and Displaying Trips",
        "Fetching Data",
        50,
      );
      loadingManager.updateSubOperation(
        "Fetching and Displaying Trips",
        "Processing Data",
        15,
      );

      await updateTripsTable(geojson);
      await updateMapWithTrips(geojson);

      loadingManager.updateSubOperation(
        "Fetching and Displaying Trips",
        "Processing Data",
        30,
      );
      loadingManager.updateSubOperation(
        "Fetching and Displaying Trips",
        "Displaying Data",
        10,
      );

      try {
        await fetchMatchedTrips();
      } catch (err) {
        handleError(err, "Fetching Matched Trips");
      } finally {
        loadingManager.updateSubOperation(
          "Fetching and Displaying Trips",
          "Displaying Data",
          20,
        );
      }
    } catch (error) {
      handleError(error, "Fetching Trips");
    } finally {
      loadingManager.finish("Fetching and Displaying Trips");
    }
  };

  /**
   * Updates the trips table with fetched data
   * @param {Object} geojson - GeoJSON data from API
   * @returns {Promise<void>}
   */
  const updateTripsTable = async (geojson) => {
    if (window.tripsTable) {
      const formattedTrips = geojson.features
        .filter((trip) => trip.properties.imei !== "HISTORICAL")
        .map((trip) => ({
          ...trip.properties,
          gps: trip.geometry,
          destination: trip.properties.destination || "N/A",
          startLocation: trip.properties.startLocation || "N/A",
          distance: Number(trip.properties.distance).toFixed(2),
        }));

      await new Promise((resolve) => {
        window.tripsTable.clear().rows.add(formattedTrips).draw();
        setTimeout(resolve, 100);
      });
    }
  };

  /**
   * Updates the map with trips data
   * @param {Object} geojson - GeoJSON data from API
   * @returns {Promise<void>}
   */
  const updateMapWithTrips = async (geojson) => {
    if (document.getElementById("map") && map && layerGroup) {
      mapLayers.trips.layer = {
        type: "FeatureCollection",
        features: geojson.features.filter(
          (f) => f.properties.imei !== "HISTORICAL",
        ),
      };

      mapLayers.historicalTrips.layer = {
        type: "FeatureCollection",
        features: geojson.features.filter(
          (f) => f.properties.imei === "HISTORICAL",
        ),
      };

      await updateMap();
    }
  };

  /**
   * Fetches matched trips data
   * @returns {Promise<void>}
   */
  const fetchMatchedTrips = async () => {
    const params = getFilterParams();
    const url = `/api/matched_trips?${params.toString()}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `HTTP error fetching matched trips: ${response.status}`,
        );
      }

      const geojson = await response.json();
      mapLayers.matchedTrips.layer = geojson;
    } catch (error) {
      handleError(error, "Fetching Matched Trips");
    }
  };

  /**
   * Updates the map with current layer data
   * @param {boolean} fitBounds - Whether to fit bounds to visible layers
   * @returns {Promise<void>}
   */
  const updateMap = async (fitBounds = false) => {
    if (!layerGroup) return;

    layerGroup.clearLayers();

    const visibleLayers = Object.entries(mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => a.order - b.order);

    const tripLayers = new Map();

    await Promise.all(
      visibleLayers.map(async ([name, info]) => {
        if (["streetCoverage", "customPlaces"].includes(name)) {
          info.layer.addTo(layerGroup);
        } else if (
          ["trips", "historicalTrips", "matchedTrips"].includes(name)
        ) {
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info),
            onEachFeature: (feature, lyr) => {
              tripLayers.set(feature.properties.transactionId, lyr);
              lyr.on("click", (e) =>
                handleTripClick(e, feature, lyr, info, name),
              );
              lyr.on("popupopen", () => setupPopupEventListeners(lyr, feature));
            },
          });
          geoJsonLayer.addTo(layerGroup);
        } else if (["osmBoundary", "osmStreets"].includes(name)) {
          info.layer
            .setStyle({ color: info.color, opacity: info.opacity })
            .addTo(layerGroup);
        }
      }),
    );

    // Bring selected trip to front
    if (selectedTripId && tripLayers.has(selectedTripId)) {
      tripLayers.get(selectedTripId)?.bringToFront();
    }

    // Fit bounds if requested
    if (fitBounds) {
      fitMapBounds();
    }
  };

  /**
   * Handles click on a trip feature
   * @param {L.MouseEvent} e - Click event
   * @param {Object} feature - GeoJSON feature
   * @param {L.Layer} lyr - Leaflet layer
   * @param {Object} info - Layer info
   * @param {string} name - Layer name
   */
  const handleTripClick = (e, feature, lyr, info, name) => {
    const clickedId = feature.properties.transactionId;
    const wasSelected = selectedTripId === clickedId;

    selectedTripId = wasSelected ? null : clickedId;

    // Close all popups
    layerGroup.eachLayer((layer) => layer.closePopup && layer.closePopup());

    if (!wasSelected) {
      // Create and open popup with trip details
      const popupContent = createTripPopupContent(feature, name);

      lyr
        .bindPopup(popupContent, {
          className: "trip-popup",
          maxWidth: 300,
          autoPan: true,
        })
        .openPopup(e.latlng);
    }

    // Update styles for all trip layers
    layerGroup.eachLayer((layer) => {
      if (layer.feature?.properties && layer.setStyle) {
        const infoObj =
          layer.feature.properties.imei !== "HISTORICAL"
            ? mapLayers.trips
            : mapLayers.historicalTrips;
        layer.setStyle(getTripFeatureStyle(layer.feature, infoObj));
      }
    });
  };

  /**
   * Creates popup content for a trip
   * @param {Object} feature - GeoJSON feature
   * @param {string} layerName - Layer name
   * @returns {string} HTML content for popup
   */
  const createTripPopupContent = (feature, layerName) => {
    const timezone = feature.properties.timezone || "America/Chicago";
    const startTime = new Date(feature.properties.startTime);
    const endTime = new Date(feature.properties.endTime);

    const formatter = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone,
      hour12: true,
    });

    return `
      <div class="trip-popup">
        <h4>Trip Details</h4>
        <p><strong>Start:</strong> ${formatter.format(startTime)}</p>
        <p><strong>End:</strong> ${formatter.format(endTime)}</p>
        <p><strong>Distance:</strong> ${Number(feature.properties.distance).toFixed(2)} miles</p>
        <p><strong>From:</strong> ${feature.properties.startLocation || "Unknown"}</p>
        <p><strong>To:</strong> ${feature.properties.destination || "Unknown"}</p>
        ${feature.properties.maxSpeed ? `<p><strong>Max Speed:</strong> ${Number(feature.properties.maxSpeed).toFixed(1)} mph</p>` : ""}
        ${feature.properties.averageSpeed ? `<p><strong>Avg Speed:</strong> ${Number(feature.properties.averageSpeed).toFixed(1)} mph</p>` : ""}
        ${feature.properties.totalIdleDurationFormatted ? `<p><strong>Idle Time:</strong> ${feature.properties.totalIdleDurationFormatted}</p>` : ""}
        <div class="mt-2">
          ${layerName === "trips" ? `<button class="btn btn-danger btn-sm me-2 delete-trip" data-trip-id="${feature.properties.transactionId}">Delete Trip</button>` : ""}
          ${
            layerName === "matchedTrips"
              ? `
            <button class="btn btn-danger btn-sm me-2 delete-matched-trip" data-trip-id="${feature.properties.transactionId}">Delete Matched Trip</button>
            <button class="btn btn-warning btn-sm rematch-trip" data-trip-id="${feature.properties.transactionId}">Re-match Trip</button>
          `
              : ""
          }
        </div>
      </div>
    `;
  };

  /**
   * Sets up event listeners for trip popup buttons
   * @param {L.Layer} lyr - Leaflet layer with popup
   * @param {Object} feature - GeoJSON feature
   */
  const setupPopupEventListeners = (lyr, feature) => {
    const popupEl = lyr.getPopup().getElement();
    if (!popupEl) return;

    // Use event delegation with a single handler
    const popupClickHandler = async (e) => {
      // Handle delete matched trip
      if (e.target.closest(".delete-matched-trip")) {
        e.preventDefault();
        await handleDeleteMatchedTrip(e.target.dataset.tripId, lyr);
      }
      // Handle delete trip
      else if (e.target.closest(".delete-trip")) {
        e.preventDefault();
        await handleDeleteTrip(e.target.dataset.tripId, lyr);
      }
      // Handle rematch trip
      else if (e.target.closest(".rematch-trip")) {
        e.preventDefault();
        await handleRematchTrip(e.target.dataset.tripId, lyr, feature);
      }
    };

    // Add a single event listener
    popupEl.addEventListener("click", popupClickHandler);

    // Clean up when popup is closed
    lyr.on("popupclose", () => {
      popupEl.removeEventListener("click", popupClickHandler);
    });
  };

  /**
   * Handles deleting a matched trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @returns {Promise<void>}
   */
  const handleDeleteMatchedTrip = async (tripId, layer) => {
    const confirmed = await confirmationDialog.show({
      title: "Delete Matched Trip",
      message: "Are you sure you want to delete this matched trip?",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (confirmed) {
      try {
        const res = await fetch(`/api/matched_trips/${tripId}`, {
          method: "DELETE",
        });

        if (!res.ok) throw new Error("Failed to delete");

        layer.closePopup();
        await fetchTrips();
        notificationManager.show("Trip deleted", "success");
      } catch (error) {
        handleError(error, "Deleting Matched Trip");
      }
    }
  };

  /**
   * Handles deleting a trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @returns {Promise<void>}
   */
  const handleDeleteTrip = async (tripId, layer) => {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message:
        "Delete this trip? This will also delete its corresponding matched trip.",
      confirmText: "Delete",
      confirmButtonClass: "btn-danger",
    });

    if (confirmed) {
      try {
        const tripRes = await fetch(`/api/trips/${tripId}`, {
          method: "DELETE",
        });

        if (!tripRes.ok) throw new Error("Failed to delete trip");

        // Try to delete matched trip but don't fail if not found
        try {
          await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
        } catch (e) {
          console.warn(
            "No matched trip found or failed to delete matched trip",
          );
        }

        layer.closePopup();
        await fetchTrips();
        notificationManager.show(
          "Trip and its matched trip deleted",
          "success",
        );
      } catch (error) {
        handleError(error, "Deleting Trip and Matched Trip");
      }
    }
  };

  /**
   * Handles rematching a trip
   * @param {string} tripId - Trip ID
   * @param {L.Layer} layer - Leaflet layer
   * @param {Object} feature - GeoJSON feature
   * @returns {Promise<void>}
   */
  const handleRematchTrip = async (tripId, layer, feature) => {
    const confirmed = await confirmationDialog.show({
      title: "Re-match Trip",
      message:
        "Re-match this trip? This will delete the existing matched trip and create a new one.",
      confirmText: "Re-match",
      confirmButtonClass: "btn-warning",
    });

    if (confirmed) {
      try {
        const deleteRes = await fetch(`/api/matched_trips/${tripId}`, {
          method: "DELETE",
        });

        if (!deleteRes.ok) {
          throw new Error("Failed to delete existing matched trip");
        }

        const rematchRes = await fetch("/api/map_match_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_date: feature.properties.startTime,
            end_date: feature.properties.endTime,
            trip_id: tripId,
          }),
        });

        if (!rematchRes.ok) throw new Error("Failed to re-match trip");

        layer.closePopup();
        await fetchTrips();
        notificationManager.show("Trip successfully re-matched", "success");
      } catch (error) {
        handleError(error, "Re-matching Trip");
      }
    }
  };

  /**
   * Fits the map bounds to visible layers
   */
  const fitMapBounds = () => {
    const bounds = L.latLngBounds();
    let validBounds = false;

    Object.entries(mapLayers).forEach(([, linfo]) => {
      if (linfo.visible && linfo.layer) {
        try {
          const b =
            typeof linfo.layer.getBounds === "function"
              ? linfo.layer.getBounds()
              : L.geoJSON(linfo.layer).getBounds();

          if (b?.isValid()) {
            bounds.extend(b);
            validBounds = true;
          }
        } catch (e) {
          // Ignore errors for invalid bounds
        }
      }
    });

    if (validBounds) map.fitBounds(bounds);
  };

  // ==============================
  // Location Validation & OSM Data
  // ==============================

  /**
   * Validates a location input
   * @returns {Promise<void>}
   */
  const validateLocation = async () => {
    const locInput = document.getElementById("location-input");
    const locType = document.getElementById("location-type");

    if (!locInput || !locType || !locInput.value || !locType.value) {
      notificationManager.show(
        "Please enter a location and select a location type.",
        "warning",
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
        notificationManager.show(
          "Location not found. Please check your input.",
          "warning",
        );
        return;
      }

      handleLocationValidationSuccess(data, locInput);
      notificationManager.show("Location validated successfully!", "success");
    } catch (err) {
      handleError(err, "Validating Location");
    }
  };

  /**
   * Handles successful location validation
   * @param {Object} data - Location data
   * @param {HTMLElement} locInput - Location input element
   */
  const handleLocationValidationSuccess = (data, locInput) => {
    window.validatedLocation = data;
    locInput.setAttribute("data-location", JSON.stringify(data));
    locInput.setAttribute(
      "data-display-name",
      data.display_name || data.name || locInput.value,
    );

    // Enable relevant buttons
    [
      "generate-boundary",
      "generate-streets",
      "generate-coverage",
      "preprocess-streets",
    ].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = false;
    });

    document.dispatchEvent(new Event("locationValidated"));
  };

  /**
   * Generates OSM data for a location
   * @param {boolean} streetsOnly - Whether to only get streets
   * @returns {Promise<void>}
   */
  const generateOSMData = async (streetsOnly) => {
    if (!window.validatedLocation) {
      notificationManager.show("Please validate a location first.", "warning");
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

      const layer = L.geoJSON(geojson, {
        style: {
          color: streetsOnly
            ? mapLayers.osmStreets.color
            : mapLayers.osmBoundary.color,
          weight: 2,
          opacity: 0.7,
        },
      });

      if (streetsOnly) {
        mapLayers.osmStreets.layer = layer;
      } else {
        mapLayers.osmBoundary.layer = layer;
      }

      debouncedUpdateMap();
      updateLayerOrderUI();
      notificationManager.show("OSM data generated successfully!", "success");
    } catch (err) {
      handleError(err, "Generating OSM Data");
    }
  };

  // ==============================
  // Map Matching & Metrics
  // ==============================

  /**
   * Initiates map matching for trips
   * @param {boolean} isHistorical - Whether to include historical trips
   * @returns {Promise<void>}
   */
  const mapMatchTrips = async (isHistorical = false) => {
    const sd = getStartDate();
    const ed = getEndDate();

    if (!sd || !ed) {
      notificationManager.show("Select start and end dates.", "warning");
      return;
    }

    loadingManager.startOperation("MapMatching", 100);

    const tasks = [
      fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: sd, end_date: ed }),
      }),
    ];

    if (isHistorical) {
      tasks.push(
        fetch("/api/map_match_historical_trips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_date: sd, end_date: ed }),
        }),
      );
    }

    try {
      const responses = await Promise.all(tasks);

      for (const response of responses) {
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.message || `HTTP error! status: ${response.status}`,
          );
        }
      }

      const results = await Promise.all(responses.map((r) => r.json()));
      console.log("Map matching responses:", results);

      notificationManager.show(
        "Map matching completed for selected trips.",
        "success",
      );

      fetchTrips();
    } catch (err) {
      handleError(err, "Map Matching");
    } finally {
      loadingManager.finish("MapMatching");
    }
  };

  /**
   * Fetches trips within the selected date range
   * @returns {Promise<void>}
   */
  const fetchTripsInRange = async () => {
    const sd = getStartDate();
    const ed = getEndDate();

    if (!sd || !ed) {
      notificationManager.show("Select start and end dates.", "warning");
      return;
    }

    loadingManager.startOperation("FetchTripsRange", 100);

    try {
      const r = await fetch("/api/fetch_trips_range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: sd, end_date: ed }),
      });

      if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);

      const data = await r.json();

      if (data.status === "success") {
        notificationManager.show(data.message, "success");
        fetchTrips();
      } else {
        console.error(`Error: ${data.message}`);
        notificationManager.show(
          "Error fetching trips. Check console.",
          "danger",
        );
      }
    } catch (err) {
      handleError(err, "Fetching Trips in Range");
    } finally {
      loadingManager.finish("FetchTripsRange");
    }
  };

  /**
   * Fetches metrics for the selected date range
   * @returns {Promise<void>}
   */
  const fetchMetrics = async () => {
    const sd = getStartDate();
    const ed = getEndDate();
    const imei = document.getElementById("imei")?.value || "";

    if (!sd || !ed) return;

    try {
      const r = await fetch(
        `/api/metrics?start_date=${sd}&end_date=${ed}&imei=${imei}`,
      );

      const metrics = await r.json();

      const mapping = {
        "total-trips": metrics.total_trips,
        "total-distance": metrics.total_distance,
        "avg-distance": metrics.avg_distance,
        "avg-start-time": metrics.avg_start_time,
        "avg-driving-time": metrics.avg_driving_time,
        "avg-speed": `${metrics.avg_speed} mph`,
        "max-speed": `${metrics.max_speed} mph`,
      };

      Object.keys(mapping).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = mapping[id];
      });
    } catch (err) {
      handleError(err, "Fetching Metrics");
    }
  };

  // ==============================
  // Street Coverage & Polling
  // ==============================

  /**
   * Generates street coverage data for a location
   * @returns {Promise<void>}
   */
  const generateStreetCoverage = async () => {
    if (!window.validatedLocation) {
      notificationManager.show("Validate a location first.", "warning");
      return;
    }

    const coverageBtn = DOMCache.generateCoverageBtn;
    const originalText = coverageBtn?.innerHTML || "Generate Coverage";
    const progressBar = DOMCache.coverageProgress;
    const progressText = document.getElementById("coverage-progress-text"); // No cache for this

    try {
      if (coverageBtn) coverageBtn.disabled = true;
      if (coverageBtn)
        coverageBtn.innerHTML =
          '<span class="spinner-border spinner-border-sm"></span> Starting...';

      if (DOMCache.coverageStats)
        DOMCache.coverageStats.classList.remove("d-none");
      if (progressBar) {
        progressBar.style.width = "0%";
        progressBar.setAttribute("aria-valuenow", "0");
      }
      if (progressText)
        progressText.textContent = "Starting coverage calculation...";

      const response = await fetch("/api/street_coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: window.validatedLocation }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || "Failed to start coverage calculation",
        );
      }

      const data = await response.json();
      if (!data || !data.task_id) {
        throw new Error("Invalid response: missing task ID");
      }

      const task_id = data.task_id;
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await pollCoverageStatus(task_id, progressBar, progressText);
    } catch (error) {
      handleError(error, "Generating Street Coverage");
      progressBar.style.width = "0%";
      progressBar.setAttribute("aria-valuenow", "0");
      progressText.textContent = "Error calculating coverage";
    } finally {
      if (coverageBtn) coverageBtn.disabled = false;
      if (coverageBtn) coverageBtn.innerHTML = originalText;
    }
  };

  /**
   * Polls for status updates on street coverage calculation
   * @param {string} taskId - Task ID
   * @param {HTMLElement} progressBar - Progress bar element
   * @param {HTMLElement} progressText - Progress text element
   * @returns {Promise<void>}
   */
  const pollCoverageStatus = async (taskId, progressBar, progressText) => {
    let retryCount = 0;
    let pollDelay = 1000;
    const maxRetries = 3;
    const maxPollDelay = CONFIG.REFRESH.maxPollDelay;

    while (true) {
      try {
        const statusResponse = await fetch(`/api/street_coverage/${taskId}`);

        if (statusResponse.status === 404) {
          retryCount++;
          if (retryCount > maxRetries) {
            throw new Error("Task not found after multiple retries");
          }
          await new Promise((resolve) => setTimeout(resolve, pollDelay));
          pollDelay = Math.min(pollDelay * 2, maxPollDelay);
          continue;
        }

        retryCount = 0;

        if (statusResponse.status === 500) {
          const errorData = await statusResponse.json();
          throw new Error(errorData.detail || "Error in coverage calculation");
        }

        if (!statusResponse.ok) {
          throw new Error(
            `Server returned ${statusResponse.status}: ${statusResponse.statusText}`,
          );
        }

        const statusData = await statusResponse.json();

        if (!statusData) {
          console.warn("Received empty status data");
          await new Promise((resolve) => setTimeout(resolve, pollDelay));
          continue;
        }

        if (statusData.streets_data) {
          visualizeStreetCoverage(statusData);
          break;
        }

        if (!statusData.stage) {
          console.warn("Invalid progress data received:", statusData);
          await new Promise((resolve) => setTimeout(resolve, pollDelay));
          continue;
        }

        if (statusData.stage === "complete" && statusData.result) {
          visualizeStreetCoverage(statusData.result);
          break;
        } else if (statusData.stage === "error") {
          throw new Error(
            statusData.message || "Error in coverage calculation",
          );
        }

        const progress = statusData.progress || 0;
        requestAnimationFrame(() => {
          progressBar.style.width = `${progress}%`;
          progressBar.setAttribute("aria-valuenow", progress);
          progressText.textContent =
            statusData.message || `Progress: ${progress}%`;
        });

        await new Promise((resolve) => setTimeout(resolve, pollDelay));
      } catch (error) {
        if (error.message === "Task not found after multiple retries") {
          throw error;
        }
        console.warn("Error polling progress:", error);
        await new Promise((resolve) => setTimeout(resolve, pollDelay));
      }
    }
  };

  /**
   * Updates coverage statistics display
   * @param {Object} coverageData - Coverage data
   */
  const updateCoverageStats = (coverageData) => {
    const statsDiv = document.getElementById("coverage-stats");
    const progressBar = document.getElementById("coverage-progress");
    const coveragePercentageSpan = document.getElementById(
      "coverage-percentage",
    );
    const totalStreetLengthSpan = document.getElementById(
      "total-street-length",
    );
    const milesDrivenSpan = document.getElementById("miles-driven");

    if (
      !statsDiv ||
      !progressBar ||
      !coveragePercentageSpan ||
      !totalStreetLengthSpan ||
      !milesDrivenSpan
    ) {
      console.error("One or more coverage stats elements not found!");
      return;
    }

    statsDiv.classList.remove("d-none");

    const {
      coverage_percentage: percent = 0,
      total_length_miles: totalMiles = 0,
      driven_length_miles: drivenMiles = 0,
    } = coverageData.streets_data.metadata;

    progressBar.style.width = `${percent}%`;
    progressBar.setAttribute("aria-valuenow", percent.toFixed(1));
    coveragePercentageSpan.textContent = percent.toFixed(1);
    totalStreetLengthSpan.textContent = totalMiles.toFixed(2);
    milesDrivenSpan.textContent = drivenMiles.toFixed(2);
  };

  /**
   * Visualizes street coverage data on the map
   * @param {Object} coverageData - Coverage data
   */
  const visualizeStreetCoverage = (coverageData) => {
    if (mapLayers.streetCoverage.layer) {
      layerGroup.removeLayer(mapLayers.streetCoverage.layer);
      mapLayers.streetCoverage.layer = null;
    }

    if (!coverageData || !coverageData.streets_data) {
      console.error("Invalid coverage data received");
      return;
    }

    mapLayers.streetCoverage.layer = L.geoJSON(coverageData.streets_data, {
      style: (feature) => {
        const { driven, coverage_count: count = 0 } = feature.properties;
        let color = "#FF4444",
          opacity = 0.4,
          weight = 3;

        if (driven) {
          if (count >= 10) color = "#004400";
          else if (count >= 5) color = "#006600";
          else if (count >= 3) color = "#008800";
          else color = "#00AA00";
          opacity = 0.8;
          weight = 4;
        }

        return { color, weight, opacity };
      },
      onEachFeature: (feature, layer) => {
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

        layer.bindPopup(popupContent);
        layer.on({
          mouseover: (e) => e.target.setStyle({ weight: 5, opacity: 1 }),
          mouseout: (e) => mapLayers.streetCoverage.layer.resetStyle(e.target),
        });
      },
    });

    mapLayers.streetCoverage.layer.addTo(layerGroup);
    mapLayers.streetCoverage.visible = true;
    updateLayerOrderUI();
    debouncedUpdateMap();
    updateCoverageStats(coverageData);
  };

  /**
   * Shows coverage for a specific location
   * @param {Object} location - Location object
   * @returns {Promise<void>}
   */
  const showCoverageForLocation = async (location) => {
    try {
      const response = await fetch(
        `/api/street_coverage/${location.display_name}`,
      );

      if (!response.ok) throw new Error("Failed to fetch coverage data");

      const data = await response.json();
      if (data?.streets_data) {
        visualizeStreetCoverage(data);
        mapLayers.streetCoverage.visible = true;
        updateLayerOrderUI();
        updateMap(true);
      }
    } catch (error) {
      handleError(error, "Showing Coverage for Location");
      notificationManager.show("Error loading coverage data", "danger");
    }
  };

  // ==============================
  // Event Listeners & Date Presets
  // ==============================

  /**
   * Handles click on a date preset button
   * @returns {Promise<void>}
   */
  const handleDatePresetClick = async function () {
    const range = this.dataset.range;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = new Date(today);
    let endDate = new Date(today);

    if (range === "all-time") {
      loadingManager.startOperation("AllTimeDatePreset", 100);
      try {
        const r = await fetch("/api/first_trip_date");
        const d = await r.json();
        updateDatePickersAndStore(new Date(d.first_trip_date), endDate);
      } catch (err) {
        handleError(err, "Fetching First Trip Date");
        notificationManager.show(
          "Error fetching first trip date. Please try again.",
          "danger",
        );
      } finally {
        loadingManager.finish("AllTimeDatePreset");
      }
      return;
    }

    switch (range) {
      case "yesterday":
        startDate.setDate(startDate.getDate() - 1);
        break;
      case "last-week":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "last-month":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "last-6-months":
        startDate.setMonth(startDate.getMonth() - 6);
        break;
      case "last-year":
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        break;
    }

    updateDatePickersAndStore(startDate, endDate);
  };

  /**
   * Initializes all event listeners
   */
  const initializeEventListeners = () => {
    // Apply filters button
    const applyFiltersBtn =
      DOMCache.applyFiltersBtn || document.getElementById("apply-filters");
    if (applyFiltersBtn && !applyFiltersBtn._hasClickListener) {
      applyFiltersBtn._hasClickListener = true;
      applyFiltersBtn.addEventListener("click", () => {
        const sd = getStartDate();
        const ed = getEndDate();
        localStorage.setItem("startDate", sd);
        localStorage.setItem("endDate", ed);
        fetchTrips();
        fetchMetrics();
      });
    }

    // Controls toggle
    const controlsToggle = DOMCache.controlsToggle;
    if (controlsToggle && !controlsToggle._hasClickListener) {
      controlsToggle._hasClickListener = true;
      controlsToggle.addEventListener("click", function () {
        const mapControls = document.getElementById("map-controls");
        const controlsContent = DOMCache.controlsContent;
        mapControls?.classList.toggle("minimized");

        const icon = this.querySelector("i");
        icon?.classList.toggle("fa-chevron-up");
        icon?.classList.toggle("fa-chevron-down");

        if (controlsContent) {
          controlsContent.style.display = mapControls?.classList.contains(
            "minimized",
          )
            ? "none"
            : "block";
        }
      });
    }

    // Location validation and OSM buttons
    addOneTimeEventListener(
      DOMCache.validateLocationBtn,
      "click",
      validateLocation,
    );
    addOneTimeEventListener(DOMCache.generateBoundaryBtn, "click", () =>
      generateOSMData(false),
    );
    addOneTimeEventListener(DOMCache.generateStreetsBtn, "click", () =>
      generateOSMData(true),
    );

    // Trip processing buttons
    addOneTimeEventListener(DOMCache.mapMatchTripsBtn, "click", () =>
      mapMatchTrips(false),
    );
    addOneTimeEventListener(DOMCache.mapMatchHistoricalBtn, "click", () =>
      mapMatchTrips(true),
    );
    addOneTimeEventListener(
      DOMCache.generateCoverageBtn,
      "click",
      generateStreetCoverage,
    );
    addOneTimeEventListener(
      DOMCache.fetchTripsRangeBtn,
      "click",
      fetchTripsInRange,
    );

    // Date preset buttons
    document.querySelectorAll(".date-preset").forEach((btn) => {
      if (!btn._hasClickListener) {
        btn._hasClickListener = true;
        btn.addEventListener("click", handleDatePresetClick);
      }
    });

    // Highlight recent trips toggle
    if (
      DOMCache.highlightRecentTrips &&
      !DOMCache.highlightRecentTrips._hasChangeListener
    ) {
      DOMCache.highlightRecentTrips._hasChangeListener = true;
      DOMCache.highlightRecentTrips.addEventListener("change", function () {
        mapSettings.highlightRecentTrips = this.checked;
        debouncedUpdateMap();
      });
    }

    // Streets preprocessing button
    addOneTimeEventListener(
      DOMCache.preprocessStreetsBtn,
      "click",
      preprocessStreets,
    );
  };

  /**
   * Adds an event listener only once to prevent duplicates
   * @param {HTMLElement} element - DOM element
   * @param {string} eventType - Event type (e.g., 'click')
   * @param {Function} handler - Event handler function
   */
  const addOneTimeEventListener = (element, eventType, handler) => {
    if (!element) return;

    const handlerProperty = `_has${eventType}Listener`;
    if (!element[handlerProperty]) {
      element[handlerProperty] = true;
      element.addEventListener(eventType, handler);
    }
  };

  // ==============================
  // Initialization on DOMContentLoaded
  // ==============================

  /**
   * Sets default dates in localStorage if not present
   */
  const setInitialDates = () => {
    const today = new Date().toISOString().split("T")[0];
    if (!localStorage.getItem("startDate")) {
      localStorage.setItem("startDate", today);
    }
    if (!localStorage.getItem("endDate")) {
      localStorage.setItem("endDate", today);
    }
  };

  /**
   * Initializes date picker inputs
   */
  const initializeDatePickers = () => {
    DOMCache.startDateInput = document.getElementById("start-date");
    DOMCache.endDateInput = document.getElementById("end-date");

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const config = {
      dateFormat: "Y-m-d",
      maxDate: tomorrow,
      enableTime: false,
      static: false,
      appendTo: document.body,
      theme: "dark",
      position: "auto",
      disableMobile: true,
      onChange: function (selectedDates, dateStr) {
        const input = this.input;
        if (input) {
          localStorage.setItem(
            input.id === "start-date" ? "startDate" : "endDate",
            dateStr,
          );
        }
      },
    };

    [DOMCache.startDateInput, DOMCache.endDateInput].forEach((element) => {
      if (element) flatpickr(element, config);
    });
  };

  /**
   * Preprocesses streets for a location for improved route matching and coverage calculation
   * @param {Object} [location] - Location data (defaults to window.validatedLocation)
   * @returns {Promise<void>}
   */
  const preprocessStreets = async (location = window.validatedLocation) => {
    if (!location) {
      notificationManager.show("Please validate a location first.", "warning");
      return;
    }

    const button = document.getElementById("preprocess-streets");
    const originalText = button?.innerHTML || "Preprocess Streets";

    try {
      if (button) {
        button.disabled = true;
        button.innerHTML =
          '<span class="spinner-border spinner-border-sm me-1"></span> Processing...';
      }

      const response = await fetch("/api/preprocess_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.message || `HTTP error! status: ${response.status}`,
        );
      }

      const data = await response.json();
      notificationManager.show(
        data.message || "Streets preprocessed successfully for route matching.",
        "success",
      );
    } catch (error) {
      handleError(error, "Preprocessing Streets");
    } finally {
      if (button) {
        button.disabled = false;
        button.innerHTML = originalText;
      }
    }
  };

  /**
   * Initializes DOM cache for better performance
   */
  const initializeDOMCache = () => {
    // Map elements
    DOMCache.map = safeQuerySelector("#map");

    // Control elements
    DOMCache.layerToggles = safeQuerySelector("#layer-toggles");
    DOMCache.layerOrder = safeQuerySelector("#layer-order");
    DOMCache.controlsToggle = safeQuerySelector("#controls-toggle");
    DOMCache.controlsContent = safeQuerySelector("#controls-content");

    // Filter elements
    DOMCache.startDateInput = safeQuerySelector("#start-date");
    DOMCache.endDateInput = safeQuerySelector("#end-date");
    DOMCache.applyFiltersBtn = safeQuerySelector("#apply-filters");

    // Location elements
    DOMCache.locationInput = safeQuerySelector("#location-input");
    DOMCache.locationType = safeQuerySelector("#location-type");

    // Metric elements
    DOMCache.totalTrips = safeQuerySelector("#total-trips");
    DOMCache.totalDistance = safeQuerySelector("#total-distance");
    DOMCache.avgDistance = safeQuerySelector("#avg-distance");
    DOMCache.avgStartTime = safeQuerySelector("#avg-start-time");
    DOMCache.avgDrivingTime = safeQuerySelector("#avg-driving-time");
    DOMCache.avgSpeed = safeQuerySelector("#avg-speed");
    DOMCache.maxSpeed = safeQuerySelector("#max-speed");

    // Coverage elements
    DOMCache.coverageStats = safeQuerySelector("#coverage-stats");
    DOMCache.coverageProgress = safeQuerySelector("#coverage-progress");
    DOMCache.coveragePercentage = safeQuerySelector("#coverage-percentage");
    DOMCache.totalStreetLength = safeQuerySelector("#total-street-length");
    DOMCache.milesDriven = safeQuerySelector("#miles-driven");

    // Button elements
    DOMCache.validateLocationBtn = safeQuerySelector("#validate-location");
    DOMCache.generateBoundaryBtn = safeQuerySelector("#generate-boundary");
    DOMCache.generateStreetsBtn = safeQuerySelector("#generate-streets");
    DOMCache.generateCoverageBtn = safeQuerySelector("#generate-coverage");
    DOMCache.mapMatchTripsBtn = safeQuerySelector("#map-match-trips");
    DOMCache.mapMatchHistoricalBtn = safeQuerySelector(
      "#map-match-historical-trips",
    );
    DOMCache.preprocessStreetsBtn = safeQuerySelector("#preprocess-streets");
    DOMCache.highlightRecentTrips = safeQuerySelector(
      "#highlight-recent-trips",
    );
  };

  /**
   * Main initialization function, called on DOMContentLoaded
   */
  const initialize = () => {
    setInitialDates();
    initializeDOMCache();
    initializeDatePickers();
    initializeEventListeners();

    if (DOMCache.map && !document.getElementById("visits-page")) {
      initializeMap().then(() => {
        if (!map || !layerGroup) {
          console.error("Failed to initialize map components");
          notificationManager.show(
            "Failed to initialize map components. Please refresh the page.",
            "danger",
          );
          return;
        }

        initializeLayerControls();
        fetchTrips().then(fetchMetrics);

        // Load selected location from storage if exists
        const selectedLocation = localStorage.getItem("selectedLocation");
        if (selectedLocation) {
          try {
            const location = JSON.parse(selectedLocation);
            window.validatedLocation = location;
            showCoverageForLocation(location).then(() => {
              localStorage.removeItem("selectedLocation");
            });
          } catch (error) {
            console.error("Error loading selected location:", error);
          }
        }
      });
    } else {
      fetchMetrics();
    }

    // Disable buttons until location is validated
    [
      "generate-boundary",
      "generate-streets",
      "generate-coverage",
      "preprocess-streets",
    ].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = true;
    });
  };

  // Initialize on DOM content loaded
  document.addEventListener("DOMContentLoaded", initialize);
})();
