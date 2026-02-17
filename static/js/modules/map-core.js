/**
 * MapCore - Centralized Map Initialization Module
 *
 * This module is the single entry point for map creation and initialization.
 * It consolidates token handling, map creation, and provides a deterministic
 * ready state without polling defaults.
 *
 * Usage:
 *   import mapCore from './map-core.js';
 *   await mapCore.initialize();
 *   // or
 *   mapCore.onReady((map) => { ... });
 */

/* global mapboxgl */

import { CONFIG } from "./core/config.js";
import state from "./core/store.js";
import { waitForMapboxToken } from "./mapbox-token.js";
import loadingManager from "./ui/loading-manager.js";
import notificationManager from "./ui/notifications.js";
import { utils } from "./utils.js";

// Internal state
let initializationPromise = null;
let initializationError = null;
const readyCallbacks = [];
let styleChangeQueue = Promise.resolve();
let activeStyleType = null;

// Serialized style-change handler registry
// Handlers run sequentially by priority (lower number = runs first) after a style change.
const styleChangeHandlers = [];
let styleChangeInProgress = false;

/**
 * MapCore singleton - manages map lifecycle
 */
const mapCore = {
  _telemetryPatched: false,
  _initErrorRendered: false,

  /**
   * Check if map is ready for use
   * @returns {boolean}
   */
  isReady() {
    return state.map !== null && state.mapInitialized === true;
  },

  /**
   * Whether a style change is currently in progress (layers being restored).
   * Callers (e.g. LiveTripTracker.updateTrip) should defer work while true.
   * @returns {boolean}
   */
  isStyleChangeInProgress() {
    return styleChangeInProgress;
  },

  /**
   * Register an async handler that runs after every map style change.
   * Handlers run sequentially in priority order (lower number first).
   * @param {number} priority - Execution order (1 = first, 2 = second, etc.)
   * @param {Function} handler - Async function (styleType) => Promise<void>
   * @returns {Object} Reference for unregistering
   */
  registerStyleChangeHandler(priority, handler) {
    const entry = { priority, handler };
    styleChangeHandlers.push(entry);
    styleChangeHandlers.sort((a, b) => a.priority - b.priority);
    return entry;
  },

  /**
   * Remove a previously registered style-change handler.
   * @param {Object} ref - The reference returned by registerStyleChangeHandler
   */
  unregisterStyleChangeHandler(ref) {
    const idx = styleChangeHandlers.indexOf(ref);
    if (idx !== -1) {
      styleChangeHandlers.splice(idx, 1);
    }
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
    const initResult = await initializationPromise;
    return initResult;
  },

  /**
   * Internal initialization logic
   * @private
   */
  async _doInitialize(options = {}) {
    try {
      this._clearInitError();
      loadingManager?.show("Initializing map...");

      // Verify DOM elements exist
      const mapElement = utils.getElement("map");
      const mapCanvas = utils.getElement("map-canvas");

      if (!mapElement || !mapCanvas) {
        throw new Error("Map container elements not found");
      }

      await this._waitForMapboxGL();

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

      this._disableTelemetry();

      // Determine theme and style
      const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
      const storedMapType = utils.getStorage(CONFIG.STORAGE_KEYS.mapType);
      const mapType = storedMapType || theme;
      const mapStyle = CONFIG.MAP.styles[mapType] || CONFIG.MAP.styles[theme];
      activeStyleType = mapType;

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
      window.map = map; // Classic support

      loadingManager?.updateMessage("Adding controls...");

      // Add navigation control
      map.addControl(new mapboxgl.NavigationControl(), "top-right");

      // Wait for map to fully load
      await this._waitForMapLoad(map);

      // Mark as initialized
      state.mapInitialized = true;
      state.metrics.mapLoadTime = Date.now() - state.metrics.loadStartTime;

      this._clearInitError();
      loadingManager?.hide();

      // Dispatch event for other modules
      document.dispatchEvent(
        new CustomEvent("mapInitialized", {
          detail: { map },
        })
      );

      // Invoke ready callbacks
      this._invokeReadyCallbacks(map);

      return true;
    } catch (error) {
      console.error("MapCore initialization error:", error);
      initializationError = error;
      loadingManager?.hide();

      this._showInitError(error?.message || "Unknown error");
      notificationManager.show(`Map initialization failed: ${error.message}`, "danger");

      return false;
    }
  },

  /**
   * Wait for Mapbox GL JS to be available
   * @private
   */
  _waitForMapboxGL(timeoutMs = 10000) {
    if (typeof mapboxgl !== "undefined") {
      return Promise.resolve(true);
    }

    if (typeof document === "undefined") {
      return Promise.reject(new Error("Mapbox GL JS not loaded"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let intervalId = null;
      let timeoutId = null;
      let scriptEl = null;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (intervalId) {
          clearInterval(intervalId);
        }
        document.removeEventListener("es:mapbox-gl-ready", checkReady);
        if (scriptEl) {
          scriptEl.removeEventListener("load", checkReady);
          scriptEl.removeEventListener("error", handleError);
        }
      };

      const checkReady = () => {
        if (typeof mapboxgl !== "undefined") {
          cleanup();
          resolve(true);
        }
      };

      const handleError = () => {
        cleanup();
        reject(new Error("Mapbox GL JS failed to load"));
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error("Mapbox GL JS not loaded"));
      }, timeoutMs);

      scriptEl = document.querySelector('script[src*="mapbox-gl.js"]');
      if (scriptEl) {
        scriptEl.addEventListener("load", checkReady, { once: true });
        scriptEl.addEventListener("error", handleError, { once: true });
      }

      document.addEventListener("es:mapbox-gl-ready", checkReady);
      intervalId = setInterval(checkReady, 50);
    });
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
   * Disable Mapbox telemetry and event reporting when available
   * @private
   */
  _disableTelemetry() {
    const telemetryApiAvailable = typeof mapboxgl?.setTelemetryEnabled === "function";
    if (telemetryApiAvailable) {
      mapboxgl.setTelemetryEnabled(false);
    }

    if (typeof mapboxgl?.config === "object") {
      this._safeSetMapboxConfig(mapboxgl.config, "REPORT_MAP_LOAD_TIMES", false);
      this._safeSetMapboxConfig(mapboxgl.config, "COLLECT_RESOURCE_TIMING", false);
      this._safeSetMapboxConfig(mapboxgl.config, "EVENTS_URL", null);
    }

    if (!telemetryApiAvailable) {
      this._patchTelemetryRequests();
    }
  },

  /**
   * Safely update Mapbox config fields without throwing on read-only props
   * @private
   */
  _safeSetMapboxConfig(config, key, value) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(config, key);
      if (descriptor) {
        if (descriptor.writable || typeof descriptor.set === "function") {
          config[key] = value;
        }
        return;
      }

      if (Object.isExtensible(config)) {
        config[key] = value;
      }
    } catch {
      // Ignore config mutation errors
    }
  },

  /**
   * Patch telemetry requests when Mapbox telemetry API is unavailable
   * @private
   */
  _patchTelemetryRequests() {
    if (this._telemetryPatched) {
      return;
    }

    const telemetryHost = "events.mapbox.com";
    const baseUrl =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost";
    let patched = false;

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const originalSendBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        try {
          const parsed = new URL(url, baseUrl);
          if (parsed.hostname === telemetryHost) {
            return true;
          }
        } catch {
          // Ignore URL parsing errors
        }
        return originalSendBeacon(url, data);
      };
      patched = true;
    }

    if (typeof window !== "undefined" && typeof window.fetch === "function") {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input?.url;
        if (typeof url === "string") {
          try {
            const parsed = new URL(url, baseUrl);
            if (parsed.hostname === telemetryHost) {
              return Promise.resolve(
                new Response(null, { status: 204, statusText: "No Content" })
              );
            }
          } catch {
            // Ignore URL parsing errors
          }
        }
        return originalFetch(input, init);
      };
      patched = true;
    }

    if (patched) {
      this._telemetryPatched = true;
    }
  },

  /**
   * Create transform request function
   * @private
   */
  _createTransformRequest() {
    return (url) => ({ url });
  },

  /**
   * Render an in-map error overlay so failures are visible even when toast UI is hidden.
   * @private
   */
  _showInitError(message) {
    const mapElement = utils.getElement("map");
    if (!mapElement) {
      return;
    }

    let overlay = document.getElementById("map-init-error");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "map-init-error";
      overlay.className = "map-init-error";

      const card = document.createElement("div");
      card.className = "map-init-error-card";

      const title = document.createElement("h2");
      title.textContent = "Map failed to load";

      const body = document.createElement("p");
      body.id = "map-init-error-message";

      card.appendChild(title);
      card.appendChild(body);
      overlay.appendChild(card);
      mapElement.appendChild(overlay);
    }

    const messageEl = overlay.querySelector("#map-init-error-message");
    if (messageEl) {
      messageEl.textContent = message || "Unknown error.";
    }
  },

  /**
   * Remove init error overlay (if present).
   * @private
   */
  _clearInitError() {
    const overlay = document.getElementById("map-init-error");
    if (overlay) {
      overlay.remove();
    }
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
  async waitForStyleLoad({ timeoutMs = 15000 } = {}) {
    const { map } = state;
    if (!map) {
      throw new Error("Map not initialized");
    }

    if (map.isStyleLoaded()) {
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        map.off("style.load", onStyleLoad);
      };

      const onStyleLoad = () => {
        cleanup();
        resolve();
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        if (map.isStyleLoaded()) {
          resolve();
          return;
        }
        reject(new Error(`Timed out waiting for map style load (${timeoutMs}ms)`));
      }, timeoutMs);

      map.on("style.load", onStyleLoad);
    });
  },

  /**
   * Change map style and wait for it to load
   * @param {string} styleType - Style type (dark, light, satellite, streets)
   * @returns {Promise<void>}
   */
  async _setStyleInternal(styleType, options = {}) {
    const { map } = state;
    if (!map || !state.mapInitialized) {
      throw new Error("Map not initialized");
    }

    const { persistPreference = true } = options;
    const requestedStyleType =
      typeof styleType === "string" && styleType in CONFIG.MAP.styles
        ? styleType
        : "dark";

    if (activeStyleType === requestedStyleType && map.isStyleLoaded()) {
      return;
    }

    const styleUrl =
      CONFIG.MAP.styles[requestedStyleType] ||
      `mapbox://styles/mapbox/${requestedStyleType}-v11`;

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
    if (persistPreference) {
      utils.setStorage(CONFIG.STORAGE_KEYS.mapType, requestedStyleType);
    }

    activeStyleType = requestedStyleType;

    // Run registered style-change handlers sequentially by priority
    styleChangeInProgress = true;
    try {
      for (const entry of [...styleChangeHandlers]) {
        try {
          await entry.handler(requestedStyleType);
        } catch (err) {
          console.warn("Style change handler error:", err);
        }
      }
    } finally {
      styleChangeInProgress = false;
    }

    // Dispatch notification events (non-critical listeners only)
    document.dispatchEvent(
      new CustomEvent("mapStyleLoaded", { detail: { styleType: requestedStyleType } })
    );
    document.dispatchEvent(
      new CustomEvent("mapStyleChanged", { detail: { styleType: requestedStyleType } })
    );
  },

  /**
   * Change map style and wait for it to load
   * Calls are serialized to avoid overlapping style transitions.
   * @param {string} styleType - Style type (dark, light, satellite, streets)
   * @param {{persistPreference?: boolean}} options - Style change options
   * @returns {Promise<void>}
   */
  setStyle(styleType, options = {}) {
    styleChangeQueue = styleChangeQueue
      .catch(() => {})
      .then(() => this._setStyleInternal(styleType, options));

    return styleChangeQueue;
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
    styleChangeQueue = Promise.resolve();
    activeStyleType = null;
    styleChangeInProgress = false;
    styleChangeHandlers.length = 0;
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
