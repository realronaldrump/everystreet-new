/**
 * Unified Application State Management
 * Single source of truth for all application state
 */
import { CONFIG } from "./config.js";

class AppState {
  constructor() {
    // Core map state
    this.map = null;
    this.mapInitialized = false;
    this.mapLayers = JSON.parse(JSON.stringify(CONFIG.LAYER_DEFAULTS));

    // Map settings
    this.mapSettings = {
      highlightRecentTrips: true,
      autoRefresh: false,
      clusterTrips: false,
    };

    // Selection state
    this.selectedTripId = null;
    this.selectedTripLayer = null;
    this.selectedLocationId = null;

    // Live tracking
    this.liveTracker = null;

    // Street loading flags
    this.undrivenStreetsLoaded = false;
    this.drivenStreetsLoaded = false;
    this.allStreetsLoaded = false;

    // Caching
    this.dom = new Map();
    this.apiCache = new Map();
    this.abortControllers = new Map();
    this.loadingStates = new Map();
    this.pendingRequests = new Set();
    this.layerLoadPromises = new Map();

    // UI state
    this.ui = {
      theme: null,
      isMobile:
        typeof window !== "undefined" && window.innerWidth < CONFIG.UI.mobileBreakpoint,
      reducedMotion:
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      controlsMinimized: false,
      filtersOpen: false,
      activeModals: new Set(),
    };

    // Performance metrics
    this.metrics = {
      loadStartTime: Date.now(),
      mapLoadTime: null,
      dataLoadTime: null,
      renderTime: null,
    };

    // Load persisted UI state
    this._loadPersistedState();
  }

  _loadPersistedState() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.uiState);
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(this.ui, parsed);
      }
    } catch {
      // Ignore storage errors
    }
  }

  saveUIState() {
    try {
      const persistable = {
        controlsMinimized: this.ui.controlsMinimized,
        filtersOpen: this.ui.filtersOpen,
      };
      localStorage.setItem(CONFIG.STORAGE_KEYS.uiState, JSON.stringify(persistable));
    } catch (e) {
      console.warn("Failed to save UI state:", e);
    }
  }

  // DOM element caching
  getElement(selector) {
    if (this.dom.has(selector)) {
      return this.dom.get(selector);
    }
    const el = document.querySelector(
      selector.startsWith("#") || selector.includes(" ") || selector.startsWith(".")
        ? selector
        : `#${selector}`
    );
    if (el) {
      this.dom.set(selector, el);
    }
    return el;
  }

  /**
   * Get all elements matching selector (cached)
   * @param {string} selector - CSS selector
   * @returns {NodeList} Matching elements
   */
  getAllElements(selector) {
    const key = `all_${selector}`;
    if (this.dom.has(key)) {
      return this.dom.get(key);
    }
    const nodes = document.querySelectorAll(selector);
    this.dom.set(key, nodes);
    return nodes;
  }

  clearElementCache() {
    this.dom.clear();
  }

  // Request management with AbortController
  createAbortController(key) {
    // Cancel any existing request with the same key
    this.cancelRequest(key);
    const controller = new AbortController();
    this.abortControllers.set(key, controller);
    return controller;
  }

  cancelRequest(key) {
    const existing = this.abortControllers.get(key);
    if (existing) {
      try {
        existing.abort();
      } catch (e) {
        console.warn("Error aborting request:", e);
      }
      this.abortControllers.delete(key);
    }
  }

  cancelAllRequests() {
    this.abortControllers.forEach((controller) => {
      try {
        controller.abort();
      } catch (e) {
        console.warn("Error aborting request:", e);
      }
    });
    this.abortControllers.clear();
    this.pendingRequests.clear();
  }

  trackRequest(url) {
    this.pendingRequests.add(url);
  }

  completeRequest(url) {
    this.pendingRequests.delete(url);
  }

  hasPendingRequests() {
    return this.pendingRequests.size > 0;
  }

  // Reset state
  reset() {
    this.cancelAllRequests();

    if (this.map) {
      this.map.off();
      this.map.remove();
      this.map = null;
    }

    this.mapInitialized = false;
    this.selectedTripId = null;
    this.selectedTripLayer = null;
    this.undrivenStreetsLoaded = false;
    this.drivenStreetsLoaded = false;
    this.allStreetsLoaded = false;
    this.dom.clear();
    this.apiCache.clear();
    this.loadingStates.clear();
    this.pendingRequests.clear();
    this.layerLoadPromises.clear();
  }

  // Reset street layer cache when location changes
  resetStreetCache() {
    this.undrivenStreetsLoaded = false;
    this.drivenStreetsLoaded = false;
    this.allStreetsLoaded = false;
    this.mapLayers.undrivenStreets.layer = null;
    this.mapLayers.drivenStreets.layer = null;
    this.mapLayers.allStreets.layer = null;
  }
}

export const state = new AppState();
export default state;
