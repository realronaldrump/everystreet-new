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


import { CONFIG } from "./core/config.js";
import store from "./core/store.js";
import mapCore from "./map-core.js";
import googleMapCore from "./maps/google_map.js";
import { createCoordinateBounds } from "./utils/bounds.js";
import { utils } from "./utils.js";

// Debounced view state saver
let saveViewStateDebounced = null;

const createBounds = () => {
  if (typeof mapboxgl !== "undefined" && typeof mapboxgl.LngLatBounds === "function") {
    return createCoordinateBounds(new mapboxgl.LngLatBounds());
  }

  return createCoordinateBounds();
};

const forEachGeometryCoordinate = (geometry, callback) => {
  if (!geometry || typeof callback !== "function") {
    return;
  }
  const { type, coordinates } = geometry;
  if (type === "Point" && Array.isArray(coordinates)) {
    callback(coordinates);
    return;
  }
  if (type === "LineString" && Array.isArray(coordinates)) {
    coordinates.forEach(callback);
    return;
  }
  if (type === "MultiLineString" && Array.isArray(coordinates)) {
    coordinates.forEach((line) => {
      if (Array.isArray(line)) {
        line.forEach(callback);
      }
    });
  }
};

const mapManager = {
  // Track if view state listener is bound
  _viewListenerBound: false,

  /**
   * Initialize the map using MapCore or GoogleMapCore and set up view state management
   * @returns {Promise<boolean>}
   */
  async initialize() {
    let success = false;
    const mapProvider = String(window.MAP_PROVIDER || "").toLowerCase();
    if (mapProvider === "google") {
      success = await googleMapCore.initialize();
    } else {
      success = await mapCore.initialize();
    }

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
    if (Date.now() - Number(store._lastTripMapPickTs || 0) < 150) {
      return;
    }

    const queryLayers = ["trips-hitbox", "matchedTrips-hitbox"].filter((layerId) =>
      store.map.getLayer(layerId)
    );

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
   * Redraw the selected trip. Throttled: selection can change on every click.
   */
  refreshTripStyles: utils.throttle(() => {
    if (!store.map || !store.mapInitialized) {
      return;
    }
    import("./trip-map-renderer.js")
      .then((module) => module.default.refreshSelection())
      .catch(() => {});
  }, CONFIG.MAP.throttleDelay),

  /**
   * Fit the map to visible trip data only, or restore the configured empty view.
   * @param {boolean} animate - Whether to animate the transition
   * @returns {Promise<boolean>} Whether trip bounds were available
   */
  async fitBounds(animate = true) {
    if (!store.map || !store.mapInitialized) {
      return false;
    }

    const bounds = createBounds();
    let hasFeatures = false;
    const tripMapRenderer = (await import("./trip-map-renderer.js")).default;

    ["trips", "matchedTrips"].forEach((layerName) => {
      if (!store.mapLayers[layerName]?.visible) {
        return;
      }
      const bbox = tripMapRenderer.getBundleBounds(layerName);
      if (!bbox) {
        return;
      }
      bounds.extend([bbox[0], bbox[1]]);
      bounds.extend([bbox[2], bbox[3]]);
      hasFeatures = true;
    });

    if (hasFeatures && !bounds.isEmpty()) {
      await store.map.fitBounds(bounds.toValue(), {
        padding: 50,
        maxZoom: 15,
        duration: animate ? 1000 : 0,
      });
      return true;
    }

    store.map.jumpTo({
      center: CONFIG.MAP.defaultCenter,
      zoom: CONFIG.MAP.defaultZoom,
    });
    return false;
  },

  /**
   * Zoom to a specific trip by ID
   * @param {string|number} tripId - The trip ID to zoom to
   */
  async zoomToTrip(tripId) {
    const tripMapRenderer = (await import("./trip-map-renderer.js")).default;
    const selectedLayerNames = ["trips", "matchedTrips"];
    for (const layerName of selectedLayerNames) {
      const bbox = tripMapRenderer.getTripBounds(layerName, tripId);
      if (!bbox) {
        continue;
      }
      const bounds = createBounds();
      bounds.extend([bbox[0], bbox[1]]);
      bounds.extend([bbox[2], bbox[3]]);
      if (!bounds.isEmpty()) {
        store.map.fitBounds(bounds.toValue(), {
          padding: 50,
          maxZoom: 15,
          duration: 2000,
        });
        store.selectedTripId = tripId;
        store.selectedTripLayer = layerName;
        this.refreshTripStyles();
      }
      return;
    }

    if (!store.map || !store.mapLayers.trips?.layer?.features) {
      return;
    }

    // Wait for features to be loaded if they aren't yet
    if (store.mapLayers.trips.layer.features.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const { features } = store.mapLayers.trips.layer;
    const tripFeature = features.find((f) => {
      const fId =
        f.properties?.transactionId || f.properties?.id || f.properties?.tripId || f.id;
      return String(fId) === String(tripId);
    });

    if (!tripFeature?.geometry) {
      console.warn(`Trip ${tripId} not found in loaded features`);
      return;
    }

    const bounds = createBounds();
    forEachGeometryCoordinate(tripFeature.geometry, (coord) => bounds.extend(coord));

    if (!bounds.isEmpty()) {
      store.map.fitBounds(bounds.toValue(), {
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
   * Clean up event listeners
   */
  cleanup() {
    if (store.map && saveViewStateDebounced) {
      store.map.off("moveend", saveViewStateDebounced);
    }
  },
};

export default mapManager;
