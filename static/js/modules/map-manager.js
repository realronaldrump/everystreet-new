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
import mapCore from "./map-core.js";
import store from "./core/store.js";
import MapStyles from "./map-styles.js";
import { utils } from "./utils.js";

// Debounced view state saver
let saveViewStateDebounced = null;

const mapManager = {
  // Track if view state listener is bound
  _viewListenerBound: false,

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
    } else if (store.map.getLayer("matchedTrips-layer")) {
      queryLayers.push("matchedTrips-layer");
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

      window.history.replaceState({}, "", url.toString());
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

      const baseColor = layerInfo.color || "#4A90D9";
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
            layerInfo.highlightColor || "#FFD700",
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

    // Remove overlay if no selection or not in heatmap mode
    if (
      !selectedId
      || store.selectedTripLayer !== "trips"
      || !store.mapLayers.trips?.isHeatmap
      || !store.mapLayers.trips?.visible
    ) {
      removeOverlay();
      return;
    }

    // Find the matching feature
    const tripLayer = store.mapLayers.trips?.layer;
    const matchingFeature = tripLayer?.features?.find((feature) => {
      const featureId
        = feature?.properties?.transactionId
        || feature?.properties?.id
        || feature?.properties?.tripId
        || feature?.id;
      return featureId != null && String(featureId) === selectedId;
    });

    if (!matchingFeature?.geometry) {
      removeOverlay();
      return;
    }

    const selectedFeature = {
      type: "Feature",
      geometry: matchingFeature.geometry,
      properties: matchingFeature.properties || {},
    };

    const highlightColor = MapStyles.MAP_LAYER_COLORS?.trips?.selected || "#FFD700";

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
  },

  /**
   * Fit map bounds to show all visible features
   * @param {boolean} animate - Whether to animate the transition
   */
  async fitBounds(animate = true) {
    if (!store.map || !store.mapInitialized) {
      return;
    }

    await utils.measurePerformance("fitBounds", () => {
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
      }
    });
  },

  /**
   * Zoom to a specific trip by ID
   * @param {string|number} tripId - The trip ID to zoom to
   */
  async zoomToTrip(tripId) {
    if (!store.map || !store.mapLayers.trips?.layer?.features) {
      return;
    }

    // Wait for features to be loaded if they aren't yet
    if (store.mapLayers.trips.layer.features.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const { features } = store.mapLayers.trips.layer;
    const tripFeature = features.find((f) => {
      const fId
        = f.properties?.transactionId || f.properties?.id || f.properties?.tripId || f.id;
      return String(fId) === String(tripId);
    });

    if (!tripFeature?.geometry) {
      console.warn(`Trip ${tripId} not found in loaded features`);
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    const { type, coordinates } = tripFeature.geometry;

    if (type === "LineString") {
      coordinates.forEach((coord) => bounds.extend(coord));
    } else if (type === "Point") {
      bounds.extend(coordinates);
    }

    if (!bounds.isEmpty()) {
      store.map.fitBounds(bounds, {
        padding: 50,
        maxZoom: 15,
        duration: 2000,
      });

      // Select the trip
      store.selectedTripId = tripId;
      store.selectedTripLayer = "trips";
      this.refreshTripStyles();
    }
  },

  /**
   * Zoom to the most recent trip
   * @param {number} targetZoom - Zoom level to use
   */
  zoomToLastTrip(targetZoom = 14) {
    if (!store.map || !store.mapLayers.trips?.layer?.features) {
      return;
    }

    const { features } = store.mapLayers.trips.layer;

    // Find the trip with the most recent end time
    const lastTripFeature = features.reduce((latest, feature) => {
      const endTime = feature.properties?.endTime;
      if (!endTime) {
        return latest;
      }

      const time = new Date(endTime).getTime();
      const latestTime = latest?.properties?.endTime
        ? new Date(latest.properties.endTime).getTime()
        : 0;

      return time > latestTime ? feature : latest;
    }, null);

    if (!lastTripFeature?.geometry) {
      return;
    }

    let lastCoord = null;
    const { type, coordinates } = lastTripFeature.geometry;

    if (type === "LineString" && coordinates?.length > 0) {
      lastCoord = coordinates[coordinates.length - 1];
    } else if (type === "Point") {
      lastCoord = coordinates;
    }

    if (
      lastCoord?.length === 2
      && !Number.isNaN(lastCoord[0])
      && !Number.isNaN(lastCoord[1])
    ) {
      store.map.flyTo({
        center: lastCoord,
        zoom: targetZoom,
        duration: 2000,
        essential: true,
      });
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
