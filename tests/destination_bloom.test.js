import assert from "node:assert/strict";
import test from "node:test";

import destinationBloom, {
  clusterDestinationPoints,
  collectDestinationPoints,
  getDestinationPointFromGeometry,
  radiusForCluster,
} from "../static/js/modules/destination-bloom.js";
import store from "../static/js/modules/core/store.js";
import {
  createClassList,
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  localStorage: global.localStorage,
  CustomEvent: global.CustomEvent,
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
};

const originalStore = {
  map: store.map,
  mapLayers: store.mapLayers,
};

function createCanvasContextSpy() {
  return {
    clearRectCalls: 0,
    arcs: [],
    gradients: [],
    clearRect() {
      this.clearRectCalls += 1;
    },
    beginPath() {},
    arc(x, y, radius) {
      this.arcs.push({ x, y, radius });
    },
    fill() {},
    fillText() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    createRadialGradient(...args) {
      const gradient = {
        args,
        stops: [],
        addColorStop(offset, color) {
          this.stops.push({ offset, color });
        },
      };
      this.gradients.push(gradient);
      return gradient;
    },
    set fillStyle(_) {},
    set strokeStyle(_) {},
    set globalCompositeOperation(_) {},
  };
}

function createDomNode({ tagName = "div", context = null } = {}) {
  const eventTarget = createEventTarget();
  return {
    ...eventTarget,
    tagName,
    style: {},
    className: "",
    classList: createClassList(),
    children: [],
    parentNode: null,
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
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
    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        width: this.clientWidth,
        height: this.clientHeight,
      };
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    getContext() {
      return context;
    },
  };
}

function createDocumentMock() {
  const documentTarget = createEventTarget();
  const contexts = [];

  const documentMock = {
    ...documentTarget,
    createElement(tagName) {
      if (tagName === "canvas") {
        const context = createCanvasContextSpy();
        contexts.push(context);
        return createDomNode({ tagName, context });
      }
      return createDomNode({ tagName });
    },
    getElementById() {
      return null;
    },
    body: createDomNode(),
  };

  return { documentMock, contexts };
}

function createMapMock(container) {
  const listeners = new Map();
  const mapCanvas = createDomNode({ tagName: "canvas" });
  mapCanvas.width = 1600;
  mapCanvas.height = 1200;
  mapCanvas.clientWidth = 800;
  mapCanvas.clientHeight = 600;
  const styleLayers = [
    { id: "trips-layer", layout: { visibility: "visible" } },
    { id: "matchedTrips-layer", layout: { visibility: "visible" } },
    { id: "trips-hitbox", layout: { visibility: "visible" } },
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
      return mapCanvas;
    },
    project([lng, lat]) {
      return {
        x: (lng + 100) * 120,
        y: (35 - lat) * 90,
      };
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
  global.localStorage = createStorageMock();
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
});

test.afterEach(() => {
  destinationBloom.destroy();
  store.map = originalStore.map;
  store.mapLayers = originalStore.mapLayers;
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
  global.CustomEvent = originalGlobals.CustomEvent;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
});

test("extracts destination endpoints from line and multiline geometries", () => {
  assert.deepEqual(
    getDestinationPointFromGeometry({
      type: "LineString",
      coordinates: [
        [-97.1, 30.2],
        [-97.2, 30.3],
      ],
    }),
    [-97.2, 30.3]
  );

  assert.deepEqual(
    getDestinationPointFromGeometry({
      type: "MultiLineString",
      coordinates: [
        [[-97.1, 30.2]],
        [
          [-97.2, 30.3],
          [-97.4, 30.5],
        ],
      ],
    }),
    [-97.4, 30.5]
  );

  assert.equal(getDestinationPointFromGeometry({ type: "Point", coordinates: [0, 0] }), null);
});

test("collectDestinationPoints deduplicates by trip id and prefers matched trips", () => {
  const points = collectDestinationPoints({
    trips: {
      visible: true,
      layer: {
        features: [
          {
            id: "trip-1",
            geometry: {
              type: "LineString",
              coordinates: [
                [-97.74, 30.26],
                [-97.71, 30.29],
              ],
            },
            properties: {
              transactionId: "trip-1",
              destination: "North Loop",
            },
          },
        ],
      },
    },
    matchedTrips: {
      visible: true,
      layer: {
        features: [
          {
            id: "trip-1",
            geometry: {
              type: "LineString",
              coordinates: [
                [-97.74, 30.26],
                [-97.69, 30.31],
              ],
            },
            properties: {
              transactionId: "trip-1",
              destination: "North Loop",
            },
          },
        ],
      },
    },
  });

  assert.equal(points.length, 1);
  assert.deepEqual(points[0].coordinates, [-97.69, 30.31]);
  assert.equal(points[0].layerName, "matchedTrips");
});

