const STORAGE_KEY = "es:state";
const VERSION = 1;

const LEGACY_KEY_MAP = {
  startDate: "filters.startDate",
  endDate: "filters.endDate",
  selectedLocation: "map.selectedLocation",
  mapView: "map.view",
  mapType: "map.style",
  layerVisibility: "layers.visibility",
  layerSettings: "layers.settings",
  streetViewMode: "map.streetViewMode",
  selectedVehicleImei: "filters.vehicle",
  selectedVehicle: "filters.vehicle",
};

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
    this.state = deepClone(DEFAULT_STATE);
    this.listeners = new Set();
    this.initialized = false;
  }

  init(url = window.location.href) {
    if (this.initialized) {
      return;
    }

    const saved = parseJson(sessionStorage.getItem(STORAGE_KEY));
    if (saved && typeof saved === "object") {
      this.state = { ...deepClone(DEFAULT_STATE), ...saved };
    } else {
      this.state = deepClone(DEFAULT_STATE);
      this._migrateFromLocalStorage();
    }

    this.applyUrlParams(url, { emit: false });
    this._persist();
    this.initialized = true;
  }

  _migrateFromLocalStorage() {
    Object.entries(LEGACY_KEY_MAP).forEach(([legacyKey, path]) => {
      if (!path) {
        return;
      }
      const raw = localStorage.getItem(legacyKey);
      if (raw === null) {
        return;
      }
      const parsed = parseJson(raw);
      setByPath(this.state, path, parsed ?? raw);
    });
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

  _notify(change) {
    this.listeners.forEach((listener) => {
      try {
        listener(change, this.state);
      } catch (e) {
        console.warn("Store listener failed:", e);
      }
    });
  }

  get(path) {
    return getByPath(this.state, path);
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(path, value, options = {}) {
    setByPath(this.state, path, value);
    if (options.persist !== false) {
      this._persist();
    }
    if (!options.silent) {
      this._notify({ path, value, source: options.source || "set" });
    }
  }

  update(partial, options = {}) {
    this.state = {
      ...this.state,
      ...partial,
    };
    if (options.persist !== false) {
      this._persist();
    }
    if (!options.silent) {
      this._notify({ path: null, value: partial, source: options.source || "update" });
    }
  }

  getLegacy(key) {
    const path = LEGACY_KEY_MAP[key];
    if (!path) {
      return undefined;
    }
    return getByPath(this.state, path);
  }

  setLegacy(key, value, options = {}) {
    const path = LEGACY_KEY_MAP[key];
    if (!path) {
      return false;
    }
    this.set(path, value, options);
    return true;
  }

  removeLegacy(key) {
    const path = LEGACY_KEY_MAP[key];
    if (!path) {
      return false;
    }
    this.set(path, null, { persist: true, source: "remove" });
    return true;
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
      this._emit("es:filters-change", { ...nextFilters, source: options.source });
      this._emit("filtersApplied", { ...nextFilters });
    }
    this._notify({ path: "filters", value: nextFilters, source: options.source });
  }

  updateMapView(view, options = {}) {
    this.state.map.view = view;
    if (options.persist !== false) {
      this._persist();
    }
    if (options.syncUrl !== false) {
      this.syncUrl({ replace: true });
    }
    if (options.emit !== false) {
      this._emit("es:map-view-change", { view, source: options.source });
    }
    this._notify({ path: "map.view", value: view, source: options.source });
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
    this._notify({
      path: "layers.visibility",
      value: visibility,
      source: options.source,
    });
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

    const lat = parseFloat(params.get("lat"));
    const lng = parseFloat(params.get("lng"));
    const zoom = parseFloat(params.get("zoom"));
    const hasMapParams
      = !Number.isNaN(lat) && !Number.isNaN(lng) && !Number.isNaN(zoom);
    if (hasMapParams) {
      this.state.map.view = { center: [lng, lat], zoom };
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

    this._notify({ path: "url", value: parsedUrl.toString(), source: options.source });
  }

  syncUrl({ push = false, replace = false } = {}) {
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

    const { view } = this.state.map;
    if (view && Array.isArray(view.center)) {
      url.searchParams.set("lat", Number(view.center[1]).toFixed(5));
      url.searchParams.set("lng", Number(view.center[0]).toFixed(5));
      if (Number.isFinite(view.zoom)) {
        url.searchParams.set("zoom", Number(view.zoom).toFixed(2));
      }
    }

    const visibility = this.state.layers.visibility || {};
    const visibleLayers = Object.keys(visibility).filter((name) => visibility[name]);
    if (visibleLayers.length) {
      url.searchParams.set("layers", visibleLayers.join(","));
    } else {
      url.searchParams.delete("layers");
    }

    if (push && window.history.pushState) {
      window.history.pushState({ es: true }, "", url.toString());
    } else {
      window.history.replaceState({ es: true }, "", url.toString());
    }
  }

  getStorageScope(key) {
    if (Object.hasOwn(LEGACY_KEY_MAP, key)) {
      return "session";
    }
    return "local";
  }

  getDefaultState() {
    return deepClone(DEFAULT_STATE);
  }
}

const store = new ESStore();

export default store;
export { LEGACY_KEY_MAP, URL_PARAM_MAP };
