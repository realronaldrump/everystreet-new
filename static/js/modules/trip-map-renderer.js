/**
 * Draws recorded and matched trips on the Map page with native Mapbox layers.
 *
 * Paths draw every trip once, older trips fading back. Heat draws every road
 * in the colour of how many trips used it: the worker gives each stretch of
 * each trip its trip count (trip-heat.js), so a road driven four hundred
 * times prints differently from one driven forty times instead of both
 * saturating into the same translucent wash.
 */

import { CONFIG } from "./core/config.js";
import store from "./core/store.js";
import { readMapColor } from "./core/theme-tokens.js";
import MapStyles from "./map-styles.js";
import { heatLevel } from "./trip-heat.js";
import tripInteractions from "./trip-interactions.js";

const TRIP_LAYER_NAMES = ["trips", "matchedTrips"];
const WORKER_URL = new URL("./trip-map-worker.js", import.meta.url);
const SELECTED_SOURCE_ID = "trip-map-selected-source";
const SELECTED_CASING_ID = "trip-map-selected-casing";
const SELECTED_LAYER_ID = "trip-map-selected-layer";
const HEAT_TOKENS = ["--map-heat-0", "--map-heat-1", "--map-heat-2", "--map-heat-3", "--map-heat-4"];
const HEAT_STOPS = [0, 0.25, 0.5, 0.75, 1];
/** A range shorter than this is one outing; its trips do not fade by age. */
const RECENCY_MIN_SPAN_MS = 36 * 60 * 60 * 1000;

function isTripLayer(layerName) {
  return TRIP_LAYER_NAMES.includes(layerName);
}

function layerIds(layerName) {
  return {
    source: `${layerName}-source`,
    heatSource: `${layerName}-heat-source`,
    paths: `${layerName}-layer`,
    heat: `${layerName}-layer-heat`,
    heatGlow: `${layerName}-layer-heat-glow`,
    hitbox: `${layerName}-hitbox`,
  };
}

/** A width that grows with zoom: `[[zoom, width], ...]`, widths may be expressions. */
function byZoom(stops) {
  return ["interpolate", ["exponential", 1.5], ["zoom"], ...stops.flat()];
}

/** Width from `thin` (heat 0) to `thick` (heat 1) at each zoom. */
function heatWidth(stops) {
  return byZoom(
    stops.map(([zoom, thin, thick]) => [
      zoom,
      ["+", thin, ["*", thick - thin, ["get", "h"]]],
    ])
  );
}

const HEAT_LINE_WIDTH = [
  [4, 0.5, 1.1],
  [9, 0.8, 1.9],
  [12, 1, 2.8],
  [15, 1.5, 4.4],
  [18, 2.6, 8],
];
const HEAT_GLOW_WIDTH = [
  [4, 2, 4],
  [9, 3, 7],
  [12, 4, 11],
  [15, 6, 18],
  [18, 10, 30],
];
const PATH_WIDTH = [
  [4, 0.5],
  [9, 0.8],
  [12, 1.3],
  [15, 2.3],
  [18, 4],
];
const MATCHED_WIDTH = [
  [4, 0.6],
  [9, 1],
  [12, 1.6],
  [15, 2.8],
  [18, 4.5],
];
const SELECTED_WIDTH = [
  [4, 2],
  [9, 2.6],
  [12, 3.4],
  [15, 5],
  [18, 8],
];
const HITBOX_WIDTH = [
  [6, 8],
  [10, 12],
  [14, 16],
  [18, 20],
  [22, 24],
];

function normalizeTripId(trip) {
  return String(trip?.id ?? trip?.transactionId ?? "");
}

function tripTime(trip) {
  const time = Date.parse(trip?.start_time || trip?.end_time || "");
  return Number.isFinite(time) ? time : null;
}

