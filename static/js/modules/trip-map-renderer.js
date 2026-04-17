/* global deck, mapboxgl */

import store from "./core/store.js";
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
    if (this.overlay || !this.isAvailable()) {
      return this.overlay;
    }
    this.overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
    });
    store.map.addControl(this.overlay);
    return this.overlay;
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
      layers.push(...this.buildLayersForTripLayer(layerName, layerInfo, layerState));
    });

    layers.push(...this.buildSelectedLayers());
    overlay.setProps({ layers });
    performance.mark?.("trip-map:rendered");
  },

  buildLayersForTripLayer(layerName, layerInfo, layerState) {
    const { decoded } = layerState;
    const data = {
      length: decoded.length,
      startIndices: decoded.startIndices,
      attributes: {
        getPath: { value: decoded.positions, size: 2 },
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

    const highlightColor =
      (selectedLayer === "matchedTrips"
        ? MapStyles.MAP_LAYER_COLORS?.matchedTrips?.highlight
        : MapStyles.MAP_LAYER_COLORS?.trips?.selected) || "#d09868";

    return [
      new deck.PathLayer({
        id: this.selectedLayerId,
        data: paths,
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
      return style?.layers?.find?.((layer) => layer.type === "symbol")?.id;
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
    const bbox = this.layers.get(layerName)?.bundle?.bbox;
    return isFiniteBbox(bbox) ? bbox.map(Number) : null;
  },

  getTripBounds(layerName, tripId) {
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
export { isTripLayer };
