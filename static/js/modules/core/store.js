import { CONFIG } from "./config.js";
import { getExplicitMapViewFromUrl } from "./url-state.js";

const STORAGE_KEY = "es:state";
const VERSION = 1;

const URL_PARAM_MAP = {
  start: "filters.startDate",
  end: "filters.endDate",
  start_date: "filters.startDate",
  end_date: "filters.endDate",
  vehicle: "filters.vehicle",
};

const DEFAULT_STATE = {
  version: VERSION,
  filters: {
    startDate: null,
    endDate: null,
    vehicle: null,
  },
  map: {
    view: null,
    style: null,
    selectedLocation: null,
    streetViewMode: null,
  },
  layers: {
    visibility: {},
    settings: {},
  },
  ui: {
    controlsMinimized: false,
    filtersOpen: false,
    lastFilterPreset: null,
  },
};

const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

const getByPath = (obj, path) => {
  if (!path) {
    return undefined;
  }
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj);
};

const setByPath = (obj, path, value) => {
  const parts = path.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
};

const parseJson = (value) => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

class ESStore {
  constructor() {
    // Map + data state
    this.map = null;
    this.mapInitialized = false;
    this.mapLayers = deepClone(CONFIG.LAYER_DEFAULTS);

    this.mapSettings = {
      highlightRecentTrips: true,
      autoRefresh: false,
      clusterTrips: false,
    };

    this.selectedTripId = null;
    this.selectedTripLayer = null;
    this.selectedLocationId = null;

    // Last metricsUpdated payload, for listeners created after the initial load.
    this.lastMetricsDetail = null;

    this.liveTracker = null;

    this.undrivenStreetsLoaded = false;
    this.drivenStreetsLoaded = false;
    this.allStreetsLoaded = false;

    this.dom = new Map();
    this.abortControllers = new Map();
    this.loadingStates = new Map();
    this.pendingRequests = new Set();
    this.layerLoadPromises = new Map();
    // In-memory API response cache used by utils.fetchWithRetry().
    this.apiCache = new Map();

    // UI runtime state
    this.ui = {
      theme: null,
      isMobile:
        typeof window !== "undefined" && window.innerWidth < CONFIG.UI.mobileBreakpoint,
      reducedMotion:
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      controlsMinimized: false,
      filtersOpen: false,
      lastFilterPreset: null,
      initialized: false,
      activeModals: new Set(),
    };

    this.metrics = {
      loadStartTime: Date.now(),
      mapLoadTime: null,
      dataLoadTime: null,
      renderTime: null,
    };

    // SPA store state
    this.state = deepClone(DEFAULT_STATE);
    this.initialized = false;
    this.appReady = false;

    this._loadPersistedUIState();
  }