/** 0 for the oldest trip in the bundle, 1 for the newest. */
function recencyScale(trips) {
  const times = trips.map(tripTime).filter((time) => time !== null);
  if (!times.length) {
    return () => 1;
  }
  const oldest = Math.min(...times);
  const span = Math.max(...times) - oldest;
  if (span < RECENCY_MIN_SPAN_MS) {
    return () => 1;
  }
  return (trip) => {
    const time = tripTime(trip);
    return time === null ? 1 : Math.round(((time - oldest) / span) * 1000) / 1000;
  };
}

function toTripProperties(trip, layerName, recency = 1) {
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
    r: recency,
  };
}

function typedArrayFromBuffer(value, Type) {
  if (value instanceof Type) {
    return value;
  }
  return new Type(value || 0);
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

function emptyBounds() {
  return [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
}

function boundsFromCoords(coords) {
  const bounds = emptyBounds();
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
  const bounds = emptyBounds();
  let hasCoords = false;
  for (let index = 0; index < decoded.positions.length; index += 2) {
    hasCoords =
      extendBounds(bounds, [decoded.positions[index], decoded.positions[index + 1]]) ||
      hasCoords;
  }
  return hasCoords ? bounds : null;
}

function indexDecodedPathsByTrip(decoded) {
  const pathIndicesByTrip = new Map();
  const tripIndices = decoded?.tripIndices;
  if (!tripIndices?.length) {
    return pathIndicesByTrip;
  }
  for (let pathIndex = 0; pathIndex < tripIndices.length; pathIndex += 1) {
    const tripIndex = tripIndices[pathIndex];
    const pathIndices = pathIndicesByTrip.get(tripIndex);
    if (pathIndices) {
      pathIndices.push(pathIndex);
    } else {
      pathIndicesByTrip.set(tripIndex, [pathIndex]);
    }
  }
  return pathIndicesByTrip;
}

function sliceCoordinates(positions, start, end) {
  const coordinates = [];
  for (let point = start; point <= end; point += 1) {
    coordinates.push([positions[point * 2], positions[point * 2 + 1]]);
  }
  return coordinates;
}

/** "1 trip", "14 trips", "about 140 trips": counts are neighbourhood estimates. */
export function describeRoadTrips(count) {
  const trips = Math.max(1, Math.round(Number(count) || 1));
  if (trips === 1) {
    return "1 trip";
  }
  if (trips < 20) {
    return `${trips} trips`;
  }
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(trips)) - 1);
  return `About ${(Math.round(trips / magnitude) * magnitude).toLocaleString()} trips`;
}

