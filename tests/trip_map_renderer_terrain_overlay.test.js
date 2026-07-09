import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import { MAP_TERRAIN_RELIEF_APPLIED_EVENT } from "../static/js/modules/features/map/terrain-relief.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";
import { createEventTarget } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  deck: globalThis.deck,
  document: globalThis.document,
  window: globalThis.window,
};
const originalTripLayer = structuredClone(store.mapLayers.trips);

function createOverlayClass(constructed) {
  return class MapboxOverlay {
    constructor(props) {
      this.props = props;
      constructed.push(this);
    }
    setProps(props) {
      this.props = { ...this.props, ...props };
    }
  };
}

function createMapMock(events) {
  return {
    addControl(control) {
      events.push({ type: "addControl", control });
    },
    removeControl(control) {
      events.push({ type: "removeControl", control });
    },
    getStyle() {
      return { layers: [] };
    },
    getLayer() {
      return null;
    },
  };
}

function createNativeMapMock(events) {
  const sources = new Map();
  const layers = new Map();
  return {
    addSource(id, source) {
      const record = {
        ...source,
        setData(data) {
          record.data = data;
        },
      };
      sources.set(id, record);
      events.push({ type: "addSource", id });
    },
    getSource(id) {
      return sources.get(id) || null;
    },
    removeSource(id) {
      sources.delete(id);
      events.push({ type: "removeSource", id });
    },
    addLayer(layer) {
      layers.set(layer.id, { ...layer });
      events.push({ type: "addLayer", id: layer.id });
    },
    getLayer(id) {
      return layers.get(id) || null;
    },
    removeLayer(id) {
      layers.delete(id);
      events.push({ type: "removeLayer", id });
    },
    setPaintProperty(id, property, value) {
      const layer = layers.get(id);
      if (layer) {
        layer.paint = { ...(layer.paint || {}), [property]: value };
      }
    },
    setLayoutProperty(id, property, value) {
      const layer = layers.get(id);
      if (layer) {
        layer.layout = { ...(layer.layout || {}), [property]: value };
      }
    },
    getStyle() {
      return { layers: [] };
    },
    on(eventName, layerId, handler) {
      events.push({ type: "on", eventName, layerId, handler });
    },
    off(eventName, layerId, handler) {
      events.push({ type: "off", eventName, layerId, handler });
    },
    getCanvas() {
      return { style: {} };
    },
  };
}

function resetRenderer() {
  tripMapRenderer.overlay = null;
  tripMapRenderer.terrainActive = false;
  tripMapRenderer._terrainListenerBound = false;
  tripMapRenderer.layers.clear();
  tripMapRenderer._suppressedBy.clear();
  tripMapRenderer._nativeHandlers.clear();
  tripMapRenderer._nativeRendered = false;
}

test.beforeEach(() => {
  resetRenderer();
  globalThis.document = createEventTarget();
});

test.afterEach(() => {
  resetRenderer();
  store.map = null;
  store.mapLayers.trips = structuredClone(originalTripLayer);
  globalThis.deck = originalGlobals.deck;
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
});

test("trip overlay uses interleaved rendering when terrain is inactive", () => {
  const constructed = [];
  const events = [];
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createMapMock(events);

  const overlay = tripMapRenderer.ensureOverlay();

  assert.equal(constructed.length, 1);
  assert.equal(overlay.props.interleaved, true);
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["addControl"]
  );
});

test("enabling terrain keeps the trip overlay interleaved with the map", () => {
  const constructed = [];
  const events = [];
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createMapMock(events);

  const interleavedOverlay = tripMapRenderer.ensureOverlay();
  assert.equal(interleavedOverlay.props.interleaved, true);

  globalThis.document.dispatch(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
    detail: { active: true },
  });

  assert.equal(constructed.length, 1);
  assert.equal(tripMapRenderer.overlay, interleavedOverlay);
  assert.equal(tripMapRenderer.overlay.props.interleaved, true);

  assert.deepEqual(
    events.map((entry) => entry.type),
    ["addControl"]
  );
});

test("disabling terrain does not rebuild the interleaved trip overlay", () => {
  const constructed = [];
  const events = [];
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createMapMock(events);

  tripMapRenderer.ensureOverlay();
  globalThis.document.dispatch(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
    detail: { active: true },
  });
  assert.equal(tripMapRenderer.overlay.props.interleaved, true);

  globalThis.document.dispatch(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
    detail: { active: false },
  });
  assert.equal(tripMapRenderer.overlay.props.interleaved, true);
  assert.equal(constructed.length, 1);
});

