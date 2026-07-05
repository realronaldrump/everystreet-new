import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import { MAP_TERRAIN_RELIEF_APPLIED_EVENT } from "../static/js/modules/features/map/terrain-relief.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";
import { createEventTarget } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  deck: globalThis.deck,
  document: globalThis.document,
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

function resetRenderer() {
  tripMapRenderer.overlay = null;
  tripMapRenderer.terrainActive = false;
  tripMapRenderer._terrainListenerBound = false;
  tripMapRenderer.layers.clear();
  tripMapRenderer._suppressedBy.clear();
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

test("enabling terrain rebuilds the trip overlay in overlaid mode", () => {
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

  assert.equal(constructed.length, 2);
  const overlaidOverlay = tripMapRenderer.overlay;
  assert.equal(overlaidOverlay.props.interleaved, false);
  assert.notEqual(overlaidOverlay, interleavedOverlay);

  // The stale interleaved overlay must be detached from the map.
  assert.deepEqual(
    events.map((entry) => entry.type),
    ["addControl", "removeControl", "addControl"]
  );
  assert.equal(events[1].control, interleavedOverlay);
});

test("disabling terrain restores interleaved trip overlay rendering", () => {
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
  assert.equal(tripMapRenderer.overlay.props.interleaved, false);

  globalThis.document.dispatch(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
    detail: { active: false },
  });
  assert.equal(tripMapRenderer.overlay.props.interleaved, true);
  assert.equal(constructed.length, 3);
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
