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
    const startDateInput =
      AppState.dom.startDateInput || getElement("start-date");
    if (startDateInput?.value)
      return DateUtils.formatDate(startDateInput.value);

    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.startDate);
    return storedDate
      ? DateUtils.formatDate(storedDate)
      : DateUtils.getCurrentDate();
  };

  const getEndDate = () => {
    const endDateInput = AppState.dom.endDateInput || getElement("end-date");
    if (endDateInput?.value) return DateUtils.formatDate(endDateInput.value);

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
              getTripFeatureStyle(featureLayer.feature, layerInfo)
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
      const mapContainer = document.getElementById("map");
      if (!mapContainer) return;

      mapContainer.style.height = "500px";
      mapContainer.style.position = "relative";

      const theme = document.body.classList.contains("light-mode")
        ? "light"
        : "dark";
      const tileUrl = CONFIG.MAP.tileLayerUrls[theme];

      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: true,
        attributionControl: false,
        maxBounds: [
          [-90, -180],
          [90, 180],
        ],
      });

      window.map = AppState.map;

      L.tileLayer(tileUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        attribution: "",
      }).addTo(AppState.map);

      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      // Initialize layer containers
      Object.keys(AppState.mapLayers).forEach((layerName) => {
        AppState.mapLayers[layerName].layer =
          layerName === "customPlaces"
            ? L.layerGroup()
            : { type: "FeatureCollection", features: [] };
      });

      // Map click event
      AppState.map.on("click", (e) => {
        if (AppState.selectedTripId && !e.originalEvent._stopped) {
          AppState.selectedTripId = null;
          refreshTripStyles();
        }
      });

      // Theme change event
      document.addEventListener("themeChanged", (e) => {
        updateMapTheme(e.detail?.theme || "dark");
      });

      initializeLiveTracker();

      try {
        await centerMapOnLastPosition();
      } catch (error) {
        console.error("Error fetching last trip point:", error);
        AppState.map.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      } finally {
        AppState.mapInitialized = true;
        setTimeout(() => AppState.map.invalidateSize(), 100);
        document.dispatchEvent(new CustomEvent("mapInitialized"));
      }
    } catch (error) {
      handleError(error, "Map Initialization");
    }
  }

  function updateMapTheme(theme) {
    if (!AppState.map) return;

    AppState.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        AppState.map.removeLayer(layer);
      }
    });

    const tileUrl =
      CONFIG.MAP.tileLayerUrls[theme] || CONFIG.MAP.tileLayerUrls.dark;
    L.tileLayer(tileUrl, {
      maxZoom: CONFIG.MAP.maxZoom,
      attribution: "",
    }).addTo(AppState.map);

    refreshTripStyles();
    AppState.map.invalidateSize();
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
          parseFloat(target.value)
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
    } else {
      debouncedUpdateMap();
    }

    updateLayerOrderUI();
    document.dispatchEvent(
      new CustomEvent("layerVisibilityChanged", {
        detail: { layer: name, visible },
      })
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
    subOperations = {}
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

        await Promise.all([
          updateTripsTable(geojson),
          updateMapWithTrips(geojson),
        ]);

        lm.updateSubOperation(opId, "Processing Data", 30);
        lm.updateSubOperation(opId, "Displaying Data", 10);

        try {
          await fetchMatchedTrips();
        } catch (err) {
          handleError(err, "Fetching Matched Trips");
        } finally {
          lm.updateSubOperation(opId, "Displaying Data", 20);
        }

        document.dispatchEvent(
          new CustomEvent("tripsLoaded", {
            detail: { count: geojson.features.length },
          })
        );
      }
    );
  }

  async function updateTripsTable(geojson) {
    if (!window.tripsTable) return;

    const formattedTrips = geojson.features.map((trip) => ({
      ...trip.properties,
      gps: trip.geometry,
      startTimeFormatted: DateUtils.formatForDisplay(
        trip.properties.startTime,
        { dateStyle: "short", timeStyle: "short" }
      ),
      endTimeFormatted: DateUtils.formatForDisplay(trip.properties.endTime, {
        dateStyle: "short",
        timeStyle: "short",
      }),
      startTimeRaw: trip.properties.startTime,
      endTimeRaw: trip.properties.endTime,
      destination: trip.properties.destination || "N/A",
      startLocation: trip.properties.startLocation || "N/A",
      distance: Number(trip.properties.distance).toFixed(2),
    }));

    return new Promise((resolve) => {
      window.tripsTable.clear().rows.add(formattedTrips).draw();
      setTimeout(resolve, 100);
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

  async function fetchMatchedTrips() {
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
    const response = await fetch(`/api/matched_trips?${params.toString()}`);

    if (!response.ok)
      throw new Error(`HTTP error fetching matched trips: ${response.status}`);

    const geojson = await response.json();
    AppState.mapLayers.matchedTrips.layer = geojson;
  }

  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      console.warn("Map not ready for update. Operation deferred.");
      return;
    }

    AppState.layerGroup.clearLayers();

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => a.order - b.order);

    const tripLayers = new Map();

    await Promise.all(
      visibleLayers.map(async ([name, info]) => {
        if (["customPlaces"].includes(name)) {
          info.layer.addTo(AppState.layerGroup);
        } else if (["trips", "matchedTrips"].includes(name)) {
          const geoJsonLayer = L.geoJSON(info.layer, {
            style: (feature) => getTripFeatureStyle(feature, info),
            onEachFeature: (feature, layer) => {
              tripLayers.set(feature.properties.transactionId, layer);
              layer.on("click", (e) =>
                handleTripClick(e, feature, layer, info, name)
              );
              layer.on("popupopen", () =>
                setupPopupEventListeners(layer, feature)
              );
            },
          });
          geoJsonLayer.addTo(AppState.layerGroup);
        }
      })
    );

    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      tripLayers.get(AppState.selectedTripId)?.bringToFront();
    }

    if (fitBounds) fitMapBounds();
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
      })
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
          (durationMs % (1000 * 60 * 60)) / (1000 * 60)
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
      popupEl.removeEventListener("click", handlePopupClick)
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
          "Delete this trip? This will also delete its corresponding matched trip."
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
          "Re-match this trip? This will delete the existing matched trip and create a new one."
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
          errorData.message || `HTTP error! status: ${response.status}`
        );
      }

      const results = await response.json();
      showNotification("Map matching completed for selected trips.", "success");
      await fetchTrips();

      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", {
          detail: { results },
        })
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
        `/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`
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
        })
      );
    } catch (err) {
      handleError(err, "Fetching Metrics");
    }
  }

  // Event Listeners & Date Presets
  function handleDatePresetClick() {
    const range = this.dataset.range;
    if (!range) return;

    const loadingManager = window.loadingManager || {
      startOperation: () => {},
      finish: () => {},
    };

    loadingManager.startOperation("DatePreset", 100);

    DateUtils.getDateRangePreset(range)
      .then(({ startDate, endDate }) => {
        if (startDate && endDate) {
          const startInput = getElement("#start-date");
          const endInput = getElement("#end-date");

          if (startInput && endInput) {
            if (startInput._flatpickr) {
              startInput._flatpickr.setDate(startDate);
            } else {
              startInput.value = startDate;
            }

            if (endInput._flatpickr) {
              endInput._flatpickr.setDate(endDate);
            } else {
              endInput.value = endDate;
            }
          }

          setStorageItem(CONFIG.STORAGE_KEYS.startDate, startDate);
          setStorageItem(CONFIG.STORAGE_KEYS.endDate, endDate);

          document.dispatchEvent(
            new CustomEvent("datePresetSelected", {
              detail: { preset: range, startDate, endDate },
            })
          );

          fetchTripsInRange();
        } else {
          showNotification("Invalid date range returned", "warning");
        }
      })
      .catch((err) => {
        handleError(err, "Setting Date Preset");
        showNotification(
          "Error setting date range. Please try again.",
          "danger"
        );
      })
      .finally(() => {
        loadingManager.finish("DatePreset");
      });
  }

  function initializeEventListeners() {
    addSingleEventListener("apply-filters", "click", () => {
      setStorageItem(CONFIG.STORAGE_KEYS.startDate, getStartDate());
      setStorageItem(CONFIG.STORAGE_KEYS.endDate, getEndDate());
      fetchTrips();
      fetchMetrics();
    });

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

    document.querySelectorAll(".quick-select-btn").forEach((btn) => {
      addSingleEventListener(btn, "click", handleDatePresetClick);
    });

    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      debouncedUpdateMap();
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
      config
    );
    AppState.dom.endDatePicker = DateUtils.initDatePicker(
      AppState.dom.endDateInput,
      config
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
            return;
          }

          initializeLayerControls();
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
