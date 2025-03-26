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
        dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      },
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000, // 6 hours in ms
      debounceDelay: 150,
      mapBoundsPadding: [30, 30],
    },
    STORAGE_KEYS: {
      startDate: "startDate",
      endDate: "endDate",
    },
    ERROR_MESSAGES: {
      mapInitFailed: "Failed to initialize map. Please refresh the page.",
      fetchTripsFailed: "Error loading trips. Please try again.",
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
    liveTracker: null,
    dom: {},
  };

  // --- DOM Cache Utility ---
  const getElement = (selector, useCache = true, context = document) => {
    if (useCache && AppState.dom[selector]) return AppState.dom[selector];
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
  const addSingleEventListener = (element, eventType, handler) => {
    const el = typeof element === "string" ? getElement(element) : element;
    if (!el) {
      console.warn(`Element not found for listener: ${element}`);
      return false;
    }
    if (!el._eventHandlers) el._eventHandlers = {};
    const handlerKey = `${eventType}_${handler
      .toString()
      .substring(0, 50)
      .replace(/\s+/g, "")}`;
    if (el._eventHandlers[handlerKey]) return false; // Listener already exists
    el.addEventListener(eventType, handler);
    el._eventHandlers[handlerKey] = handler;
    return true;
  };

  // Debounced map update function
  const debouncedUpdateMap = utils.debounce(
    updateMap,
    CONFIG.MAP.debounceDelay
  );

  // --- Date & Filter Functions ---
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
      color =
        feature.properties.isMatched ||
        layerInfo === AppState.mapLayers.matchedTrips
          ? AppState.mapLayers.matchedTrips.highlightColor
          : AppState.mapLayers.trips.highlightColor;
      weight = 5;
      opacity = 0.9;
      className = "highlighted-matched-trip";
      zIndexOffset = 1000;
    } else if (isRecent) {
      color = "#FF5722";
      weight = 4;
      opacity = 0.8;
      className = "recent-trip";
      zIndexOffset = 500;
    }

    return { color, weight, opacity, className, zIndexOffset };
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
              featureLayer.options.zIndexOffset > 0 &&
              featureLayer.bringToFront
            ) {
              featureLayer.bringToFront();
            }
          }
        });
      }
    });
  }

  // --- Map Initialization & Controls ---
  const isMapReady = () =>
    AppState.map && AppState.mapInitialized && AppState.layerGroup;

  async function initializeMap() {
    const mapContainer = getElement("map");
    if (!mapContainer) {
      console.error("Map container element (#map) not found.");
      return;
    }

    try {
      if (typeof L === "undefined") {
        throw new Error("Leaflet library (L) is not loaded.");
      }

      const initialTheme = document.body.classList.contains("light-mode")
        ? "light"
        : "dark";
      const tileUrl =
        CONFIG.MAP.tileLayerUrls[initialTheme] || CONFIG.MAP.tileLayerUrls.dark;

      AppState.map = L.map("map", {
        center: CONFIG.MAP.defaultCenter,
        zoom: CONFIG.MAP.defaultZoom,
        zoomControl: true,
        attributionControl: false,
        maxBounds: [
          [-90, -180],
          [90, 180],
        ],
        maxBoundsViscosity: 1.0,
      });

      window.map = AppState.map; // Expose globally for custom-places.js etc.

      L.tileLayer(tileUrl, {
        maxZoom: CONFIG.MAP.maxZoom,
        attribution: "",
      }).addTo(AppState.map);

      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

      Object.keys(AppState.mapLayers).forEach((layerName) => {
        AppState.mapLayers[layerName].layer =
          layerName === "customPlaces"
            ? L.layerGroup()
            : { type: "FeatureCollection", features: [] };
      });

      AppState.map.on("click", (e) => {
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

      document.addEventListener("themeChanged", (e) => {
        console.log("Theme changed detected in app.js, refreshing styles.");
        refreshTripStyles();
      });

      initializeLiveTracker();

      try {
        await centerMapOnLastPosition();
      } catch (error) {
        handleError(error, "Centering map on last position");
        AppState.map.setView(CONFIG.MAP.defaultCenter, CONFIG.MAP.defaultZoom);
      }

      AppState.mapInitialized = true;
      setTimeout(() => AppState.map?.invalidateSize(), 200);
      document.dispatchEvent(new CustomEvent("mapInitialized"));
      console.log("Map initialized successfully.");
    } catch (error) {
      handleError(error, "Map Initialization");
      notificationManager.show(CONFIG.ERROR_MESSAGES.mapInitFailed, "danger");
      if (AppState.map) {
        AppState.map.remove();
        AppState.map = null;
        window.map = null;
      }
      AppState.mapInitialized = false;
    }
  }

  function initializeLiveTracker() {
    if (!window.LiveTripTracker || !AppState.map) {
      if (!window.LiveTripTracker)
        console.warn("LiveTripTracker class not found.");
      return;
    }
    try {
      if (!AppState.liveTracker) {
        AppState.liveTracker = new window.LiveTripTracker(AppState.map);
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
        if (response.status !== 404) {
          console.warn(
            `Failed to fetch last trip point: ${response.status} ${response.statusText}`
          );
        } else {
          console.log("No last trip point found in API.");
        }
        AppState.map?.setView([31.55002, -97.123354], 14); // Default fallback
        return;
      }

      const data = await response.json();
      if (data.lastPoint && AppState.map) {
        const [lng, lat] = data.lastPoint;
        if (typeof lat === "number" && typeof lng === "number") {
          console.log(`Centering map on last known position: [${lat}, ${lng}]`);
          AppState.map.flyTo([lat, lng], 11, {
            duration: 1.5,
            easeLinearity: 0.5,
          });
        } else {
          console.warn("Received invalid coordinates for last trip point.");
          AppState.map?.setView([31.55002, -97.123354], 14);
        }
      } else {
        console.log("API responded OK but no last trip point data found.");
        AppState.map?.setView([31.55002, -97.123354], 14);
      }
    } catch (error) {
      throw error; // Re-throw network/parse errors to be caught by initializeMap
    }
  }

  // --- Layer Controls ---
  function initializeLayerControls() {
    const layerTogglesContainer = getElement("layer-toggles");
    if (!layerTogglesContainer) return;

    layerTogglesContainer.innerHTML = "";

    Object.entries(AppState.mapLayers)
      .sort(([, a], [, b]) => (a.order || 99) - (b.order || 99))
      .forEach(([name, info]) => {
        const controlIdBase = `${name}-layer`;
        const isSpecialLayer = name === "customPlaces";

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

        toggleLabel.append(toggleInput, toggleText);
        div.appendChild(toggleLabel);

        if (!isSpecialLayer) {
          const controlsDiv = DOMHelper.create("div", {
            class: "layer-sub-controls d-flex align-items-center ms-4 mt-1",
          });
          const colorInput = DOMHelper.create("input", {
            type: "color",
            id: `${controlIdBase}-color`,
            value: info.color,
            class: "form-control form-control-color form-control-sm me-2",
            title: "Layer Color",
          });
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
          controlsDiv.append(colorInput, opacityInput);
          div.appendChild(controlsDiv);
        }
        layerTogglesContainer.appendChild(div);
      });

    layerTogglesContainer.addEventListener("change", (e) => {
      const target = e.target;
      const layerControlDiv = target.closest(".layer-control");
      if (!layerControlDiv) return;
      const layerName = layerControlDiv.dataset.layerName;
      if (target.matches('input[type="checkbox"]'))
        toggleLayer(layerName, target.checked);
      else if (target.matches('input[type="color"]'))
        changeLayerColor(layerName, target.value);
    });

    layerTogglesContainer.addEventListener("input", (e) => {
      const target = e.target;
      const layerControlDiv = target.closest(".layer-control");
      if (!layerControlDiv) return;
      const layerName = layerControlDiv.dataset.layerName;
      if (target.matches('input[type="range"]'))
        changeLayerOpacity(layerName, parseFloat(target.value));
    });

    updateLayerOrderUI();
  }

  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;
    layerInfo.visible = visible;
    if (name === "customPlaces" && window.customPlaces?.toggleVisibility) {
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
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo || layerInfo.color === color) return;
    layerInfo.color = color;
    refreshTripStyles();
  }

  function changeLayerOpacity(name, opacity) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo || layerInfo.opacity === opacity) return;
    layerInfo.opacity = opacity;
    refreshTripStyles();
  }

  function updateLayerOrderUI() {
    const layerOrderContainer = getElement("layer-order");
    if (!layerOrderContainer) return;

    const existingList = getElement(
      "layer-order-list",
      false,
      layerOrderContainer
    );
    if (existingList) existingList.remove();

    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => (b.order || 0) - (a.order || 0));

    const heading = layerOrderContainer.querySelector("h4");
    if (visibleLayers.length === 0) {
      if (heading) heading.textContent = "Layer Order (None Visible)";
      return;
    }
    if (heading) heading.textContent = "Layer Order";

    const ul = DOMHelper.create("ul", {
      id: "layer-order-list",
      class: "list-group",
    });
    visibleLayers.forEach(([name, info]) => {
      const li = DOMHelper.create("li", {
        "data-layer": name,
        draggable: true,
        class:
          "list-group-item list-group-item-action d-flex justify-content-between align-items-center py-1 px-2",
      });
      li.textContent = info.name || name;
      const handle = DOMHelper.create("i", {
        class: "fas fa-grip-vertical text-muted ms-2 drag-handle",
        style: { cursor: "grab" },
      });
      li.appendChild(handle);
      ul.appendChild(li);
    });
    layerOrderContainer.appendChild(ul);
    initializeDragAndDrop();
  }

  function initializeDragAndDrop() {
    const list = getElement("layer-order-list");
    if (!list) return;
    let draggedItem = null;

    list.addEventListener("dragstart", (e) => {
      if (
        e.target.classList.contains("drag-handle") ||
        e.target.closest("li")
      ) {
        draggedItem = e.target.closest("li");
        if (!draggedItem) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", draggedItem.dataset.layer);
        setTimeout(
          () =>
            draggedItem?.classList.add("dragging", "border", "border-primary"),
          0
        );
      } else {
        e.preventDefault();
      }
    });

    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const target = e.target.closest("li");
      if (target && draggedItem && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        const midpointY = rect.top + rect.height / 2;
        list.insertBefore(
          draggedItem,
          e.clientY > midpointY ? target.nextSibling : target
        );
      }
    });

    list.addEventListener("dragend", (e) => {
      if (draggedItem) {
        draggedItem.classList.remove("dragging", "border", "border-primary");
        draggedItem = null;
        updateLayerOrder();
      }
    });

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
    items.forEach((item, index) => {
      const layerName = item.dataset.layer;
      if (AppState.mapLayers[layerName]) {
        AppState.mapLayers[layerName].order = totalVisible - index;
      }
    });
    console.log("Layer order updated:", AppState.mapLayers);
    debouncedUpdateMap();
  }

  // --- API Calls & Map Data ---
  async function withLoading(operationId, operation) {
    const lm = window.loadingManager || {
      startOperation: (id) => console.log(`Loading started: ${id}`),
      finish: (id) => console.log(`Loading finished: ${id}`),
      updateProgress: (id, p, msg) =>
        console.log(`Loading progress ${id}: ${p}% ${msg || ""}`),
      error: (id, msg) => console.error(`Loading error ${id}: ${msg}`),
    };
    try {
      lm.startOperation(operationId);
      lm.updateProgress(operationId, 10, "Starting...");
      const result = await operation(lm, operationId);
      lm.updateProgress(operationId, 100, "Completed.");
      return result;
    } catch (error) {
      handleError(error, operationId);
      lm.error?.(operationId, `Error during ${operationId}: ${error.message}`);
      throw error;
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
        return;
      }

      lm.updateProgress(opId, 20, "Requesting trip data...");
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const response = await fetch(`/api/trips?${params.toString()}`);
      if (!response.ok)
        throw new Error(
          `Failed to fetch trips: ${response.status} ${response.statusText}`
        );

      const geojson = await response.json();
      lm.updateProgress(opId, 50, "Processing trip data...");

      await Promise.all([
        updateTripsTable(geojson),
        updateMapWithTrips(geojson),
      ]);

      lm.updateProgress(opId, 70, "Fetching matched trips...");
      try {
        await fetchMatchedTrips();
        lm.updateProgress(opId, 90, "Updating map display...");
        await updateMap();
      } catch (err) {
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
    if (!window.tripsTable || typeof window.tripsTable.clear !== "function")
      return;
    try {
      const formattedTrips = geojson.features.map((feature) => {
        const props = feature.properties;
        return {
          ...props,
          gps: feature.geometry,
          startTimeFormatted: DateUtils.formatForDisplay(props.startTime, {
            dateStyle: "short",
            timeStyle: "short",
          }),
          endTimeFormatted: DateUtils.formatForDisplay(props.endTime, {
            dateStyle: "short",
            timeStyle: "short",
          }),
          startTimeRaw: props.startTime,
          endTimeRaw: props.endTime,
          destination: props.destination || "N/A",
          startLocation: props.startLocation || "N/A",
          distance:
            typeof props.distance === "number"
              ? props.distance.toFixed(2)
              : "0.00",
        };
      });
      return new Promise((resolve) => {
        window.tripsTable.clear().rows.add(formattedTrips).draw(false);
        setTimeout(resolve, 150);
      });
    } catch (error) {
      handleError(error, "Updating Trips Table");
      return Promise.reject(error);
    }
  }

  async function updateMapWithTrips(geojson) {
    if (!geojson || !Array.isArray(geojson.features)) {
      console.warn("Invalid GeoJSON data received for updating map trips.");
      AppState.mapLayers.trips.layer = {
        type: "FeatureCollection",
        features: [],
      };
    } else {
      AppState.mapLayers.trips.layer = geojson;
    }
  }

  async function fetchMatchedTrips() {
    const startDate = getStartDate();
    const endDate = getEndDate();
    if (!startDate || !endDate) {
      console.warn("Invalid date range for fetching matched trips.");
      AppState.mapLayers.matchedTrips.layer = {
        type: "FeatureCollection",
        features: [],
      };
      return;
    }
    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const response = await fetch(`/api/matched_trips?${params.toString()}`);
      if (!response.ok) {
        console.warn(
          `Failed to fetch matched trips: ${response.status} ${response.statusText}`
        );
        AppState.mapLayers.matchedTrips.layer = {
          type: "FeatureCollection",
          features: [],
        };
        if (response.status >= 500)
          throw new Error(
            `HTTP error fetching matched trips: ${response.status}`
          );
        return;
      }
      const geojson = await response.json();
      AppState.mapLayers.matchedTrips.layer =
        geojson && Array.isArray(geojson.features)
          ? geojson
          : { type: "FeatureCollection", features: [] };
      console.log(
        `Fetched ${AppState.mapLayers.matchedTrips.layer.features.length} matched trips.`
      );
    } catch (error) {
      console.error("Error during fetchMatchedTrips:", error);
      AppState.mapLayers.matchedTrips.layer = {
        type: "FeatureCollection",
        features: [],
      };
      throw error;
    }
  }

  async function updateMap(fitBounds = false) {
    if (!isMapReady()) {
      console.warn("Map not ready for update. Deferring.");
      return;
    }
    AppState.layerGroup.clearLayers();
    const layersToDraw = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => (a.order || 99) - (b.order || 99));
    const tripLayerFeatures = new Map();

    await Promise.all(
      layersToDraw.map(async ([name, info]) => {
        try {
          if (name === "customPlaces") {
            if (info.layer instanceof L.Layer)
              info.layer.addTo(AppState.layerGroup);
            else
              console.warn(
                "Custom places layer data is not a valid Leaflet layer."
              );
          } else if (
            ["trips", "matchedTrips"].includes(name) &&
            info.layer.features?.length > 0
          ) {
            const geoJsonLayer = L.geoJSON(info.layer, {
              style: (feature) => getTripFeatureStyle(feature, info),
              onEachFeature: (feature, layer) => {
                if (feature.properties?.transactionId)
                  tripLayerFeatures.set(
                    feature.properties.transactionId,
                    layer
                  );
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
        } catch (error) {
          handleError(error, `Processing layer ${name}`);
        }
      })
    );

    if (
      AppState.selectedTripId &&
      tripLayerFeatures.has(AppState.selectedTripId)
    ) {
      tripLayerFeatures.get(AppState.selectedTripId)?.bringToFront();
    }
    if (fitBounds && layersToDraw.length > 0) fitMapToBounds();
    document.dispatchEvent(new CustomEvent("mapUpdated"));
  }

  function handleTripClick(e, feature, layer, layerInfo, layerName) {
    L.DomEvent.stopPropagation(e);
    const clickedId = feature.properties?.transactionId;
    if (!clickedId) return;
    const wasSelected = AppState.selectedTripId === clickedId;
    AppState.selectedTripId = wasSelected ? null : clickedId;

    AppState.layerGroup.eachLayer((l) => {
      if (l.closePopup) l.closePopup();
    });

    if (!wasSelected) {
      try {
        const popupContent = createTripPopupContent(feature, layerName);
        layer
          .bindPopup(popupContent, {
            className: "trip-popup",
            maxWidth: 350,
            autoPan: true,
            autoPanPadding: L.point(50, 50),
            closeButton: true,
          })
          .openPopup(e.latlng || layer.getBounds().getCenter());
      } catch (error) {
        handleError(error, "Creating or opening trip popup");
        notificationManager.show("Error displaying trip details.", "danger");
        AppState.selectedTripId = null;
      }
    }
    refreshTripStyles();
    document.dispatchEvent(
      new CustomEvent("tripSelected", {
        detail: {
          id: AppState.selectedTripId,
          tripData: wasSelected ? null : feature.properties,
        },
      })
    );
  }

  function createTripPopupContent(feature, layerName) {
    const props = feature.properties || {};
    const isMatched = layerName === "matchedTrips";
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
      totalIdleDurationFormatted: props.totalIdleDurationFormatted || null,
    };

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
    const formatSpeed = (speedKmh) => {
      if (speedKmh === null || speedKmh === undefined) return "Unknown";
      const speedMph = parseFloat(speedKmh) * 0.621371;
      return isNaN(speedMph) ? "Unknown" : `${speedMph.toFixed(1)} mph`;
    };
    const maxSpeedDisplay = formatSpeed(tripData.maxSpeed);
    const avgSpeedDisplay = formatSpeed(tripData.averageSpeed);

    const startLocText =
      typeof tripData.startLocation === "object"
        ? tripData.startLocation.formatted_address || "Unknown"
        : tripData.startLocation;
    const destText =
      typeof tripData.destination === "object"
        ? tripData.destination.formatted_address || "Unknown"
        : tripData.destination;

    let html = `
      <div class="trip-popup-content">
        <h5 class="mb-2">${isMatched ? "Matched Trip" : "Trip"} Details</h5>
        <table class="table table-sm table-borderless popup-data mb-2"><tbody>
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
                  }">${startLocText}</td></tr>`
                : ""
            }
            ${
              tripData.destination
                ? `<tr><th scope="row">To:</th><td title="${
                    typeof tripData.destination === "string"
                      ? tripData.destination
                      : ""
                  }">${destText}</td></tr>`
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
        </tbody></table>
        <div class="trip-actions d-flex justify-content-end" data-trip-id="${
          tripData.id
        }">`;

    html += isMatched
      ? `<button class="btn btn-sm btn-outline-danger delete-matched-trip">Delete Match</button>`
      : `<button class="btn btn-sm btn-outline-warning me-2 rematch-trip">Rematch</button>
         <button class="btn btn-sm btn-outline-danger delete-trip">Delete Trip</button>`;
    html += `</div></div>`;
    return html;
  }

  function setupPopupEventListeners(layer, feature) {
    const popup = layer.getPopup();
    if (!popup) return;
    const popupEl = popup.getElement();
    if (!popupEl) return;

    const handlePopupActionClick = async (e) => {
      const target = e.target.closest(
        "button[data-trip-id], button.delete-matched-trip, button.delete-trip, button.rematch-trip"
      );
      if (!target) return;
      e.stopPropagation();
      const tripId = target.closest(".trip-actions")?.dataset.tripId;
      if (!tripId)
        return console.warn("Could not find trip ID for popup action.");

      if (target.classList.contains("delete-matched-trip"))
        await handleDeleteMatchedTrip(tripId, layer);
      else if (target.classList.contains("delete-trip"))
        await handleDeleteTrip(tripId, layer);
      else if (target.classList.contains("rematch-trip"))
        await handleRematchTrip(tripId, layer, feature);
    };

    popupEl.addEventListener("click", handlePopupActionClick);
    layer.off("popupclose"); // Remove previous listeners
    layer.on("popupclose", () => {
      popupEl.removeEventListener("click", handlePopupActionClick);
      // If the popup closed belongs to the currently selected trip, deselect it
      if (AppState.selectedTripId === feature.properties?.transactionId) {
        AppState.selectedTripId = null;
        refreshTripStyles();
        document.dispatchEvent(
          new CustomEvent("tripSelected", { detail: { id: null } })
        );
      }
    });
  }

  async function handleDeleteMatchedTrip(tripId, layer) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Matched Trip",
      message: `Delete matched data for trip ID ${tripId}? Original trip remains.`,
      confirmText: "Delete Match",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) return;
    layer.closePopup();
    return withLoading(`DeleteMatchedTrip_${tripId}`, async () => {
      const response = await fetch(`/api/matched_trips/${tripId}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new Error(
          `Failed to delete matched trip: ${response.statusText}`
        );
      notificationManager.show("Matched trip data deleted.", "success");
      await fetchTrips();
    });
  }

  async function handleDeleteTrip(tripId, layer) {
    const confirmed = await confirmationDialog.show({
      title: "Delete Trip",
      message: `Delete trip ID ${tripId}? Also removes matched data. Cannot be undone.`,
      confirmText: "Delete Permanently",
      confirmButtonClass: "btn-danger",
    });
    if (!confirmed) return;
    layer.closePopup();
    return withLoading(`DeleteTrip_${tripId}`, async () => {
      const tripRes = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!tripRes.ok && tripRes.status !== 404)
        throw new Error(
          `Failed to delete original trip: ${tripRes.statusText}`
        );
      try {
        await fetch(`/api/matched_trips/${tripId}`, { method: "DELETE" });
      } catch (e) {
        console.warn(
          `Could not delete matched trip for ${tripId} (may not exist): ${e.message}`
        );
      }
      notificationManager.show("Trip deleted successfully.", "success");
      await fetchTrips();
    });
  }

  async function handleRematchTrip(tripId, layer, feature) {
    const confirmed = await confirmationDialog.show({
      title: "Re-match Trip",
      message: `Re-match trip ID ${tripId}? Replaces existing matched data.`,
      confirmText: "Re-match",
      confirmButtonClass: "btn-warning",
    });
    if (!confirmed) return;
    layer.closePopup();
    return withLoading(`RematchTrip_${tripId}`, async () => {
      const startTime = feature.properties?.startTime
        ? DateUtils.formatDate(feature.properties.startTime, null)
        : null;
      const endTime = feature.properties?.endTime
        ? DateUtils.formatDate(feature.properties.endTime, null)
        : null;
      if (!startTime || !endTime)
        throw new Error("Cannot re-match trip without valid start/end times.");

      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trip_id: tripId,
          start_date: startTime,
          end_date: endTime,
          force_rematch: true,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Failed to re-match trip: ${errorData.message || response.statusText}`
        );
      }
      const result = await response.json();
      notificationManager.show(
        `Trip re-matched. ${result.matched_count || 0} segments updated.`,
        "success"
      );
      await fetchTrips();
    });
  }

  function fitMapToBounds() {
    if (!AppState.map) return;
    const bounds = L.latLngBounds();
    let hasValidBounds = false;
    Object.values(AppState.mapLayers).forEach((info) => {
      if (info.visible && info.layer) {
        let layerBounds = null;
        try {
          if (info.layer instanceof L.Layer) {
            if (typeof info.layer.getBounds === "function")
              layerBounds = info.layer.getBounds();
          } else if (
            info.layer.type === "FeatureCollection" &&
            info.layer.features?.length > 0
          ) {
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
    if (hasValidBounds) {
      AppState.map.flyToBounds(bounds, {
        padding: CONFIG.MAP.mapBoundsPadding,
        maxZoom: CONFIG.MAP.maxZoom,
        duration: 1.0,
      });
    } else {
      console.log(
        "No valid bounds found for visible layers, cannot fit bounds."
      );
    }
  }

  // --- Standalone Actions ---
  async function mapMatchTrips() {
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
      message: `Map match trips between ${startDate} and ${endDate}? May take time and overwrite existing matched data.`,
      confirmText: "Start Matching",
      confirmButtonClass: "btn-primary",
    });
    if (!confirmed) return;

    return withLoading("MapMatchingRange", async (lm, opId) => {
      lm.updateProgress(opId, 10, "Sending map match request...");
      const response = await fetch("/api/map_match_trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_date: startDate, end_date: endDate }),
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
      await fetchTrips();
      document.dispatchEvent(
        new CustomEvent("mapMatchingCompleted", { detail: { results } })
      );
    });
  }

  async function fetchTripsInRange() {
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
      message: `Fetch raw trip data from source for ${startDate} to ${endDate}? Might take time.`,
      confirmText: "Fetch Data",
      confirmButtonClass: "btn-info",
    });
    if (!confirmed) return;

    return withLoading("FetchTripsRange", async (lm, opId) => {
      lm.updateProgress(opId, 10, "Requesting data fetch...");
      const response = await fetch("/api/fetch_trips_range", {
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
        await fetchTrips();
      } else {
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
    if (!startDate || !endDate) return;
    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const response = await fetch(`/api/metrics?${params.toString()}`);
      if (!response.ok) {
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
      clearMetricsUI();
    }
  }

  function updateMetricsUI(metrics) {
    const metricMap = {
      "total-trips": metrics.total_trips ?? 0,
      "total-distance": metrics.total_distance?.toFixed(1) ?? "0.0",
      "avg-distance": metrics.avg_distance?.toFixed(1) ?? "0.0",
      "avg-start-time": metrics.avg_start_time || "--:--",
      "avg-driving-time": metrics.avg_driving_time || "--:--",
      "avg-speed": metrics.avg_speed?.toFixed(1) ?? "0.0",
      "max-speed": metrics.max_speed?.toFixed(1) ?? "0.0",
    };
    for (const [id, value] of Object.entries(metricMap)) {
      const el = getElement(id, false);
      if (el) {
        if (id.includes("-speed")) el.textContent = `${value} mph`;
        else if (id.includes("-distance")) el.textContent = `${value} miles`;
        else el.textContent = value;
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
    document.addEventListener("filtersApplied", (e) => {
      console.log("Filters applied event received:", e.detail);
      fetchTrips();
      fetchMetrics();
    });

    addSingleEventListener("controls-toggle", "click", function () {
      const mapControls = getElement("map-controls");
      const controlsContent = getElement("controls-content");
      const icon = this.querySelector("i");
      if (mapControls) {
        const isMinimized = mapControls.classList.toggle("minimized");
        if (controlsContent && window.bootstrap?.Collapse) {
          const bsCollapse =
            bootstrap.Collapse.getOrCreateInstance(controlsContent);
          isMinimized ? bsCollapse.hide() : bsCollapse.show();
        } else {
          controlsContent.style.display = isMinimized ? "none" : "";
        }
        if (icon) {
          icon.classList.toggle("fa-chevron-up", !isMinimized);
          icon.classList.toggle("fa-chevron-down", isMinimized);
        }
        setTimeout(() => AppState.map?.invalidateSize(), 350);
      }
    });

    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      refreshTripStyles();
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
        "touchmove",
      ];
      eventsToStop.forEach((eventType) => {
        L.DomEvent.on(
          mapControlsElement,
          eventType,
          L.DomEvent.stopPropagation
        );
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

    document.addEventListener("fabActionTriggered", (e) => {
      const action = e.detail?.action;
      console.log(`FAB Action received: ${action}`);
      switch (action) {
        case "map-match":
          mapMatchTrips();
          break;
        case "fetch-trips":
          fetchTripsInRange();
          break;
      }
    });
  }

  // --- Initialization ---
  function initializeDOMCache() {
    AppState.dom["map"] = getElement("map");
    AppState.dom["map-controls"] = getElement("map-controls");
    AppState.dom["controls-toggle"] = getElement("controls-toggle");
    AppState.dom["controls-content"] = getElement("controls-content");
    AppState.dom["layer-toggles"] = getElement("layer-toggles");
    AppState.dom["layer-order"] = getElement("layer-order");
    AppState.dom["highlight-recent-trips"] = getElement(
      "highlight-recent-trips"
    );
  }

  function setInitialDates() {
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
    initializeEventListeners();

    if (AppState.dom.map) {
      try {
        await initializeMap();
        if (!isMapReady())
          throw new Error("Map components failed to initialize properly.");
        initializeLayerControls();
        console.log("Performing initial data fetch...");
        await Promise.all([fetchTrips(), fetchMetrics()]);
        document.dispatchEvent(new CustomEvent("initialDataLoaded"));
        console.log("EveryStreet App initialized successfully.");
      } catch (error) {
        handleError(error, "Application Initialization");
      }
    } else {
      console.log(
        "Map container not found, skipping map initialization and data fetch."
      );
    }
  }

  // --- Global Event Listeners ---
  document.addEventListener("DOMContentLoaded", initialize);

  // --- Cleanup Placeholder ---
  // window.addEventListener("beforeunload", () => {
  //   // Add cleanup logic here if needed (e.g., stop polling)
  // });

  // --- Public API ---
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