const tripMapRenderer = {
  worker: null,
  nextRequestId: 1,
  pending: new Map(),
  layers: new Map(),
  _suppressedBy: new Set(),
  _handlers: new Map(),
  _sourceData: new Map(),
  _listenersBound: false,
  _heatTip: null,

  isTripLayer,

  canRender() {
    const { map } = store;
    return Boolean(
      map &&
        typeof map.addSource === "function" &&
        typeof map.getSource === "function" &&
        typeof map.addLayer === "function" &&
        typeof map.getLayer === "function" &&
        typeof map.setLayoutProperty === "function" &&
        typeof map.setPaintProperty === "function"
    );
  },

  ensureWorker() {
    if (this.worker) {
      return this.worker;
    }
    this.worker = new Worker(WORKER_URL, { type: "module" });
    this.worker.onmessage = (event) => {
      const { id, ok, decoded, heat, error } = event.data || {};
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
        heat: heat
          ? {
              length: heat.length,
              paths: typedArrayFromBuffer(heat.paths, Uint32Array),
              starts: typedArrayFromBuffer(heat.starts, Uint32Array),
              ends: typedArrayFromBuffer(heat.ends, Uint32Array),
              frequencies: typedArrayFromBuffer(heat.frequencies, Uint32Array),
              reference: heat.reference,
            }
          : null,
      });
    };
    return this.worker;
  },

  decodeTrips(trips, { heat = false } = {}) {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    worker.postMessage({ id, trips, heat });
    return promise;
  },

  async setLayerData(layerName, bundle) {
    if (!isTripLayer(layerName) || !bundle) {
      return null;
    }
    const current = this.layers.get(layerName);
    if (current?.bundle === bundle) {
      // A style reload re-applies the layer it already has.
      this.render();
      return current;
    }

    performance.mark?.(`trip-map:${layerName}:decode-start`);
    // Only recorded trips are drawn as heat; matched trips skip the count.
    const decoded = await this.decodeTrips(bundle.trips || [], {
      heat: layerName === "trips",
    });
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
      heat: decoded.heat || null,
      pathIndicesByTrip: indexDecodedPathsByTrip(decoded),
      tripById,
      featureCollection: null,
      heatCollection: null,
    };
    this.layers.set(layerName, layerState);
    if (store.mapLayers[layerName]) {
      store.mapLayers[layerName].layer = { type: "TripMapBundle", bundle, features: null };
    }
    this.render();
    globalThis.document?.dispatchEvent?.(
      new CustomEvent("es:trip-layer-drawn", { detail: { layerName } })
    );
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
    TRIP_LAYER_NAMES.forEach((layerName) => {
      if (store.mapLayers[layerName]) {
        store.mapLayers[layerName].isHeatmap = useHeatmap !== false;
      }
    });
    this.render();
  },

  suppressTripLayers(reason = "default") {
    const wasSuppressed = this.areTripLayersSuppressed();
    this._suppressedBy.add(String(reason || "default"));
    if (!wasSuppressed) {
      this.render();
    }
  },

  restoreTripLayers(reason = "default") {
    if (!this._suppressedBy.delete(String(reason || "default"))) {
      return;
    }
    if (!this.areTripLayersSuppressed()) {
      this.render();
    }
  },

  areTripLayersSuppressed() {
    return this._suppressedBy.size > 0;
  },

  refreshSelection() {
    this.render();
  },

  /** Heat mode applies to recorded trips; matched trips always draw as paths. */
  _drawsHeat(layerName) {
    return layerName === "trips" && store.mapLayers[layerName]?.isHeatmap === true;
  },

  _bindListeners() {
    if (this._listenersBound || typeof document === "undefined") {
      return;
    }
    this._listenersBound = true;
    // Satellite and street styles survive a theme switch, so re-ink by hand.
    document.addEventListener("themeChanged", () => this.render());
  },

  render() {
    if (!this.canRender()) {
      return;
    }
    this._bindListeners();
    const suppressed = this.areTripLayersSuppressed();
    const beforeId = this.getBeforeLayerId();
    this._layersAdded = false;

    TRIP_LAYER_NAMES.forEach((layerName) => {
      const info = store.mapLayers[layerName];
      const layerState = this.layers.get(layerName);
      const visible = !suppressed && info?.visible && layerState?.decoded?.length > 0;
      if (!visible) {
        this._hideTripLayer(layerName);
        return;
      }
      if (this._drawsHeat(layerName) && layerState.heat) {
        this._drawHeat(layerName, layerState, beforeId);
      } else {
        this._drawPaths(layerName, info, beforeId);
      }
    });
    this._drawSelection(suppressed, beforeId);
    if (this._layersAdded) {
      this._orderLayers(beforeId);
    }
    performance.mark?.("trip-map:rendered");
  },

  /** Bottom to top: heat, recorded paths, matched paths, the selection, hitboxes. */
  _orderLayers(beforeId) {
    const { map } = store;
    if (typeof map.moveLayer !== "function") {
      return;
    }
    const trips = layerIds("trips");
    const matched = layerIds("matchedTrips");
    const drawn = [
      trips.heatGlow,
      trips.heat,
      trips.paths,
      matched.paths,
      SELECTED_CASING_ID,
      SELECTED_LAYER_ID,
    ];
    const target = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
    drawn.filter((id) => map.getLayer(id)).forEach((id) => map.moveLayer(id, target));
    [trips.hitbox, matched.hitbox]
      .filter((id) => map.getLayer(id))
      .forEach((id) => map.moveLayer(id));
  },

  _setVisibility(layerId, visible) {
    if (store.map.getLayer(layerId)) {
      store.map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  },

  _hideTripLayer(layerName) {
    const ids = layerIds(layerName);
    [ids.paths, ids.heat, ids.heatGlow, ids.hitbox].forEach((layerId) =>
      this._setVisibility(layerId, false)
    );
    if (layerName === "trips") {
      this._hideHeatTip();
    }
  },

  _ensureSource(sourceId, data) {
    const source = store.map.getSource(sourceId);
    if (source) {
      const cached = this._sourceData.get(sourceId);
      if (cached?.map !== store.map || cached.data !== data) {
        source.setData(data);
        this._sourceData.set(sourceId, { map: store.map, data });
      }
      return;
    }
    store.map.addSource(sourceId, {
      type: "geojson",
      data,
      tolerance: 0.375,
      buffer: 64,
      maxzoom: 18,
    });
    this._sourceData.set(sourceId, { map: store.map, data });
  },

  /**
   * Add a line layer or bring an existing one up to date. A layer bound to
   * another source (the hitbox follows the drawing mode) is rebuilt.
   */
  _ensureLayer({ id, source, paint, layout = {}, filter = null }, beforeId) {
    const { map } = store;
    const existing = map.getLayer(id);
    if (existing && existing.source !== source) {
      this._removeHandlers(id);
      map.removeLayer(id);
    }
    if (!map.getLayer(id)) {
      map.addLayer(
        {
          id,
          type: "line",
          source,
          layout: { "line-join": "round", "line-cap": "round", ...layout },
          paint,
          ...(filter ? { filter } : {}),
        },
        beforeId
      );
      this._layersAdded = true;
      return true;
    }
    Object.entries(paint).forEach(([property, value]) =>
      map.setPaintProperty(id, property, value)
    );
    Object.entries(layout).forEach(([property, value]) =>
      map.setLayoutProperty(id, property, value)
    );
    if (filter) {
      map.setFilter?.(id, filter);
    }
    map.setLayoutProperty(id, "visibility", "visible");
    return false;
  },

  heatInks() {
    return HEAT_TOKENS.map((token) => readMapColor(token));
  },

  _heatColor() {
    const inks = this.heatInks();
    return ["interpolate", ["linear"], ["get", "h"], ...HEAT_STOPS.flatMap((stop, index) => [stop, inks[index]])];
  },

  _isDarkEdition() {
    return globalThis.document?.documentElement?.getAttribute("data-bs-theme") !== "light";
  },

  _drawHeat(layerName, layerState, beforeId) {
    const ids = layerIds(layerName);
    this._setVisibility(ids.paths, false);
    this._ensureSource(ids.heatSource, this.getHeatCollection(layerName));

    const color = this._heatColor();
    const sortKey = ["get", "h"];
    if (this._isDarkEdition()) {
      // Only the busiest roads glow, and only on the night edition: on
      // paper a glow reads as a smudge.
      this._ensureLayer(
        {
          id: ids.heatGlow,
          source: ids.heatSource,
          filter: [">=", ["get", "h"], 0.5],
          layout: { "line-sort-key": sortKey },
          paint: {
            "line-color": color,
            "line-width": heatWidth(HEAT_GLOW_WIDTH),
            "line-blur": heatWidth(
              HEAT_GLOW_WIDTH.map(([zoom, thin, thick]) => [zoom, thin * 0.6, thick * 0.6])
            ),
            "line-opacity": ["interpolate", ["linear"], ["get", "h"], 0.5, 0, 1, 0.34],
          },
        },
        beforeId
      );
    } else {
      this._setVisibility(ids.heatGlow, false);
    }
    this._ensureLayer(
      {
        id: ids.heat,
        source: ids.heatSource,
        layout: { "line-sort-key": sortKey },
        paint: {
          "line-color": color,
          "line-width": heatWidth(HEAT_LINE_WIDTH),
          // Roads driven once or twice recede; the regulars print solid.
          "line-opacity": ["interpolate", ["linear"], ["get", "h"], 0, 0.62, 0.3, 0.86, 0.6, 0.97, 1, 1],
        },
      },
      beforeId
    );
    this._drawHitbox(layerName, ids.heatSource, sortKey);
  },

  _drawPaths(layerName, info, beforeId) {
    const ids = layerIds(layerName);
    [ids.heat, ids.heatGlow].forEach((layerId) => this._setVisibility(layerId, false));
    this._ensureSource(ids.source, this.getFeatureCollection(layerName));
    const matched = layerName === "matchedTrips";
    const ink =
      MapStyles.layerColor(info) || MapStyles.layerColor(CONFIG.LAYER_DEFAULTS.trips);
    const opacity = info.opacity ?? 1;
    this._ensureLayer(
      {
        id: ids.paths,
        source: ids.source,
        layout: { "line-sort-key": ["get", "r"] },
        paint: {
          "line-color": ink,
          "line-width": byZoom(matched ? MATCHED_WIDTH : PATH_WIDTH),
          // Newer trips print over older ones, and older ones fade back.
          "line-opacity": matched
            ? 0.9 * opacity
            : ["interpolate", ["linear"], ["get", "r"], 0, 0.3 * opacity, 1, 0.9 * opacity],
        },
      },
      beforeId
    );
    this._drawHitbox(layerName, ids.source, ["get", "r"]);
  },

  /** An invisible, wide line to click; the top feature matches the drawing. */
  _drawHitbox(layerName, source, sortKey) {
    const { hitbox } = layerIds(layerName);
    const created = this._ensureLayer({
      id: hitbox,
      source,
      layout: { "line-sort-key": sortKey },
      paint: {
        "line-color": readMapColor("--basemap-paper") || "rgba(0, 0, 0, 0)",
        "line-opacity": 0.01,
        "line-width": byZoom(HITBOX_WIDTH),
      },
    });
    if (created || !this._handlers.has(hitbox)) {
      this._bindTripInteractions(layerName, hitbox);
    }
  },

  _drawSelection(suppressed, beforeId) {
    const selectedId = store.selectedTripId ? String(store.selectedTripId) : null;
    const selectedLayer = store.selectedTripLayer;
    const feature =
      !suppressed &&
      selectedId &&
      isTripLayer(selectedLayer) &&
      store.mapLayers[selectedLayer]?.visible
        ? this.getTripFeature(selectedLayer, selectedId, { lightweight: false })
        : null;
    if (!feature) {
      [SELECTED_CASING_ID, SELECTED_LAYER_ID].forEach((layerId) =>
        this._setVisibility(layerId, false)
      );
      return;
    }

    this._ensureSource(SELECTED_SOURCE_ID, { type: "FeatureCollection", features: [feature] });
    const width = byZoom(SELECTED_WIDTH);
    // Over the warm heat scale the chosen trip prints in the cool trip ink;
    // over blue paths it prints in the page ink.
    const ink = this._drawsHeat(selectedLayer)
      ? readMapColor("--map-trip-path")
      : MapStyles.MAP_LAYER_COLORS?.trips?.selected;
    // A paper-coloured casing lifts the chosen trip off every road beneath it.
    this._ensureLayer(
      {
        id: SELECTED_CASING_ID,
        source: SELECTED_SOURCE_ID,
        paint: {
          "line-color": readMapColor("--basemap-paper"),
          "line-width": byZoom(SELECTED_WIDTH.map(([zoom, value]) => [zoom, value + 3])),
          "line-opacity": 0.9,
        },
      },
      beforeId
    );
    this._ensureLayer(
      {
        id: SELECTED_LAYER_ID,
        source: SELECTED_SOURCE_ID,
        paint: {
          "line-color": ink,
          "line-width": width,
          "line-opacity": 1,
        },
      },
      beforeId
    );
  },

  _removeHandlers(layerId) {
    const record = this._handlers.get(layerId);
    this._handlers.delete(layerId);
    if (!record || !store.map?.off) {
      return;
    }
    Object.entries(record).forEach(([eventName, handler]) => {
      try {
        store.map.off(eventName, layerId, handler);
      } catch {
        // The map may already have dropped the layer.
      }
    });
  },

  _bindTripInteractions(layerName, hitboxLayerId) {
    if (!store.map?.on) {
      return;
    }
    this._removeHandlers(hitboxLayerId);

    const click = (event) => {
      if (
        typeof event?.originalEvent?.button === "number" &&
        event.originalEvent.button !== 0
      ) {
        return;
      }
      if (store.map?.isMoving?.()) {
        return;
      }
      if (layerName === "trips" && store.map.getLayer?.("matchedTrips-hitbox")) {
        const matchedHits = store.map.queryRenderedFeatures?.(event.point, {
          layers: ["matchedTrips-hitbox"],
        });
        if (matchedHits?.length > 0) {
          return;
        }
      }
      const tripId = event?.features?.[0]?.properties?.transactionId;
      const feature = tripId
        ? this.getTripFeature(layerName, tripId, { lightweight: false })
        : null;
      if (!feature) {
        return;
      }
      event.originalEvent?.stopPropagation?.();
      store._lastTripMapPickTs = Date.now();
      tripInteractions.handleTripClick(event, feature, layerName, { closeOnClick: false });
    };

    const enter = () => {
      const canvas = store.map?.getCanvas?.();
      if (canvas?.style) {
        canvas.style.cursor = "pointer";
      }
    };

    const move = (event) => {
      if (!this._drawsHeat(layerName) || store.map?.isMoving?.()) {
        this._hideHeatTip();
        return;
      }
      const count = event?.features?.[0]?.properties?.n;
      if (!count) {
        this._hideHeatTip();
        return;
      }
      this._showHeatTip(event.lngLat, describeRoadTrips(count));
    };

    const leave = () => {
      const canvas = store.map?.getCanvas?.();
      if (canvas?.style) {
        canvas.style.cursor = "";
      }
      this._hideHeatTip();
    };

    store.map.on("click", hitboxLayerId, click);
    store.map.on("mouseenter", hitboxLayerId, enter);
    store.map.on("mousemove", hitboxLayerId, move);
    store.map.on("mouseleave", hitboxLayerId, leave);
    this._handlers.set(hitboxLayerId, {
      click,
      mouseenter: enter,
      mousemove: move,
      mouseleave: leave,
    });
  },

  _showHeatTip(lngLat, text) {
    const Popup = globalThis.mapboxgl?.Popup;
    if (!Popup || !lngLat) {
      return;
    }
    this._heatTip ||= new Popup({
      closeButton: false,
      closeOnClick: false,
      className: "trip-heat-tip",
      offset: 12,
      anchor: "bottom",
    });
    this._heatTip.setLngLat(lngLat).setText(text);
    if (!this._heatTip.isOpen?.()) {
      this._heatTip.addTo(store.map);
    }
  },

  _hideHeatTip() {
    this._heatTip?.remove();
  },

  /**
   * What the heat colours mean for the legend: the five inks and the trip
   * counts at each end and the middle of the (logarithmic) scale.
   */
  getHeatLegend(layerName = "trips") {
    const reference = this.layers.get(layerName)?.heat?.reference;
    if (!reference) {
      return { inks: this.heatInks(), ticks: [] };
    }
    const middle = Math.max(2, Math.round(Math.sqrt(reference)));
    const ticks = [1, middle, reference].filter(
      (value, index, list) => list.indexOf(value) === index
    );
    return {
      inks: this.heatInks(),
      ticks: ticks.map((value, index) =>
        index === ticks.length - 1 && ticks.length > 1
          ? `${value.toLocaleString()}+`
          : value.toLocaleString()
      ),
    };
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

  getBundleBounds(layerName = "trips") {
    const layerState = this.layers.get(layerName);
    const decodedBounds = boundsFromDecoded(layerState?.decoded);
    if (isFiniteBbox(decodedBounds)) {
      return decodedBounds.map(Number);
    }
    if (
      Number(layerState?.bundle?.trip_count || layerState?.bundle?.trips?.length || 0) <= 0
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
    const { positions, startIndices } = layerState.decoded;
    if (!(layerState.pathIndicesByTrip instanceof Map)) {
      layerState.pathIndicesByTrip = indexDecodedPathsByTrip(layerState.decoded);
    }
    return (layerState.pathIndicesByTrip.get(match.index) || [])
      .map((pathIndex) =>
        sliceCoordinates(positions, startIndices[pathIndex], startIndices[pathIndex + 1] - 1)
      )
      .filter((path) => path.length >= 2);
  },

  getTripFeature(layerName, tripId, { lightweight = true } = {}) {
    const layerState = this.layers.get(layerName);
    const trip = layerState?.tripById?.get(String(tripId))?.trip;
    if (!trip) {
      return null;
    }
    const paths = lightweight ? [] : this.getTripPaths(layerName, tripId);
    if (!lightweight && !paths.length) {
      return null;
    }
    layerState.recency ||= recencyScale(layerState.bundle?.trips || []);
    const geometry =
      paths.length > 1
        ? { type: "MultiLineString", coordinates: paths }
        : { type: "LineString", coordinates: paths[0] || [] };
    return {
      type: "Feature",
      id: normalizeTripId(trip),
      source: layerName,
      geometry,
      properties: toTripProperties(trip, layerName, layerState.recency(trip)),
    };
  },

  getFeatureCollection(layerName) {
    const layerState = this.layers.get(layerName);
    if (!layerState) {
      return { type: "FeatureCollection", features: [] };
    }
    if (!layerState.featureCollection) {
      const features = (layerState.bundle?.trips || [])
        .map((trip) =>
          this.getTripFeature(layerName, normalizeTripId(trip), { lightweight: false })
        )
        .filter(Boolean);
      layerState.featureCollection = { type: "FeatureCollection", features };
    }
    return layerState.featureCollection;
  },

  /** One feature per run of similar frequency: `h` is heat 0 to 1, `n` trips. */
  getHeatCollection(layerName) {
    const layerState = this.layers.get(layerName);
    const heat = layerState?.heat;
    if (!heat) {
      return { type: "FeatureCollection", features: [] };
    }
    if (!layerState.heatCollection) {
      const { positions, tripIndices } = layerState.decoded;
      const trips = layerState.bundle?.trips || [];
      const features = new Array(heat.length);
      for (let run = 0; run < heat.length; run += 1) {
        const frequency = heat.frequencies[run];
        features[run] = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: sliceCoordinates(positions, heat.starts[run], heat.ends[run]),
          },
          properties: {
            transactionId: normalizeTripId(trips[tripIndices[heat.paths[run]]]),
            n: frequency,
            h: Math.round(heatLevel(frequency, heat.reference) * 1000) / 1000,
          },
        };
      }
      layerState.heatCollection = { type: "FeatureCollection", features };
    }
    return layerState.heatCollection;
  },

  getRenderableFeatures() {
    return TRIP_LAYER_NAMES.flatMap(
      (layerName) => this.getFeatureCollection(layerName).features || []
    );
  },

  clearLayer(layerName) {
    this.layers.delete(layerName);
    if (store.mapLayers[layerName]) {
      store.mapLayers[layerName].layer = null;
    }
    const ids = layerIds(layerName);
    if (store.map) {
      [ids.hitbox, ids.paths, ids.heat, ids.heatGlow].forEach((layerId) => {
        this._removeHandlers(layerId);
        if (store.map.getLayer?.(layerId)) {
          store.map.removeLayer(layerId);
        }
      });
      [ids.source, ids.heatSource].forEach((sourceId) => {
        if (store.map.getSource?.(sourceId)) {
          store.map.removeSource(sourceId);
        }
        this._sourceData.delete(sourceId);
      });
    }
    this.render();
  },
};

export default tripMapRenderer;
