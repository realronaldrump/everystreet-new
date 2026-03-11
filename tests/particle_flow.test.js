import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import particleFlow from "../static/js/modules/particle-flow.js";
import {
  createCustomEventClass,
  createEventTarget,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  CustomEvent: global.CustomEvent,
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
  devicePixelRatio: global.devicePixelRatio,
};

const originalStore = {
  map: store.map,
  mapLayers: store.mapLayers,
  selectedTripId: store.selectedTripId,
  selectedTripLayer: store.selectedTripLayer,
};

function createCanvasContextSpy() {
  return {
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    set fillStyle(_) {},
    set strokeStyle(_) {},
    set lineWidth(_) {},
    set lineCap(_) {},
    set lineJoin(_) {},
    set globalCompositeOperation(_) {},
  };
}

function createDomNode({ tagName = "div", context = null } = {}) {
  return {
    ...createEventTarget(),
    tagName,
    style: {},
    className: "",
    width: 800,
    height: 600,
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((candidate) => candidate !== child);
      child.parentNode = null;
      return child;
    },
    remove() {
      this.parentNode?.removeChild?.(this);
    },
    getContext() {
      return context;
    },
  };
}

function createDocumentMock() {
  const documentTarget = createEventTarget();
  return {
    ...documentTarget,
    createElement(tagName) {
      if (tagName === "canvas") {
        return createDomNode({ tagName, context: createCanvasContextSpy() });
      }
      return createDomNode({ tagName });
    },
  };
}

function createMapMock(container) {
  const listeners = new Map();
  const styleLayers = [
    { id: "trips-layer", layout: { visibility: "visible" } },
    { id: "matchedTrips-layer", layout: { visibility: "visible" } },
    { id: "trips-hitbox", layout: { visibility: "visible" } },
    { id: "matchedTrips-hitbox", layout: { visibility: "visible" } },
  ];

  return {
    layoutUpdates: [],
    on(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      handlers.push(handler);
      listeners.set(eventName, handlers);
    },
    off(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        handlers.filter((candidate) => candidate !== handler)
      );
    },
    getCanvasContainer() {
      return container;
    },
    getCanvas() {
      return { width: 800, height: 600 };
    },
    project([lng, lat]) {
      return { x: lng * 12 + 120, y: lat * -10 + 180 };
    },
    getZoom() {
      return 12;
    },
    getStyle() {
      return { layers: styleLayers };
    },
    getLayoutProperty(id, property) {
      const layer = styleLayers.find((entry) => entry.id === id);
      return layer?.layout?.[property];
    },
    setLayoutProperty(id, property, value) {
      this.layoutUpdates.push({ id, property, value });
      const layer = styleLayers.find((entry) => entry.id === id);
      if (layer) {
        layer.layout = { ...(layer.layout || {}), [property]: value };
      }
    },
    getLayer(id) {
      return styleLayers.find((entry) => entry.id === id) || null;
    },
  };
}

test.beforeEach(() => {
  global.CustomEvent = createCustomEventClass();
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.devicePixelRatio = 1;
});

test.afterEach(() => {
  particleFlow.destroy();
  store.map = originalStore.map;
  store.mapLayers = originalStore.mapLayers;
  store.selectedTripId = originalStore.selectedTripId;
  store.selectedTripLayer = originalStore.selectedTripLayer;
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.CustomEvent = originalGlobals.CustomEvent;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
  global.devicePixelRatio = originalGlobals.devicePixelRatio;
});

test("particle flow keeps trip layers hidden across repeated repair passes", () => {
  const documentMock = createDocumentMock();
  const container = createDomNode();
  const map = createMapMock(container);

  global.document = documentMock;
  global.window = {};

  store.map = map;
  store.selectedTripId = "trip-1";
  store.selectedTripLayer = "trips";
  store.mapLayers = {
    trips: {
      visible: true,
      layer: {
        features: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [-97.75, 30.25],
                [-97.71, 30.29],
              ],
            },
          },
        ],
      },
    },
    matchedTrips: {
      visible: false,
      layer: { features: [] },
    },
  };

  particleFlow.activate();
  assert.equal(store.selectedTripId, null);
  assert.equal(store.selectedTripLayer, null);
  map.layoutUpdates = [];

  const tripLayer = map.getStyle().layers.find((layer) => layer.id === "trips-layer");
  tripLayer.layout.visibility = "visible";

  particleFlow.ensureTripLayersHidden();
  particleFlow.destroy();

  assert.deepEqual(
    map.layoutUpdates.map(({ id, value }) => ({ id, value })),
    [
      { id: "trips-layer", value: "none" },
      { id: "trips-hitbox", value: "none" },
      { id: "trips-layer", value: "visible" },
      { id: "matchedTrips-layer", value: "visible" },
      { id: "trips-hitbox", value: "visible" },
      { id: "matchedTrips-hitbox", value: "visible" },
    ]
  );
});
