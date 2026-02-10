/**
 * MapManager - View State and Trip Selection Management
 *
 * This module handles:
 * - Map view state persistence (center, zoom)
 * - Trip selection and highlighting
 * - Zoom/pan navigation helpers
 *
 * Map initialization is handled by map-core.js
 */

/* global mapboxgl */

import { CONFIG } from "./core/config.js";
import store from "./core/store.js";
import mapCore from "./map-core.js";
import MapStyles from "./map-styles.js";
import { DateUtils, utils } from "./utils.js";

// Debounced view state saver
let saveViewStateDebounced = null;

const mapManager = {
  // Track if view state listener is bound
  _viewListenerBound: false,
  _selectedTripOverlayRequestId: 0,

  _coerceEpochToMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    // Heuristic: seconds since epoch are < 1e12, ms since epoch are ~1e12-1e13.
    return value < 1e12 ? value * 1000 : value;
  },

  async _fetchTripById(tripId, abortKey = null) {
    const url = CONFIG.API.tripById(tripId);
    return utils.fetchWithRetry(
      url,
      {},
      CONFIG.API.retryAttempts,
      CONFIG.API.cacheTime,
      abortKey
    );
  },

  _pickTripGeometry(trip, layerName) {
    if (!trip) {
      return null;
    }
    if (layerName === "matchedTrips" && trip.matchedGps) {
      return trip.matchedGps;
    }
    return trip.gps || trip.matchedGps || null;
  },

  _extendBoundsFromGeometry(bounds, geometry) {
    if (!bounds || !geometry) {
      return;
    }

    const extendCoord = (coord) => {
      if (!Array.isArray(coord) || coord.length < 2) {
        return;
      }
      const lng = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        return;
      }
      bounds.extend([lng, lat]);
    };

    const type = geometry.type;
    const coords = geometry.coordinates;

    if (type === "Point") {
      extendCoord(coords);
      return;
    }
    if (type === "LineString" && Array.isArray(coords)) {
      coords.forEach(extendCoord);
      return;
    }
    if (type === "MultiLineString" && Array.isArray(coords)) {
      coords.forEach((line) => {
        if (Array.isArray(line)) {
          line.forEach(extendCoord);
        }
      });
      return;
    }
    if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
      geometry.geometries.forEach((g) => this._extendBoundsFromGeometry(bounds, g));
    }
  },

  /**
   * Initialize the map using MapCore and set up view state management
   * @returns {Promise<boolean>}
   */
  async initialize() {
    const success = await mapCore.initialize();

    if (success) {
      this._setupViewStateManagement();
      this._setupClickHandler();
      this._setupViewChangeListener();
    }

    return success;
  },

  /**
   * Set up debounced view state persistence
   * @private
   */
  _setupViewStateManagement() {
    if (!store.map) {
      return;
    }

    saveViewStateDebounced = utils.debounce(() => {
      if (!store.map) {
        return;
      }

      const center = store.map.getCenter();
      const zoom = store.map.getZoom();

      store.updateMapView(
        {
          center: [center.lng, center.lat],
          zoom,
        },
        { source: "map" }
      );
    }, CONFIG.MAP.debounceDelay);

    store.map.on("moveend", saveViewStateDebounced);
  },

  /**
   * Set up click handler for trip deselection
   * @private
   */
  _setupClickHandler() {
    if (!store.map) {
      return;
    }
    store.map.on("click", this._handleMapClick.bind(this));
  },

  /**
   * Set up listener for external view change events
   * @private
   */
  _setupViewChangeListener() {
    if (this._viewListenerBound) {
      return;
    }

    document.addEventListener("es:map-view-change", (event) => {
      if (!store.map) {
        return;
      }

      // Ignore events we triggered ourselves
      if (event.detail?.source === "map") {
        return;
      }

      const view = event.detail?.view;
      if (!view || !Array.isArray(view.center) || !Number.isFinite(view.zoom)) {
        return;
      }

      try {
        store.map.jumpTo({ center: view.center, zoom: view.zoom });
      } catch (err) {
        console.warn("Failed to apply map view from store:", err);
      }
    });

    this._viewListenerBound = true;
  },

  /**
   * Handle click on empty map area (deselect trips)
   * @private
   */
  _handleMapClick(e) {
    // Build list of queryable layers
    const queryLayers = [];

    if (store.map.getLayer("trips-hitbox")) {
      queryLayers.push("trips-hitbox");
    } else if (!store.mapLayers.trips?.isHeatmap && store.map.getLayer("trips-layer")) {
      queryLayers.push("trips-layer");
    } else if (
      store.mapLayers.trips?.isHeatmap
      && store.map.getLayer("trips-layer-1")
    ) {
      queryLayers.push("trips-layer-1");
    }

    if (store.map.getLayer("matchedTrips-hitbox")) {
      queryLayers.push("matchedTrips-hitbox");
    } else if (
      !store.mapLayers.matchedTrips?.isHeatmap
      && store.map.getLayer("matchedTrips-layer")
    ) {
      queryLayers.push("matchedTrips-layer");
    } else if (
      store.mapLayers.matchedTrips?.isHeatmap
      && store.map.getLayer("matchedTrips-layer-1")
    ) {
      queryLayers.push("matchedTrips-layer-1");
    }

    if (queryLayers.length === 0) {
      // No queryable layers, just clear selection if needed
      if (store.selectedTripId) {
        store.selectedTripId = null;
        store.selectedTripLayer = null;
        this.refreshTripStyles();
      }
      return;
    }

    const features = store.map.queryRenderedFeatures(e.point, {
      layers: queryLayers,
    });

    // Clear selection if clicked on empty space
    if (features.length === 0 && store.selectedTripId) {
      store.selectedTripId = null;
      store.selectedTripLayer = null;
      this.refreshTripStyles();
    }
  },

  /**
   * Update URL with current map state
   */
  updateUrlState() {
    if (!store.map || !window.history?.replaceState) {
      return;
    }

    try {
      const center = store.map.getCenter();
      const zoom = store.map.getZoom();
      const url = new URL(window.location.href);

      url.searchParams.set("zoom", zoom.toFixed(2));
      url.searchParams.set("lat", center.lat.toFixed(5));
      url.searchParams.set("lng", center.lng.toFixed(5));

      window.history.replaceState(window.history.state, document.title, url.toString());
    } catch (error) {
      console.warn("Failed to update URL:", error);
    }
  },

  /**
   * Refresh trip styling based on selection state
   * Throttled to prevent excessive updates
   */
  refreshTripStyles: utils.throttle(function () {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    const selectedId = store.selectedTripId ? String(store.selectedTripId) : null;

    ["trips", "matchedTrips"].forEach((layerName) => {
      const layerInfo = store.mapLayers[layerName];
      if (!layerInfo?.visible) {
        return;
      }

      // Skip heatmap layers - they don't support trip selection styling
      if (layerInfo.isHeatmap) {
        return;
      }

      const layerId = `${layerName}-layer`;
      if (!store.map.getLayer(layerId)) {
        return;
      }

      const baseColor = layerInfo.color || "#3b8a7f";
      const baseWeight = layerInfo.weight || 2;

      // Build color expression
      const colorExpr = selectedId
        ? [
            "case",
            [
              "==",
              ["to-string", ["coalesce", ["get", "transactionId"], ["get", "id"]]],
              selectedId,
            ],
            layerInfo.highlightColor || "#d09868",
            baseColor,
          ]
        : baseColor;

      // Build width expression
      const widthExpr = selectedId
        ? [
            "case",
            [
              "==",
              ["to-string", ["coalesce", ["get", "transactionId"], ["get", "id"]]],
              selectedId,
            ],
            baseWeight * 2,
            baseWeight,
          ]
        : baseWeight;

      try {
        store.map.setPaintProperty(layerId, "line-color", colorExpr);
        store.map.setPaintProperty(layerId, "line-opacity", layerInfo.opacity);
        store.map.setPaintProperty(layerId, "line-width", widthExpr);
      } catch (error) {
        console.warn("Failed to update trip styles:", error);
      }
    });

    // Update overlay for heatmap selected trip
    this._updateSelectedTripOverlay(selectedId);
  }, CONFIG.MAP.throttleDelay),

  /**
   * Update or remove the selected trip overlay (for heatmap mode)
   * @private
   */
  _updateSelectedTripOverlay(selectedId) {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    const sourceId = "selected-trip-source";
    const layerId = "selected-trip-layer";

    const removeOverlay = () => {
      if (store.map.getLayer(layerId)) {
        store.map.removeLayer(layerId);
      }
      if (store.map.getSource(sourceId)) {
        store.map.removeSource(sourceId);
      }
    };

    // Selected trip overlay is always drawn from the authoritative full-resolution
    // geometry (via `/api/trips/{id}`) so we don't sacrifice accuracy to tiling/simplification.
    const selectedLayer = store.selectedTripLayer;
    const validTripLayer = selectedLayer === "trips" || selectedLayer === "matchedTrips";
    const layerInfo = validTripLayer ? store.mapLayers[selectedLayer] : null;

    if (!selectedId || !layerInfo || !layerInfo.visible || !validTripLayer) {
      removeOverlay();
      return;
    }

    const fallbackHighlight = selectedLayer === "matchedTrips" ? "#4da396" : "#d09868";
    const highlightColor
      = (selectedLayer === "matchedTrips"
        ? MapStyles.MAP_LAYER_COLORS?.matchedTrips?.highlight
        : MapStyles.MAP_LAYER_COLORS?.trips?.selected)
      || layerInfo.highlightColor
      || fallbackHighlight;

    const highlightWidth = [
      "interpolate",
      ["linear"],
      ["zoom"],
      6,
      2,
      10,
      4,
      14,
      6,
      18,
      10,
      22,
      14,
    ];

    const requestId = (this._selectedTripOverlayRequestId += 1);
    const tripId = String(selectedId);

    this._fetchTripById(tripId, "selectedTripOverlay")
      .then((payload) => {
        if (this._selectedTripOverlayRequestId !== requestId) {
          return;
        }

        const trip = payload?.trip;
        const geometry = this._pickTripGeometry(trip, selectedLayer);
        if (!geometry) {
          removeOverlay();
          return;
        }

        const selectedFeature = {
          type: "Feature",
          geometry,
          properties: {
            transactionId: trip?.transactionId || tripId,
          },
        };

        // Create or update source
        if (!store.map.getSource(sourceId)) {
          store.map.addSource(sourceId, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [selectedFeature] },
          });
        } else {
          store.map.getSource(sourceId).setData({
            type: "FeatureCollection",
            features: [selectedFeature],
          });
        }

        // Create or update layer
        if (!store.map.getLayer(layerId)) {
          store.map.addLayer({
            id: layerId,
            type: "line",
            source: sourceId,
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": highlightColor,
              "line-opacity": 0.9,
              "line-width": highlightWidth,
            },
          });
        } else {
          store.map.setPaintProperty(layerId, "line-color", highlightColor);
          store.map.setPaintProperty(layerId, "line-width", highlightWidth);
        }
      })
      .catch((error) => {
        if (this._selectedTripOverlayRequestId !== requestId) {
          return;
        }
        console.warn("Failed to load selected trip overlay:", error);
        removeOverlay();
      });
  },

  /**
   * Fit map bounds to show all visible features
   * @param {boolean} animate - Whether to animate the transition
   */
  async fitBounds(animate = true) {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasFeatures = false;

    Object.values(store.mapLayers).forEach(({ visible, layer }) => {
      if (visible && layer?.features) {
        layer.features.forEach((feature) => {
          if (feature.geometry) {
            if (feature.geometry.type === "Point") {
              bounds.extend(feature.geometry.coordinates);
              hasFeatures = true;
            } else if (feature.geometry.type === "LineString") {
              feature.geometry.coordinates.forEach((coord) => {
                bounds.extend(coord);
                hasFeatures = true;
              });
            }
          }
        });
      }
    });

    if (hasFeatures && !bounds.isEmpty()) {
      store.map.fitBounds(bounds, {
        padding: 50,
        maxZoom: 15,
        duration: animate ? 1000 : 0,
      });
    } else {
      // Vector-tiled trip layers don't have an in-memory FeatureCollection to bound.
      // Fall back to a "zoom to last trip" behavior so filter changes still feel responsive.
      await this.zoomToLastTrip();
    }
  },

  /**
   * Zoom to a specific trip by ID
   * @param {string|number} tripId - The trip ID to zoom to
   */
  async zoomToTrip(tripId) {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    try {
      const payload = await this._fetchTripById(String(tripId), "zoomToTrip");
      const trip = payload?.trip;
      const geometry = this._pickTripGeometry(trip, "trips");

      if (!geometry) {
        console.warn(`Trip ${tripId} has no geometry`);
        return;
      }

      const bounds = new mapboxgl.LngLatBounds();
      this._extendBoundsFromGeometry(bounds, geometry);

      if (!bounds.isEmpty()) {
        store.map.fitBounds(bounds, {
          padding: 50,
          maxZoom: 15,
          duration: 2000,
        });
      }

      store.selectedTripId = tripId;
      store.selectedTripLayer = "trips";
      this.refreshTripStyles();
    } catch (error) {
      console.warn("Failed to zoom to trip:", error);
    }
  },

  /**
   * Zoom to the most recent trip
   * @param {number} targetZoom - Zoom level to use
   */
  async zoomToLastTrip(targetZoom = 14) {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    try {
      const { start, end } = DateUtils.getCachedDateRange();
      const imei = utils.getStorage(CONFIG.STORAGE_KEYS.selectedVehicle);
      const params = new URLSearchParams({ start_date: start, end_date: end });
      if (imei) {
        params.set("imei", imei);
      }

      const data = await utils.fetchWithRetry(
        `${CONFIG.API.tripLastInRange}?${params}`,
        {},
        CONFIG.API.retryAttempts,
        CONFIG.API.cacheTime,
        "zoomToLastTrip"
      );

      const tripId = data?.transactionId;
      const lastCoord = data?.lastCoord;

      if (Array.isArray(lastCoord) && lastCoord.length === 2) {
        const lng = Number(lastCoord[0]);
        const lat = Number(lastCoord[1]);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          store.map.flyTo({
            center: [lng, lat],
            zoom: targetZoom,
            duration: 2000,
            essential: true,
          });
        }
      }

      if (tripId) {
        store.selectedTripId = tripId;
        store.selectedTripLayer = "trips";
        this.refreshTripStyles();
      }
    } catch (error) {
      console.warn("Failed to zoom to last trip:", error);
    }
  },

  /**
   * Pan to a specific location
   * @param {Array<number>} center - [lng, lat] coordinates
   * @param {number} zoom - Optional zoom level
   */
  panTo(center, zoom) {
    if (!store.map) {
      return;
    }

    const options = { center, duration: 1000 };
    if (typeof zoom === "number") {
      options.zoom = zoom;
    }

    store.map.flyTo(options);
  },

  /**
   * Get current map view state
   * @returns {Object|null}
   */
  getViewState() {
    if (!store.map) {
      return null;
    }

    const center = store.map.getCenter();
    return {
      center: [center.lng, center.lat],
      zoom: store.map.getZoom(),
      bearing: store.map.getBearing(),
      pitch: store.map.getPitch(),
    };
  },

  /**
   * Clean up event listeners
   */
  cleanup() {
    if (store.map && saveViewStateDebounced) {
      store.map.off("moveend", saveViewStateDebounced);
    }
  },
};

export default mapManager;