test("redundant terrain events do not rebuild the trip overlay", () => {
  const constructed = [];
  const events = [];
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createMapMock(events);

  tripMapRenderer.ensureOverlay();
  globalThis.document.dispatch(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
    detail: { active: false },
  });

  assert.equal(constructed.length, 1);
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["addControl"]
  );
});

test("trip layer suppression clears and restores deck trip paths", () => {
  const constructed = [];
  const events = [];
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {
      constructor(props) {
        this.props = props;
      }
    },
  };
  store.map = createMapMock(events);
  store.mapLayers.trips = {
    ...structuredClone(originalTripLayer),
    visible: true,
    isHeatmap: false,
    color: "#d4943c",
    weight: 2,
    opacity: 1,
  };
  tripMapRenderer.layers.set("trips", {
    bundle: { trips: [{ id: "trip-1" }] },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.75, 30.25, -97.71, 30.29]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map([["trip-1", { trip: { id: "trip-1" }, index: 0 }]]),
    featureCollection: null,
  });

  tripMapRenderer.render();
  assert.deepEqual(
    tripMapRenderer.overlay.props.layers.map((layer) => layer.props.id),
    ["trips-trip-map-line"]
  );

  tripMapRenderer.suppressTripLayers("particle-flow");
  assert.deepEqual(tripMapRenderer.overlay.props.layers, []);

  tripMapRenderer.render();
  assert.deepEqual(tripMapRenderer.overlay.props.layers, []);

  tripMapRenderer.restoreTripLayers("particle-flow");
  assert.deepEqual(
    tripMapRenderer.overlay.props.layers.map((layer) => layer.props.id),
    ["trips-trip-map-line"]
  );
});

test("google provider renders trip bundles as native map layers", () => {
  const constructed = [];
  const events = [];
  globalThis.window = { MAP_PROVIDER: "google" };
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createNativeMapMock(events);
  store.mapLayers.trips = {
    ...structuredClone(originalTripLayer),
    visible: true,
    isHeatmap: false,
    color: "#d4943c",
    weight: 2,
    opacity: 1,
  };
  tripMapRenderer.layers.set("trips", {
    bundle: { trips: [{ id: "trip-1" }] },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.75, 30.25, -97.71, 30.29]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map([["trip-1", { trip: { id: "trip-1" }, index: 0 }]]),
    featureCollection: null,
  });

  tripMapRenderer.render();

  assert.equal(constructed.length, 0);
  assert.ok(store.map.getSource("trips-source"));
  assert.ok(store.map.getLayer("trips-layer"));
  assert.ok(store.map.getLayer("trips-hitbox"));
  assert.deepEqual(
    events.filter((entry) => entry.type === "addLayer").map((entry) => entry.id),
    ["trips-layer", "trips-hitbox"]
  );
});

test("switching to plain paths detaches deck and uses native Mapbox lines", () => {
  const constructed = [];
  const events = [];
  globalThis.window = { MAP_PROVIDER: "self_hosted" };
  globalThis.deck = {
    MapboxOverlay: createOverlayClass(constructed),
    PathLayer: class PathLayer {},
  };
  store.map = createNativeMapMock(events);
  store.map.addControl = (control) => {
    events.push({ type: "addControl", control });
  };
  store.map.removeControl = (control) => {
    events.push({ type: "removeControl", control });
  };
  store.mapLayers.trips = {
    ...structuredClone(originalTripLayer),
    visible: true,
    isHeatmap: true,
    color: "#3d9be9",
    weight: 2,
    opacity: 1,
  };
  tripMapRenderer.layers.set("trips", {
    bundle: { trips: [{ id: "trip-1" }] },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.75, 30.25, -97.71, 30.29]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map([["trip-1", { trip: { id: "trip-1" }, index: 0 }]]),
    featureCollection: null,
  });

  tripMapRenderer.render();
  assert.equal(constructed.length, 1);

  store.mapLayers.trips.isHeatmap = false;
  tripMapRenderer.render();

  assert.equal(tripMapRenderer.overlay, null);
  assert.ok(store.map.getSource("trips-source"));
  assert.ok(store.map.getLayer("trips-layer"));
});
