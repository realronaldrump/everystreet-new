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
}

test.beforeEach(() => {
  resetRenderer();
  globalThis.document = createEventTarget();
});

test.afterEach(() => {
  resetRenderer();
  store.map = null;
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