test("clusterDestinationPoints separates clusters as zoom increases and scales radius by count", () => {
  const sharedPoints = [
    { x: 100, y: 100, coordinates: [-97.7, 30.2], label: "A", lastArrival: null },
    { x: 138, y: 108, coordinates: [-97.7005, 30.2004], label: "A", lastArrival: null },
  ];

  assert.equal(clusterDestinationPoints(sharedPoints, { zoom: 4 }).length, 1);
  assert.equal(clusterDestinationPoints(sharedPoints, { zoom: 14 }).length, 2);
  assert.ok(radiusForCluster(16, 12) > radiusForCluster(1, 12));
});

test("destination bloom hides trip layers on activate and restores them on destroy", () => {
  const { documentMock, contexts } = createDocumentMock();
  const container = createDomNode();
  const map = createMapMock(container);

  global.document = documentMock;
  global.window = {
    devicePixelRatio: 1,
    matchMedia(query) {
      return { matches: query === "(prefers-reduced-motion: reduce)" };
    },
  };

  store.map = map;
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
            properties: {
              transactionId: "trip-1",
              destination: "South Congress",
              endTime: "2026-03-10T18:00:00Z",
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

  destinationBloom.activate();

  assert.equal(container.children.some((child) => child.className === "destination-bloom-canvas"), true);
  assert.equal(
    map.layoutUpdates.some(
      (update) => update.id === "trips-layer" && update.value === "none"
    ),
    true
  );
  assert.ok(contexts[0].clearRectCalls >= 1);

  destinationBloom.destroy();

  assert.equal(
    map.layoutUpdates.some(
      (update) => update.id === "trips-layer" && update.value === "visible"
    ),
    true
  );
  assert.equal(container.children.length, 0);
});

test("destination bloom keeps trip layers hidden across repeated repair passes", () => {
  const { documentMock } = createDocumentMock();
  const container = createDomNode();
  const map = createMapMock(container);

  global.document = documentMock;
  global.window = {};

  store.map = map;
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
            properties: {
              transactionId: "trip-1",
              destination: "South Congress",
              endTime: "2026-03-10T18:00:00Z",
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

  destinationBloom.activate();
  map.layoutUpdates = [];

  const tripLayer = map.getStyle().layers.find((layer) => layer.id === "trips-layer");
  tripLayer.layout.visibility = "visible";

  destinationBloom.ensureTripLayersHidden();
  destinationBloom.destroy();

  assert.deepEqual(
    map.layoutUpdates.map(({ id, value }) => ({ id, value })),
    [
      { id: "trips-layer", value: "none" },
      { id: "trips-layer", value: "visible" },
      { id: "matchedTrips-layer", value: "visible" },
    ]
  );
});

test("destination bloom sizes its canvas from the map canvas dimensions", () => {
  const { documentMock } = createDocumentMock();
  const container = createDomNode();
  const map = createMapMock(container);
  container.clientHeight = 1;

  global.document = documentMock;
  global.window = {
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: true };
    },
  };

  store.map = map;
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
            properties: {
              transactionId: "trip-1",
              destination: "South Congress",
              endTime: "2026-03-10T18:00:00Z",
            },
          },
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [-97.79, 30.21],
                [-97.66, 30.34],
              ],
            },
            properties: {
              transactionId: "trip-2",
              destination: "Mueller",
              endTime: "2026-03-09T18:00:00Z",
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

  destinationBloom.activate();

  assert.equal(destinationBloom._canvas?.width, 1600);
  assert.equal(destinationBloom._canvas?.height, 1200);
  assert.equal(destinationBloom._canvas?.style.width, "800px");
  assert.equal(destinationBloom._canvas?.style.height, "600px");
});

test("destination bloom uses the map canvas rect for tooltip pointer positioning", () => {
  const { documentMock } = createDocumentMock();
  const container = createDomNode();
  const map = createMapMock(container);
  container.clientHeight = 0;

  global.document = documentMock;
  global.window = {
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: true };
    },
  };

  store.map = map;
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
            properties: {
              transactionId: "trip-1",
              destination: "South Congress",
              endTime: "2026-03-10T18:00:00Z",
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

  destinationBloom.activate();

  const pointer = destinationBloom._getPointerPosition({
    clientX: 120,
    clientY: 140,
  });

  assert.equal(pointer?.x, 120);
  assert.equal(pointer?.y, 140);
  assert.equal(pointer?.width, 800);
  assert.equal(pointer?.height, 600);
});
