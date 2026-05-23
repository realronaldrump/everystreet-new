/* global deck */

import store from "./core/store.js";
import {
  isTerrainReliefApplied,
  MAP_TERRAIN_RELIEF_APPLIED_EVENT,
} from "./features/map/terrain-relief.js";
import heatmapUtils from "./heatmap-utils.js";
import MapStyles from "./map-styles.js";
import tripInteractions from "./trip-interactions.js";

const TRIP_LAYER_NAMES = new Set(["trips", "matchedTrips"]);
const WORKER_URL = new URL("./trip-map-worker.js", import.meta.url);

function isTripLayer(layerName) {
  return TRIP_LAYER_NAMES.has(layerName);
}

function isFiniteBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((value) => Number.isFinite(Number(value)))
  );
}

function isFiniteCoord(coord) {
  return (
    Array.isArray(coord) &&
    coord.length >= 2 &&
    Number.isFinite(Number(coord[0])) &&
    Number.isFinite(Number(coord[1]))
  );
}

function extendBounds(bounds, coord) {
  if (!isFiniteCoord(coord)) {
    return false;
  }
  bounds[0] = Math.min(bounds[0], Number(coord[0]));
  bounds[1] = Math.min(bounds[1], Number(coord[1]));
  bounds[2] = Math.max(bounds[2], Number(coord[0]));
  bounds[3] = Math.max(bounds[3], Number(coord[1]));
  return true;
}

function boundsFromCoords(coords) {
  const bounds = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let hasCoords = false;

  (coords || []).forEach((coord) => {
    hasCoords = extendBounds(bounds, coord) || hasCoords;
  });

  return hasCoords ? bounds : null;
}

function boundsFromDecoded(decoded) {
  if (!decoded?.length || !decoded.positions?.length) {
    return null;
  }

  const bounds = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  let hasCoords = false;

  for (let index = 0; index < decoded.positions.length; index += 2) {
    hasCoords =
      extendBounds(bounds, [decoded.positions[index], decoded.positions[index + 1]]) ||
      hasCoords;
  }

  return hasCoords ? bounds : null;
}

function normalizeTripId(trip) {
  return String(trip?.id ?? trip?.transactionId ?? "");
}

function toTripProperties(trip, layerName) {
  return {
    transactionId: normalizeTripId(trip),
    id: normalizeTripId(trip),
    imei: trip?.imei || "",
    source: layerName === "matchedTrips" ? "matched" : "bouncie",
    startTime: trip?.start_time || null,
    endTime: trip?.end_time || null,
    distance: trip?.distance_miles ?? null,
    duration: trip?.duration_seconds ?? null,
    avgSpeed: trip?.avg_speed ?? null,
    maxSpeed: trip?.max_speed ?? null,
    estimated_cost: trip?.estimated_cost ?? null,
    coverageDistance: trip?.coverage_distance_miles ?? null,
    pointsRecorded: trip?.point_count ?? 0,
    startLocation: trip?.start_location ?? null,
    destination: trip?.destination ?? null,
    geometrySource: trip?.geometry_source || null,
  };
}

function typedArrayFromBuffer(value, Type) {
  if (value instanceof Type) {
    return value;
  }
  return new Type(value || 0);
}

function colorWithAlpha(hex, alpha = 255) {
  const fallback = [212, 148, 60, alpha];
  if (typeof hex !== "string") {
    return fallback;
  }
  const normalized = hex.trim().replace("#", "");
  if (![3, 6].includes(normalized.length)) {
    return fallback;
  }
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((ch) => `${ch}${ch}`)
          .join("")
      : normalized;
  const value = Number.parseInt(expanded, 16);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
}