  _loadPersistedUIState() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.uiState);
      if (saved) {
        const parsed = JSON.parse(saved);
        this._applyUIState(parsed);
      }
    } catch {
      // Ignore storage errors
    }
  }

  _applyUIState(partial = {}) {
    const next = {
      controlsMinimized: partial.controlsMinimized ?? this.state.ui.controlsMinimized,
      filtersOpen: partial.filtersOpen ?? this.state.ui.filtersOpen,
      lastFilterPreset: partial.lastFilterPreset ?? this.state.ui.lastFilterPreset,
    };
    this.state.ui = { ...this.state.ui, ...next };
    this.ui.controlsMinimized = next.controlsMinimized;
    this.ui.filtersOpen = next.filtersOpen;
    this.ui.lastFilterPreset = next.lastFilterPreset;
  }

  saveUIState() {
    try {
      const persistable = {
        controlsMinimized: this.ui.controlsMinimized,
        filtersOpen: this.ui.filtersOpen,
        lastFilterPreset: this.ui.lastFilterPreset,
      };
      localStorage.setItem(CONFIG.STORAGE_KEYS.uiState, JSON.stringify(persistable));
    } catch (e) {
      console.warn("Failed to save UI state:", e);
    }
  }

  // DOM element caching with stale-reference validation
  getElement(selector) {
    if (this.dom.has(selector)) {
      const cached = this.dom.get(selector);
      // Validate the cached element is still connected to the DOM
      if (cached?.isConnected) {
        return cached;
      }
      this.dom.delete(selector);
    }
    const element = document.querySelector(
      selector.startsWith("#") || selector.includes(" ") || selector.startsWith(".")
        ? selector
        : `#${selector}`
    );

    if (element) {
      this.dom.set(selector, element);
    }
    return element;
  }

  getAllElements(selector) {
    // Don't cache NodeLists - they become stale after SPA navigation
    return document.querySelectorAll(selector);
  }

  clearElementCache() {
    this.dom.clear();
  }

  // Request management with AbortController
  createAbortController(key) {
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
    this.apiCache.clear();
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
    this.loadingStates.clear();
    this.pendingRequests.clear();
    this.layerLoadPromises.clear();
  }

  resetStreetCache() {
    this.undrivenStreetsLoaded = false;
    this.drivenStreetsLoaded = false;
    this.allStreetsLoaded = false;
    this.mapLayers.undrivenStreets.layer = null;
    this.mapLayers.drivenStreets.layer = null;
    this.mapLayers.allStreets.layer = null;
  }

  // SPA store methods
  init(url = window.location.href) {
    if (this.initialized) {
      return;
    }

    const saved = parseJson(sessionStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      this.state = { ...deepClone(DEFAULT_STATE), ...saved };
    } else {
      this.state = deepClone(DEFAULT_STATE);
    }

    this._applyUIState(this.state.ui || {});

    this.applyUrlParams(url, { emit: false });
    this._persist();
    this.initialized = true;
  }

  _persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.warn("Failed to persist session store:", e);
    }
  }

  _emit(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get(path) {
    return getByPath(this.state, path);
  }

  set(path, value) {
    setByPath(this.state, path, value);
    if (path?.startsWith("ui.")) {
      this._applyUIState(this.state.ui || {});
    }
    this._persist();
  }

  updateFilters(filters, options = {}) {
    const nextFilters = { ...this.state.filters, ...filters };
    this.state.filters = nextFilters;
    if (options.persist !== false) {
      this._persist();
    }
    if (options.syncUrl !== false) {
      this.syncUrl({ push: Boolean(options.push), replace: !options.push });
    }
    if (options.emit !== false) {
      this._emit("es:filters-change", {
        ...nextFilters,
        source: options.source,
      });
      this._emit("filtersApplied", { ...nextFilters });
    }
  }

  updateMapView(view, options = {}) {
    this.state.map.view = view;
    if (options.persist !== false) {
      this._persist();
    }
    if (options.emit !== false) {
      this._emit("es:map-view-change", { view, source: options.source });
    }
  }

  updateLayerVisibility(visibility, options = {}) {
    this.state.layers.visibility = { ...visibility };
    if (options.persist !== false) {
      this._persist();
    }
    if (options.syncUrl !== false) {
      this.syncUrl({ replace: true });
    }
    if (options.emit !== false) {
      this._emit("es:layers-change", { visibility, source: options.source });
    }
  }

  applyUrlParams(url, options = {}) {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(url, window.location.origin);
    } catch {
      return;
    }

    const params = parsedUrl.searchParams;
    let filtersChanged = false;
    Object.entries(URL_PARAM_MAP).forEach(([param, path]) => {
      if (!params.has(param)) {
        return;
      }
      const value = params.get(param);
      const current = getByPath(this.state, path);
      if (value !== null && value !== current) {
        setByPath(this.state, path, value);
        filtersChanged = filtersChanged || path.startsWith("filters");
      }
    });

    const explicitMapView = getExplicitMapViewFromUrl(parsedUrl.toString());
    const hasMapParams = explicitMapView !== null;
    if (explicitMapView) {
      this.state.map.view = explicitMapView;
    }

    if (params.has("layers")) {
      const list = params
        .get("layers")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const visibility = {};
      list.forEach((name) => {
        visibility[name] = true;
      });
      this.state.layers.visibility = visibility;
    }

    if (options.persist !== false) {
      this._persist();
    }

    if (filtersChanged && options.emit !== false) {
      this._emit("es:filters-change", {
        ...this.state.filters,
        source: options.source || "url",
      });
      this._emit("filtersApplied", { ...this.state.filters });
    }

    if (hasMapParams && options.emit !== false) {
      this._emit("es:map-view-change", {
        view: this.state.map.view,
        source: options.source || "url",
      });
    }
  }

  syncUrl({ push = false, replace: _replace = false } = {}) {
    if (!window.history?.replaceState) {
      return;
    }

    const url = new URL(window.location.href);

    const { startDate, endDate, vehicle } = this.state.filters;
    if (startDate) {
      url.searchParams.set("start", startDate);
    } else {
      url.searchParams.delete("start");
    }
    if (endDate) {
      url.searchParams.set("end", endDate);
    } else {
      url.searchParams.delete("end");
    }
    if (vehicle) {
      url.searchParams.set("vehicle", vehicle);
    } else {
      url.searchParams.delete("vehicle");
    }

    if (!getExplicitMapViewFromUrl(url.toString())) {
      url.searchParams.delete("map_view");
      url.searchParams.delete("lat");
      url.searchParams.delete("lng");
      url.searchParams.delete("zoom");
    }

    const visibility = this.state.layers.visibility || {};
    const visibleLayers = Object.keys(visibility).filter((name) => visibility[name]);
    if (visibleLayers.length) {
      url.searchParams.set("layers", visibleLayers.join(","));
    } else {
      url.searchParams.delete("layers");
    }

    if (push && window.history.pushState) {
      // Preserve any existing Swup/native history metadata while marking this entry
      // as a store-only URL/state change.
      const baseState =
        window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : null;
      const nextState = baseState
        ? { ...baseState, source: "es-store" }
        : { source: "es-store" };
      window.history.pushState(nextState, document.title, url.toString());
      return;
    }

    // Preserve swup's history.state so back/forward navigation keeps working.
    window.history.replaceState(window.history.state, document.title, url.toString());
  }
}

export async function optimisticAction({ optimistic, request, commit, rollback }) {
  let snapshot = null;
  try {
    snapshot = optimistic?.();
    const result = await request();
    if (commit) {
      commit(result, snapshot);
    }
    return result;
  } catch (error) {
    if (rollback) {
      rollback(snapshot, error);
    }
    throw error;
  }
}

const store = new ESStore();

export default store;
