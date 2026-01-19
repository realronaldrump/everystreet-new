/**
 * MapCore - Centralized Map Initialization Module
 *
 * This module is the single entry point for map creation and initialization.
 * It consolidates token handling, map creation, and provides a deterministic
 * ready state without polling fallbacks.
 *
 * Usage:
 *   import mapCore from './map-core.js';
 *   await mapCore.initialize();
 *   // or
 *   mapCore.onReady((map) => { ... });
 */

/* global mapboxgl */

import { CONFIG } from "./config.js";
import { waitForMapboxToken } from "./mapbox-token.js";
import state from "./state.js";
import { utils } from "./utils.js";

// Internal state
let initializationPromise = null;
let initializationError = null;
const readyCallbacks = [];

/**
 * MapCore singleton - manages map lifecycle
 */
const mapCore = {
  /**
   * Check if map is ready for use
   * @returns {boolean}
   */
  isReady() {
    return state.map !== null && state.mapInitialized === true;
  },

  /**
   * Get the map instance (may be null if not initialized)
   * @returns {mapboxgl.Map|null}
   */
  getMap() {
    return state.map;
  },

  /**
   * Register a callback to be called when map is ready.
   * If map is already ready, callback is invoked immediately.
   * @param {Function} callback - Function to call with map instance
   */
  onReady(callback) {
    if (typeof callback !== "function") {
      return;
    }

    if (this.isReady()) {
      try {
        callback(state.map);
      } catch (err) {
        console.error("MapCore onReady callback error:", err);
      }
    } else {
      readyCallbacks.push(callback);
    }
  },

  /**
   * Initialize the map. Safe to call multiple times - subsequent calls
   * return the same promise.
   * @param {Object} options - Optional configuration overrides
   * @returns {Promise<boolean>} - Resolves true on success, false on failure
   */
  async initialize(options = {}) {
    // Return existing promise if already initializing/initialized
    if (initializationPromise) {
      return initializationPromise;
    }

    // Return immediately if already initialized
    if (this.isReady()) {
      return Promise.resolve(true);
    }

    // Return error if previous initialization failed
    if (initializationError) {
      return Promise.resolve(false);
    }

    initializationPromise = this._doInitialize(options);
    return initializationPromise;
  },

  /**
   * Internal initialization logic
   * @private
   */
  async _doInitialize(options = {}) {
    const { loadingManager } = window;

    try {
      loadingManager?.show("Initializing map...");

      // Verify DOM elements exist
      const mapElement = utils.getElement("map");
      const mapCanvas = utils.getElement("map-canvas");

      if (!mapElement || !mapCanvas) {
        throw new Error("Map container elements not found");
      }

      // Prevent double initialization
      if (state.map) {
        loadingManager?.hide();
        return true;
      }

      // Get Mapbox token
      loadingManager?.updateMessage("Loading map resources...");
      const token = await waitForMapboxToken({ timeoutMs: 5000 });

      if (!token) {
        throw new Error("Mapbox access token not available");
      }

      mapboxgl.accessToken = token;

      // Check WebGL support
      if (!mapboxgl.supported()) {
        mapElement.innerHTML =
          '<div class="webgl-unsupported-message p-4 text-center">' +
          "WebGL is not supported by your browser. Please use a modern browser.</div>";
        throw new Error("WebGL not supported");
      }

      loadingManager?.updateMessage("Configuring map...");

      // Disable telemetry for performance
      if (typeof mapboxgl.config === "object") {
        mapboxgl.config.REPORT_MAP_LOAD_TIMES = false;
        mapboxgl.config.COLLECT_RESOURCE_TIMING = false;
      }

      // Determine theme and style
      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";
      const storedMapType = utils.getStorage(CONFIG.STORAGE_KEYS.mapType);
      const mapType = storedMapType || theme;
      const mapStyle = CONFIG.MAP.styles[mapType] || CONFIG.MAP.styles[theme];

      // Determine initial view (URL params > saved state > defaults)
      const initialView = this._getInitialView(options);

      // Clear container to prevent Mapbox warning
      if (mapCanvas.hasChildNodes()) {
        mapCanvas.innerHTML = "";
      }

      loadingManager?.updateMessage("Creating map instance...");

      // Create the map instance
      const map = new mapboxgl.Map({
        container: "map-canvas",
        style: mapStyle,
        center: initialView.center,
        zoom: initialView.zoom,
        maxZoom: CONFIG.MAP.maxZoom,
        attributionControl: false,
        logoPosition: "bottom-right",
        ...CONFIG.MAP.performanceOptions,
        transformRequest: this._createTransformRequest(),
      });

      // Store references
      state.map = map;
      window.map = map; // Legacy support

      loadingManager?.updateMessage("Adding controls...");

      // Add navigation control
      map.addControl(new mapboxgl.NavigationControl(), "top-right");

      // Wait for map to fully load
      await this._waitForMapLoad(map);

      // Mark as initialized
      state.mapInitialized = true;
      state.metrics.mapLoadTime = Date.now() - state.metrics.loadStartTime;

      loadingManager?.hide();

      // Dispatch event for other modules
      document.dispatchEvent(
        new CustomEvent("mapInitialized", {
          detail: { map },
        }),
      );

      // Invoke ready callbacks
      this._invokeReadyCallbacks(map);

      return true;
    } catch (error) {
      console.error("MapCore initialization error:", error);
      initializationError = error;
      loadingManager?.hide();

      window.notificationManager?.show(
        `Map initialization failed: ${error.message}`,
        "danger",
      );

      return false;
    }
  },

  /**
   * Determine initial map view from URL, storage, or defaults
   * @private
   */
  _getInitialView(options) {
    // Check URL parameters first
    const urlParams = new URLSearchParams(window.location.search);
    const latParam = parseFloat(urlParams.get("lat"));
    const lngParam = parseFloat(urlParams.get("lng"));
    const zoomParam = parseFloat(urlParams.get("zoom"));

    if (!Number.isNaN(latParam) && !Number.isNaN(lngParam)) {
      return {
        center: [lngParam, latParam],
        zoom: !Number.isNaN(zoomParam) ? zoomParam : CONFIG.MAP.defaultZoom,
      };
    }

    // Check saved view state
    const savedView = utils.getStorage(CONFIG.STORAGE_KEYS.mapView);
    if (savedView?.center && savedView?.zoom) {
      return savedView;
    }

    // Use options or defaults
    return {
      center: options.center || CONFIG.MAP.defaultCenter,
      zoom: options.zoom || CONFIG.MAP.defaultZoom,
    };
  },

  /**
   * Create transform request function to filter telemetry
   * @private
   */
  _createTransformRequest() {
    return (url) => {
      if (typeof url === "string") {
        try {
          const parsed = new URL(url, window.location.origin);
          if (parsed.hostname === "events.mapbox.com") {
            return { url: undefined };
          }
        } catch {
          // Ignore parse errors
        }
      }
      return { url };
    };
  },

  /**
   * Wait for map load event with timeout
   * @private
   */
  _waitForMapLoad(map, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
      };

      const onLoad = () => {
        cleanup();
        resolve();
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        // Check if style is loaded anyway
        if (map.isStyleLoaded()) {
          resolve();
        } else {
          reject(new Error("Map load timeout"));
        }
      }, timeoutMs);

      if (map.isStyleLoaded()) {
        cleanup();
        resolve();
      } else {
        map.once("load", onLoad);
      }
    });
  },

  /**
   * Invoke all registered ready callbacks
   * @private
   */
  _invokeReadyCallbacks(map) {
    while (readyCallbacks.length > 0) {
      const callback = readyCallbacks.shift();
      try {
        callback(map);
      } catch (err) {
        console.error("MapCore ready callback error:", err);
      }
    }
  },

  /**
   * Wait for map style to be fully loaded
   * Useful after style changes
   * @returns {Promise<void>}
   */
  async waitForStyleLoad() {
    const { map } = state;
    if (!map) {
      throw new Error("Map not initialized");
    }

    if (map.isStyleLoaded()) {
      return;
    }

    return new Promise((resolve) => {
      const onStyleData = () => {
        if (map.isStyleLoaded()) {
          map.off("styledata", onStyleData);
          resolve();
        }
      };

      map.on("styledata", onStyleData);

      // Fallback timeout
      setTimeout(() => {
        map.off("styledata", onStyleData);
        resolve();
      }, 5000);
    });
  },

  /**
   * Change map style and wait for it to load
   * @param {string} styleType - Style type (dark, light, satellite, streets)
   * @returns {Promise<void>}
   */
  async setStyle(styleType) {
    const { map } = state;
    if (!map || !state.mapInitialized) {
      throw new Error("Map not initialized");
    }

    const styleUrl =
      CONFIG.MAP.styles[styleType] || `mapbox://styles/mapbox/${styleType}-v11`;

    // Save current view
    const currentView = {
      center: map.getCenter(),
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };

    // Set new style
    map.setStyle(styleUrl);

    // Wait for style to load
    await this.waitForStyleLoad();

    // Restore view
    map.jumpTo(currentView);

    // Save preference
    utils.setStorage(CONFIG.STORAGE_KEYS.mapType, styleType);

    // Dispatch event for layer restoration
    document.dispatchEvent(
      new CustomEvent("mapStyleChanged", { detail: { styleType } }),
    );
  },

  /**
   * Destroy the map instance and clean up
   */
  destroy() {
    if (state.map) {
      try {
        state.map.remove();
      } catch (err) {
        console.warn("Error removing map:", err);
      }
      state.map = null;
      window.map = null;
    }

    state.mapInitialized = false;
    initializationPromise = null;
    initializationError = null;
    readyCallbacks.length = 0;
  },

  /**
   * Reset initialization state (for testing or re-initialization)
   */
  reset() {
    this.destroy();
    state.reset();
  },
};

export default mapCore;
