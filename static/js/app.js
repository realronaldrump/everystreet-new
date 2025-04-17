/* global handleError , DateUtils, L, Chart */

"use strict";

(function () {
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
        dark: "",
        light: "",
        satellite: "",
        streets: "",
      },
      maxZoom: 19,
      recentTripThreshold: 6 * 60 * 60 * 1000,
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
    geoJsonLayers: {},
  };

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
  };

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

  const debouncedUpdateMap = window.utils.debounce(
    updateMap,
    CONFIG.MAP.debounceDelay,
  );

  const getStartDate = () => {
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.startDate);
    return storedDate
      ? DateUtils.formatDate(storedDate)
      : DateUtils.getCurrentDate();
  };

  const getEndDate = () => {
    const storedDate = getStorageItem(CONFIG.STORAGE_KEYS.endDate);
    return storedDate
      ? DateUtils.formatDate(storedDate)
      : DateUtils.getCurrentDate();
  };

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

      AppState.map = L.map("map", {
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

      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";

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

      L.control
        .zoom({
          position: "topright",
        })
        .addTo(AppState.map);

      AppState.layerGroup = L.layerGroup().addTo(AppState.map);

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

      const defaultBasemap = theme === "light" ? "Light" : "Dark";
      if (basemaps.Dark && defaultBasemap === "Dark") {
        basemaps.Dark.addTo(AppState.map);
      } else if (basemaps.Light && defaultBasemap === "Light") {
        basemaps.Light.addTo(AppState.map);
      } else {
        basemaps.Dark.addTo(AppState.map);
      }

      L.control
        .layers(basemaps, null, {
          position: "topright",
          collapsed: true,
        })
        .addTo(AppState.map);

      const debouncedUpdateUrlWithMapState = debounce(
        updateUrlWithMapState,
        200,
      );

      AppState.map.on("zoomend", debouncedUpdateUrlWithMapState);
      AppState.map.on("moveend", debouncedUpdateUrlWithMapState);

      document.dispatchEvent(new CustomEvent("mapInitialized"));

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

  function adjustLayerStylesForZoom() {
    if (!AppState.map || !AppState.layerGroup) return;

    const zoom = AppState.map.getZoom();

    AppState.layerGroup.eachLayer((layer) => {
      if (layer.feature?.properties) {
        let layerName = "trips";
        if (layer.feature.properties.transactionId?.startsWith("MATCHED-")) {
          layerName = "matchedTrips";
        } else if (layer.feature.properties.type === "undriven") {
          layerName = "undrivenStreets";
        }

        const layerInfo = AppState.mapLayers[layerName];

        if (zoom > 14) {
          const weight = (layerInfo.weight || 1.5) * 1.5;
          layer.setStyle({ weight });
        } else {
          layer.setStyle({ weight: layerInfo.weight || 1.5 });
        }
      }
    });
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
    batchLayerControls(layerToggles, AppState.mapLayers);
    delegateLayerControls(layerToggles);
    updateLayerOrderUI();
  }

  function toggleLayer(name, visible) {
    const layerInfo = AppState.mapLayers[name];
    if (!layerInfo) return;
    layerInfo.visible = visible;
    if (name === "customPlaces" && window.customPlaces) {
      window.customPlaces.toggleVisibility(visible);
    } else if (name === "undrivenStreets" && visible) {
      lazyFetchUndrivenStreets();
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
    const visibleLayers = Object.entries(AppState.mapLayers)
      .filter(([, info]) => info.visible && info.layer)
      .sort(([, a], [, b]) => b.order - a.order);
    batchLayerOrderUI(layerOrderEl, visibleLayers);
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

  async function withLoading(
    operationId,
    operation,
    totalWeight = 100,
    subOperations = {},
  ) {
    const loadingManager = window.loadingManager || {
      startOperation: () => undefined,
      addSubOperation: () => undefined,
      updateSubOperation: () => undefined,
      finish: () => undefined,
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

        await updateTripsTable(geojson);
        await updateMapWithTrips(geojson);

        try {
          await fetchMatchedTrips();
        } catch (err) {
          handleError(err, "Fetching Matched Trips");
        }

        await updateMap();

        lm.updateSubOperation(opId, "Processing Data", 30);
        lm.updateSubOperation(opId, "Displaying Data", 20);

        document.dispatchEvent(
          new CustomEvent("tripsLoaded", {
            detail: { count: geojson.features.length },
          }),
        );
      },
      100,
    );
  }

  function updateTripsTable(geojson) {
    if (!window.tripsTable) return;

    const formattedTrips = geojson.features.map((trip) => ({
      ...trip.properties,
      gps: trip.geometry,
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
      startTimeRaw: trip.properties.startTime,
      endTimeRaw: trip.properties.endTime,
      destination: trip.properties.destination || "N/A",
      startLocation: trip.properties.startLocation || "N/A",
      distance: Number(trip.properties.distance).toFixed(2),
    }));

    if ($.fn.DataTable.isDataTable("#tripsTable")) {
      window.tripsTable.clear().rows.add(formattedTrips).draw();
    } else {
      showNotification("Trips DataTable not initialized yet.", "warning");
    }
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

  function fetchMatchedTrips() {
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
    return fetch(`/api/matched_trips?${params.toString()}`)
      .then((response) => {
        if (!response.ok)
          throw new Error(
            `HTTP error fetching matched trips: ${response.status}`,
          );
        return response.json();
      })
      .then((geojson) => {
        AppState.mapLayers.matchedTrips.layer = geojson;
        return geojson;
      });
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

      let location = null;
      try {
        location = JSON.parse(locationSelect.value);
        showNotification(
          `[fetchUndrivenStreets] Parsed location object from dropdown: ${JSON.stringify(location, null, 2)}`,
          "info",
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
      );

      showNotification(
        `Loading undriven streets for ${location.display_name}...`,
        "info",
      );
      window.handleError(
        "[fetchUndrivenStreets] Sending POST request to /api/undriven_streets with location:",
        location,
        "info",
      );

      const response = await fetch("/api/undriven_streets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(location),
      });

      showNotification(
        `[fetchUndrivenStreets] Received response status: ${response.status}`,
        "info",
      );

      if (!response.ok) {
        let errorDetail = `HTTP error ${response.status}`;
        try {
          const errorData = await response.json();
          errorDetail = errorData.detail || errorDetail;
        } catch (e) {}
        throw new Error(errorDetail);
      }

      const geojson = await response.json();
      showNotification(
        `[fetchUndrivenStreets] Received GeoJSON data: ${JSON.stringify(geojson, null, 2)}`,
        "info",
      );

      if (!geojson.features || geojson.features.length === 0) {
        window.handleError(
          `[fetchUndrivenStreets] No features found in response for ${location.display_name}. Showing notification.`,
          "fetchUndrivenStreets",
          "info",
        );
        showNotification(
          `No undriven streets found in ${location.display_name}`,
          "info",
        );
      } else {
        window.handleError(
          `[fetchUndrivenStreets] Found ${geojson.features.length} features for ${location.display_name}. Updating map.`,
          "fetchUndrivenStreets",
          "info",
        );
        showNotification(
          `Loaded ${geojson.features.length} undriven street segments`,
          "success",
        );
      }

      await updateMapWithUndrivenStreets(geojson);
      await updateMap();
      return geojson;
    } catch (error) {
      handleError(error, "Error fetching undriven streets");
      showNotification(
        `Failed to load undriven streets: ${error.message}`,
        "danger",
      );
      AppState.mapLayers.undrivenStreets.visible = false;
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
    const tripLayers = new Map();
    for (const [name, info] of visibleLayers) {
      if (name === "customPlaces" && info.layer instanceof L.LayerGroup) {
        info.layer.addTo(AppState.layerGroup);
      } else if (["trips", "matchedTrips"].includes(name)) {
        if (info.layer?.features) {
          info.layer.features.forEach((feature) => {
            const hitLayer = L.geoJSON(feature, {
              style: {
                color: "#000",
                opacity: 0,
                weight: 20,
                interactive: true,
              },
              onEachFeature: (f, layer) => {
                layer.on("click", (e) =>
                  handleTripClick(e, f, layer, info, name),
                );
              },
            });
            hitLayer.addTo(AppState.layerGroup);
          });
          const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
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
        const geoJsonLayer = getOrCreateGeoJsonLayer(name, info.layer, {
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
    if (AppState.selectedTripId && tripLayers.has(AppState.selectedTripId)) {
      tripLayers.get(AppState.selectedTripId)?.bringToFront();
    }
    if (fitBounds) {
      fitMapBounds();
    }
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
        window.handleError(
          "Error calculating duration",
          "createTripPopupContent",
          "warn",
        );
      }
    }

    const formatSpeed = (speed) => {
      if (speed === null || speed === undefined) return "Unknown";
      const speedValue = parseFloat(speed);
      return isNaN(speedValue)
        ? "Unknown"
        : `${(speedValue * 0.621371).toFixed(1)} mph`;
    };

    const maxSpeed = formatSpeed(tripData.maxSpeed);
    const avgSpeed = formatSpeed(tripData.averageSpeed);

    let html = `
      <div class="trip-popup">
        <h4>${isMatched ? "Matched Trip" : "Trip"}</h4>
        <table class="popup-data">
          <tr><th>Start Time:</th><td>${startTimeDisplay}</td></tr>
          <tr><th>End Time:</th><td>${endTimeDisplay}</td></tr>
          <tr><th>Duration:</th><td>${durationDisplay}</td></tr>
          <tr><th>Distance:</th><td>${distance}</td></tr>
    `;

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

    html += `
      <tr><th>Max Speed:</th><td>${maxSpeed}</td></tr>
      <tr><th>Avg Speed:</th><td>${avgSpeed}</td></tr>
    `;

    if (tripData.totalIdleDurationFormatted) {
      html += `<tr><th>Idle Time:</th><td>${tripData.totalIdleDurationFormatted}</td></tr>`;
    }

    if (tripData.hardBrakingCount > 0) {
      html += `<tr><th>Hard Braking:</th><td>${tripData.hardBrakingCount}</td></tr>`;
    }

    if (tripData.hardAccelerationCount > 0) {
      html += `<tr><th>Hard Accel:</th><td>${tripData.hardAccelerationCount}</td></tr>`;
    }

    html += `
        </table>
        <div class="trip-actions" data-trip-id="${tripData.id}">
    `;

    if (isMatched) {
      html +=
        '<button class="btn btn-sm btn-danger delete-matched-trip">Delete Match</button>';
    } else {
      html += `
          <button class="btn btn-sm btn-primary rematch-trip">Rematch</button>
          <button class="btn btn-sm btn-danger delete-trip">Delete</button>
      `;
    }

    html += "</div></div>";
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
      } catch (e) {}
    });

    if (validBounds) AppState.map.fitBounds(bounds);
  }

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
      const metrics = await cachedFetch(
        `/api/metrics?start_date=${startDate}&end_date=${endDate}&imei=${imei}`,
      );
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

  async function fetchCoverageAreas() {
    try {
      const data = await cachedFetch("/api/coverage_areas");
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

  async function populateLocationDropdown() {
    const dropdown = document.getElementById("undriven-streets-location");
    if (!dropdown) return;

    while (dropdown.options.length > 1) {
      dropdown.remove(1);
    }

    const coverageAreas = await fetchCoverageAreas();

    if (coverageAreas.length === 0) {
      const option = document.createElement("option");
      option.textContent = "No coverage areas available";
      option.disabled = true;
      dropdown.appendChild(option);
      return;
    }

    coverageAreas.forEach((area) => {
      const option = document.createElement("option");
      option.value = JSON.stringify(area.location);
      option.textContent = area.location.display_name;
      dropdown.appendChild(option);
    });

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
            if (
              localStorage.getItem("layer_visible_undrivenStreets") === "true"
            ) {
              fetchUndrivenStreets();
            }
            break;
          }
        } catch (e) {}
      }
    }
  }

  function initializeEventListeners() {
    const controlsToggle = getElement("controls-toggle");
    const controlsContent = getElement("controls-content");

    if (controlsToggle && controlsContent) {
      const icon = controlsToggle.querySelector("i");

      if (icon) {
        if (controlsContent.classList.contains("show")) {
          icon.classList.remove("fa-chevron-down");
          icon.classList.add("fa-chevron-up");
        } else {
          icon.classList.remove("fa-chevron-up");
          icon.classList.add("fa-chevron-down");
        }
      }

      controlsContent.addEventListener("show.bs.collapse", function () {
        if (icon) {
          icon.classList.remove("fa-chevron-down");
          icon.classList.add("fa-chevron-up");
        }
      });

      controlsContent.addEventListener("hide.bs.collapse", function () {
        if (icon) {
          icon.classList.remove("fa-chevron-up");
          icon.classList.add("fa-chevron-down");
        }
      });
    }

    addSingleEventListener("map-match-trips", "click", mapMatchTrips);

    addSingleEventListener("highlight-recent-trips", "change", function () {
      AppState.mapSettings.highlightRecentTrips = this.checked;
      debouncedUpdateMap();
    });

    const locationDropdown = document.getElementById(
      "undriven-streets-location",
    );
    if (locationDropdown) {
      locationDropdown.addEventListener("change", function () {
        if (AppState.mapLayers.undrivenStreets?.visible) {
          fetchUndrivenStreets();
        }
      });
    }

    document.addEventListener("filtersApplied", (e) => {
      window.handleError(
        "Filters applied event received in app.js:",
        e.detail,
        "info",
      );
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
            return Promise.reject("Map initialization failed");
          }

          initializeLayerControls();

          return populateLocationDropdown();
        })
        .then(() => {
          Object.keys(AppState.mapLayers).forEach((layerName) => {
            const savedVisibility = localStorage.getItem(
              `layer_visible_${layerName}`,
            );

            if (savedVisibility !== null) {
              const isVisible = savedVisibility === "true";
              AppState.mapLayers[layerName].visible = isVisible;
              const toggle = document.getElementById(`${layerName}-toggle`);
              if (toggle) toggle.checked = isVisible;
            } else {
              const toggle = document.getElementById(`${layerName}-toggle`);
              if (toggle)
                toggle.checked = AppState.mapLayers[layerName].visible;
            }

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
          updateLayerOrderUI();

          initializeLiveTracker();

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

  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function throttle(func, limit) {
    let inThrottle;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  const apiCache = {};
  async function cachedFetch(url, options = {}, cacheTime = 10000) {
    const key = url + JSON.stringify(options);
    const now = Date.now();
    if (apiCache[key] && now - apiCache[key].ts < cacheTime) {
      return apiCache[key].data;
    }
    const response = await fetch(url, options);
    const data = await response.json();
    apiCache[key] = { data, ts: now };
    return data;
  }

  function batchLayerControls(layerToggles, layers) {
    const fragment = document.createDocumentFragment();
    Object.entries(layers).forEach(([name, info]) => {
      const div = document.createElement("div");
      div.className = "layer-control";
      div.dataset.layerName = name;
      div.innerHTML = `
        <label class="custom-checkbox">
          <input type="checkbox" id="${name}-toggle" ${info.visible ? "checked" : ""}>
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
      fragment.appendChild(div);
    });
    layerToggles.innerHTML = "";
    layerToggles.appendChild(fragment);
  }

  function batchLayerOrderUI(layerOrderEl, visibleLayers) {
    layerOrderEl.innerHTML = '<h4 class="h6">Layer Order</h4>';
    const ul = document.createElement("ul");
    ul.id = "layer-order-list";
    ul.className = "list-group bg-dark";
    const fragment = document.createDocumentFragment();
    visibleLayers.forEach(([name, info]) => {
      const li = document.createElement("li");
      li.textContent = info.name || name;
      li.draggable = true;
      li.dataset.layer = name;
      li.className = "list-group-item bg-dark text-white";
      fragment.appendChild(li);
    });
    ul.appendChild(fragment);
    layerOrderEl.appendChild(ul);
  }

  function delegateLayerControls(layerToggles) {
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
  }

  function delegatePopupActions(mapContainer) {
    mapContainer.addEventListener("click", function (e) {
      const btn = e.target.closest("button");
      if (!btn) return;
      const tripActions = btn.closest(".trip-actions");
      if (!tripActions) return;
      const tripId = tripActions.dataset.tripId;
      if (!tripId) return;
      if (btn.classList.contains("delete-matched-trip")) {
        handleDeleteMatchedTrip(tripId);
      } else if (btn.classList.contains("delete-trip")) {
        handleDeleteTrip(tripId);
      } else if (btn.classList.contains("rematch-trip")) {
        handleRematchTrip(tripId);
      }
    });
  }

  const throttledAdjustLayerStylesForZoom = throttle(
    adjustLayerStylesForZoom,
    200,
  );

  function getOrCreateGeoJsonLayer(name, data, options) {
    if (!AppState.geoJsonLayers[name]) {
      AppState.geoJsonLayers[name] = L.geoJSON(data, options);
    } else {
      AppState.geoJsonLayers[name].clearLayers();
      AppState.geoJsonLayers[name].addData(data);
      if (options && options.style) {
        AppState.geoJsonLayers[name].setStyle(options.style);
      }
    }
    return AppState.geoJsonLayers[name];
  }

  let undrivenStreetsLoaded = false;
  async function lazyFetchUndrivenStreets() {
    if (!undrivenStreetsLoaded) {
      undrivenStreetsLoaded = true;
      return fetchUndrivenStreets();
    }
    return AppState.mapLayers.undrivenStreets.layer;
  }

  window.addEventListener("keydown", function (e) {
    if (!AppState.map) return;
    switch (e.key) {
      case "+":
      case "=":
        AppState.map.zoomIn();
        break;
      case "-":
        AppState.map.zoomOut();
        break;
      case "ArrowUp":
        AppState.map.panBy([0, -100]);
        break;
      case "ArrowDown":
        AppState.map.panBy([0, 100]);
        break;
      case "ArrowLeft":
        AppState.map.panBy([-100, 0]);
        break;
      case "ArrowRight":
        AppState.map.panBy([100, 0]);
        break;
    }
  });
})();