const tripMapRenderer = {
  overlay: null,
  worker: null,
  nextRequestId: 1,
  pending: new Map(),
  layers: new Map(),
  selectedLayerId: "trip-map-selected-layer",
  terrainActive: false,
  _terrainListenerBound: false,
  _mapListenersBound: false,

  isTripLayer,

  isAvailable() {
    return Boolean(
      store.map &&
        typeof store.map.addControl === "function" &&
        globalThis.deck?.MapboxOverlay &&
        globalThis.deck?.PathLayer
    );
  },

  ensureWorker() {
    if (this.worker) {
      return this.worker;
    }
    this.worker = new Worker(WORKER_URL, { type: "module" });
    this.worker.onmessage = (event) => {
      const { id, ok, decoded, error } = event.data || {};
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if (!ok) {
        pending.reject(new Error(error || "Trip map worker failed"));
        return;
      }
      pending.resolve({
        length: decoded.length,
        positions: typedArrayFromBuffer(decoded.positions, Float64Array),
        startIndices: typedArrayFromBuffer(decoded.startIndices, Uint32Array),
        tripIndices: typedArrayFromBuffer(decoded.tripIndices, Uint32Array),
      });
    };
    return this.worker;
  },

  decodeTrips(trips) {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, trips });
    return promise;
  },

  ensureOverlay() {
    this._bindTerrainListener();
    this._bindMapListeners();
    if (this.overlay || !this.isAvailable()) {
      return this.overlay;
    }
    this.overlay = new deck.MapboxOverlay({
      // Interleaved rendering shares Mapbox's depth buffer. Once 3D terrain is
      // enabled, flat (z=0) trip paths get occluded by the terrain mesh and
      // flicker or vanish entirely when the camera is pitched. Overlaid mode
      // composites deck.gl on top of the map, keeping trips reliably visible.
      interleaved: !this.terrainActive,
      layers: [],
    });
    store.map.addControl(this.overlay);
    return this.overlay;
  },

  _bindTerrainListener() {
    if (this._terrainListenerBound || typeof document === "undefined") {
      return;
    }
    this._terrainListenerBound = true;
    // Terrain may have been applied before any trips rendered (e.g. when the
    // saved preference is on at page load), so capture the current state once.
    this.terrainActive = isTerrainReliefApplied();
    document.addEventListener(MAP_TERRAIN_RELIEF_APPLIED_EVENT, (event) => {
      this.setTerrainActive(event?.detail?.active === true);
    });
  },

  setTerrainActive(active) {
    const next = Boolean(active);
    if (next === this.terrainActive) {
      return;
    }
    this.terrainActive = next;
    // The interleaved flag is fixed at construction time, so the overlay has
    // to be rebuilt to switch rendering modes.
    if (this.overlay) {
      this._rebuildOverlay();
    }
  },

  _rebuildOverlay() {
    const { map } = store;
    if (this.overlay && map && typeof map.removeControl === "function") {
      try {
        map.removeControl(this.overlay);
      } catch {
        // Overlay may already be detached during teardown.
      }
    }
    this.overlay = null;
    this.render();
  },

  _bindMapListeners() {
    if (this._mapListenersBound) {
      return;
    }
    const { map } = store;
    if (!map || typeof map.on !== "function") {
      return;
    }
    this._mapListenersBound = true;
    // DEM tiles stream in progressively, so elevations sampled right after
    // terrain is enabled are often incomplete. Re-sample once the map settles
    // (and after zooming in for finer detail) so trip paths track the surface.
    map.on("idle", () => this._handleMapIdle());
  },

  _handleMapIdle() {
    if (!this.terrainActive || !this.layers.size) {
      return;
    }
    const { map } = store;
    const currentZoom = Math.floor(Number(map?.getZoom?.() ?? 0));
    let changed = false;
    for (const [layerName, layerState] of this.layers) {
      if (!layerState?.decoded?.positions?.length) {
        continue;
      }
      const needsResample =
        !layerState.drapedPositions ||
        layerState.drapePending === true ||
        currentZoom > (layerState.drapeZoom ?? -1);
      if (needsResample && this._drapeLayerPositions(layerName)) {
        changed = true;
      }
    }
    if (changed) {
      this.render();
    }
  },

  // Builds a [lng, lat, elevation] position buffer so deck.gl renders the
  // trip path on the terrain surface instead of at sea level (z=0).
  _drapeLayerPositions(layerName) {
    const { map } = store;
    const layerState = this.layers.get(layerName);
    const flat = layerState?.decoded?.positions;
    if (!flat?.length || typeof map?.queryTerrainElevation !== "function") {
      return false;
    }

    const pointCount = Math.floor(flat.length / 2);
    const previous = layerState.drapedPositions;
    const reusePrevious = previous && previous.length === pointCount * 3;
    const draped = new Float64Array(pointCount * 3);
    let pending = false;

    for (let index = 0; index < pointCount; index += 1) {
      const lng = flat[index * 2];
      const lat = flat[index * 2 + 1];
      const elevation = map.queryTerrainElevation([lng, lat]);
      draped[index * 3] = lng;
      draped[index * 3 + 1] = lat;
      if (Number.isFinite(elevation)) {
        draped[index * 3 + 2] = elevation;
      } else if (reusePrevious) {
        // Keep the last known elevation while the DEM tile reloads.
        draped[index * 3 + 2] = previous[index * 3 + 2];
        pending = true;
      } else {
        draped[index * 3 + 2] = 0;
        pending = true;
      }
    }

    layerState.drapedPositions = draped;
    layerState.drapePending = pending;
    layerState.drapeZoom = Math.floor(Number(map.getZoom?.() ?? 0));
    return true;
  },

  _ensureDrape(layerName) {
    const layerState = this.layers.get(layerName);
    if (!layerState?.decoded?.positions?.length) {
      return;
    }
    if (this.terrainActive) {
      if (!layerState.drapedPositions) {
        this._drapeLayerPositions(layerName);
      }
    } else if (layerState.drapedPositions) {
      layerState.drapedPositions = null;
      layerState.drapePending = false;
      layerState.drapeZoom = -1;
    }
  },

  _drapePath(path) {
    const { map } = store;
    if (!this.terrainActive || typeof map?.queryTerrainElevation !== "function") {
      return path;
    }
    return path.map(([lng, lat]) => {
      const elevation = map.queryTerrainElevation([lng, lat]);
      return [lng, lat, Number.isFinite(elevation) ? elevation : 0];
    });
  },

  async setLayerData(layerName, bundle) {
    if (!isTripLayer(layerName) || !bundle) {
      return null;
    }
    performance.mark?.(`trip-map:${layerName}:decode-start`);
    const decoded = await this.decodeTrips(bundle.trips || []);
    performance.mark?.(`trip-map:${layerName}:decode-end`);
    performance.measure?.(
      `trip-map:${layerName}:decode`,
      `trip-map:${layerName}:decode-start`,
      `trip-map:${layerName}:decode-end`
    );

    const tripById = new Map();
    (bundle.trips || []).forEach((trip, index) => {
      tripById.set(normalizeTripId(trip), { trip, index });
    });

    const layerState = {
      bundle,
      decoded,
      tripById,
      featureCollection: null,
    };
    this.layers.set(layerName, layerState);
    store.mapLayers[layerName].layer = {
      type: "TripMapBundle",
      bundle,
      features: null,
    };
    this.render();
    return layerState;
  },

  setLayerVisibility(layerName, visible) {
    const info = store.mapLayers[layerName];
    if (info) {
      info.visible = Boolean(visible);
    }
    this.render();
  },

  setUseHeatmap(useHeatmap) {
    ["trips", "matchedTrips"].forEach((layerName) => {
      if (store.mapLayers[layerName]) {
        store.mapLayers[layerName].isHeatmap = useHeatmap !== false;
      }
    });
    this.render();
  },

  refreshSelection() {
    this.render();
  },

  render() {
    const overlay = this.ensureOverlay();
    if (!overlay) {
      return;
    }

    const layers = [];
    ["trips", "matchedTrips"].forEach((layerName) => {
      const layerInfo = store.mapLayers[layerName];
      const layerState = this.layers.get(layerName);
      if (!layerInfo?.visible || !layerState?.decoded?.length) {
        return;
      }
      this._ensureDrape(layerName);
      layers.push(...this.buildLayersForTripLayer(layerName, layerInfo, layerState));
    });

    layers.push(...this.buildSelectedLayers());
    overlay.setProps({ layers });
    performance.mark?.("trip-map:rendered");
  },

  buildLayersForTripLayer(layerName, layerInfo, layerState) {
    const { decoded } = layerState;
    const draped =
      this.terrainActive && layerState.drapedPositions?.length
        ? layerState.drapedPositions
        : null;
    const data = {
      length: decoded.length,
      startIndices: decoded.startIndices,
      attributes: {
        getPath: draped
          ? { value: draped, size: 3 }
          : { value: decoded.positions, size: 2 },
      },
    };
    const beforeId = this.getBeforeLayerId();
    const common = {
      data,
      _pathType: "open",
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      parameters: { depthTest: false },
      beforeId,
    };

    if (layerInfo.isHeatmap) {
      const palette = this.getHeatmapPalette(layerName);
      const settings = heatmapUtils.getAdaptiveSettings(
        layerState.bundle?.trip_count || layerState.bundle?.trips?.length || 0
      );
      return [
        new deck.PathLayer({
          ...common,
          id: `${layerName}-trip-map-glow`,
          pickable: false,
          getColor: colorWithAlpha(
            palette.glow,
            Math.round(settings.glowOpacity * 255)
          ),
          getWidth: settings.glowWidth,
          opacity: layerInfo.opacity ?? 1,
        }),
        new deck.PathLayer({
          ...common,
          id: `${layerName}-trip-map-core`,
          pickable: true,
          getColor: colorWithAlpha(
            palette.core,
            Math.round(settings.coreOpacity * 255)
          ),
          getWidth: settings.baseWidth,
          opacity: layerInfo.opacity ?? 1,
          onClick: (info) => this.handleTripClick(info, layerName),
        }),
      ];
    }

    return [
      new deck.PathLayer({
        ...common,
        id: `${layerName}-trip-map-line`,
        pickable: true,
        getColor: colorWithAlpha(layerInfo.color || "#d4943c", 230),
        getWidth: layerInfo.weight || 2,
        opacity: layerInfo.opacity ?? 1,
        onClick: (info) => this.handleTripClick(info, layerName),
      }),
    ];
  },

  buildSelectedLayers() {
    const selectedId = store.selectedTripId ? String(store.selectedTripId) : null;
    const selectedLayer = store.selectedTripLayer;
    if (!selectedId || !isTripLayer(selectedLayer)) {
      return [];
    }
    const paths = this.getTripPaths(selectedLayer, selectedId);
    if (!paths.length) {
      return [];
    }

    const data = this.terrainActive
      ? paths.map((path) => this._drapePath(path))
      : paths;

    const highlightColor =
      (selectedLayer === "matchedTrips"
        ? MapStyles.MAP_LAYER_COLORS?.matchedTrips?.highlight
        : MapStyles.MAP_LAYER_COLORS?.trips?.selected) || "#d09868";

    return [
      new deck.PathLayer({
        id: this.selectedLayerId,
        data,
        pickable: false,
        getPath: (path) => path,
        getColor: colorWithAlpha(highlightColor, 245),
        getWidth: 5,
        widthUnits: "pixels",
        widthMinPixels: 3,
        widthMaxPixels: 12,
        jointRounded: true,
        capRounded: true,
        parameters: { depthTest: false },
        beforeId: this.getBeforeLayerId(),
      }),
    ];
  },

  getHeatmapPalette(layerName) {
    if (layerName === "matchedTrips") {
      const colors = MapStyles.MAP_LAYER_COLORS?.matchedTrips || {};
      return {
        glow: colors.default || "#c45454",
        core: colors.highlight || "#5fa0c4",
      };
    }
    const theme = document.documentElement?.getAttribute("data-bs-theme") || "dark";
    return heatmapUtils.COLORS[theme] || heatmapUtils.COLORS.dark;
  },

  getBeforeLayerId() {
    try {
      const style = store.map?.getStyle?.();
      return style?.layers?.find?.(
        (layer) => layer.type === "symbol" && store.map?.getLayer?.(layer.id)
      )?.id;
    } catch {
      return undefined;
    }
  },

  handleTripClick(info, layerName) {
    if (!info || typeof info.index !== "number") {
      return false;
    }
    info.srcEvent?.stopPropagation?.();
    info.srcEvent?.preventDefault?.();

    const layerState = this.layers.get(layerName);
    const tripIndex = layerState?.decoded?.tripIndices?.[info.index];
    const trip = layerState?.bundle?.trips?.[tripIndex];
    if (!trip) {
      return false;
    }

    const tripId = normalizeTripId(trip);
    store._lastTripMapPickTs = Date.now();
    store.selectedTripId = tripId;
    store.selectedTripLayer = layerName;
    this.refreshSelection();

    const feature = this.getTripFeature(layerName, tripId, { lightweight: false });
    tripInteractions.handleTripClick(
      { lngLat: info.coordinate || [0, 0], originalEvent: info.srcEvent },
      feature,
      layerName,
      { closeOnClick: false }
    );
    return true;
  },

  getBundleBounds(layerName = "trips") {
    const layerState = this.layers.get(layerName);
    const decodedBounds = boundsFromDecoded(layerState?.decoded);
    if (isFiniteBbox(decodedBounds)) {
      return decodedBounds.map(Number);
    }

    if (
      Number(
        layerState?.bundle?.trip_count || layerState?.bundle?.trips?.length || 0
      ) <= 0
    ) {
      return null;
    }

    const bbox = layerState?.bundle?.bbox;
    return isFiniteBbox(bbox) ? bbox.map(Number) : null;
  },

  getTripBounds(layerName, tripId) {
    const pathBounds = boundsFromCoords(this.getTripPaths(layerName, tripId).flat());
    if (isFiniteBbox(pathBounds)) {
      return pathBounds.map(Number);
    }

    const trip = this.layers.get(layerName)?.tripById?.get(String(tripId))?.trip;
    return isFiniteBbox(trip?.bbox) ? trip.bbox.map(Number) : null;
  },

  getTripPaths(layerName, tripId) {
    const layerState = this.layers.get(layerName);
    const match = layerState?.tripById?.get(String(tripId));
    if (!match || !layerState.decoded?.length) {
      return [];
    }
    const paths = [];
    const { positions, startIndices, tripIndices } = layerState.decoded;
    for (let pathIndex = 0; pathIndex < tripIndices.length; pathIndex += 1) {
      if (tripIndices[pathIndex] !== match.index) {
        continue;
      }
      const start = startIndices[pathIndex];
      const end = startIndices[pathIndex + 1];
      const path = [];
      for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
        path.push([positions[pointIndex * 2], positions[pointIndex * 2 + 1]]);
      }
      if (path.length >= 2) {
        paths.push(path);
      }
    }
    return paths;
  },

  getTripFeature(layerName, tripId, { lightweight = true } = {}) {
    const trip = this.layers.get(layerName)?.tripById?.get(String(tripId))?.trip;
    if (!trip) {
      return null;
    }
    const paths = lightweight ? [] : this.getTripPaths(layerName, tripId);
    if (!lightweight && !paths.length) {
      return null;
    }
    const geometry =
      paths.length > 1
        ? { type: "MultiLineString", coordinates: paths }
        : { type: "LineString", coordinates: paths[0] || [] };
    return {
      type: "Feature",
      id: normalizeTripId(trip),
      source: layerName,
      geometry,
      properties: toTripProperties(trip, layerName),
    };
  },

  getFeatureCollection(layerName) {
    const layerState = this.layers.get(layerName);
    if (!layerState) {
      return { type: "FeatureCollection", features: [] };
    }
    if (layerState.featureCollection) {
      return layerState.featureCollection;
    }
    const features = (layerState.bundle?.trips || [])
      .map((trip) =>
        this.getTripFeature(layerName, normalizeTripId(trip), {
          lightweight: false,
        })
      )
      .filter(Boolean);
    layerState.featureCollection = { type: "FeatureCollection", features };
    return layerState.featureCollection;
  },

  getRenderableFeatures() {
    return ["trips", "matchedTrips"].flatMap(
      (layerName) => this.getFeatureCollection(layerName).features || []
    );
  },

  clearLayer(layerName) {
    this.layers.delete(layerName);
    if (store.mapLayers[layerName]) {
      store.mapLayers[layerName].layer = null;
    }
    this.render();
  },
};

export default tripMapRenderer;
