import assert from "node:assert/strict";
import test from "node:test";

import mapCore from "../static/js/modules/map-core.js";
import initBuildings3D, {
  ensureBuildingsLayer,
  isSupportedMapbox3D,
} from "../static/js/modules/features/map/buildings-3d.js";
import { utils } from "../static/js/modules/utils.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  localStorage: global.localStorage,
};
const originalFetchWithRetry = utils.fetchWithRetry;

function createStorageMock() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createDocumentMock() {
  const listeners = new Map();
  return {
    getElementById() {
      return null;
    },
    addEventListener(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      handlers.push(handler);
      listeners.set(eventName, handlers);
    },
    removeEventListener(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        handlers.filter((candidate) => candidate !== handler)
      );
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event?.type || "") || [];
      handlers.forEach((handler) => handler(event));
      return true;
    },
  };
}

function createMockMap({ style }) {
  let activeStyle = style;
  const layers = new Map();

  const map = {
    addedLayers: [],
    movedLayers: [],
    removedLayers: [],
    filters: [],
    paintUpdates: [],
    getStyle() {
      return activeStyle;
    },
    setStyleData(nextStyle) {
      activeStyle = nextStyle;
      layers.clear();
    },
    addLayer(layerDefinition, beforeLayerId) {
      layers.set(layerDefinition.id, { ...layerDefinition });
      this.addedLayers.push({ layerDefinition, beforeLayerId });
      return this;
    },
    getLayer(id) {
      return layers.get(id) || null;
    },
    removeLayer(id) {
      layers.delete(id);
      this.removedLayers.push(id);
      return this;
    },
    moveLayer(id, beforeLayerId) {
      this.movedLayers.push({ id, beforeLayerId });
      return this;
    },
    setFilter(id, filter) {
      this.filters.push({ id, filter });
      return this;
    },
    setPaintProperty(id, property, value) {
      this.paintUpdates.push({ id, property, value });
      return this;
    },
  };

  return map;
}

function makeVectorStyle() {
  return {
    sources: {
      composite: { type: "vector" },
    },
    layers: [
      { id: "water", type: "fill" },
      { id: "road", type: "line" },
      {
        id: "road-label",
        type: "symbol",
        layout: { "text-field": ["get", "name"] },
      },
    ],
  };
}

function makeCoverageBoundaryFeatureCollection() {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-97.165, 31.535],
              [-97.165, 31.545],
              [-97.155, 31.545],
              [-97.155, 31.535],
              [-97.165, 31.535],
            ],
          ],
        },
      },
    ],
  };
}

async function flushMicrotasks(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

test.beforeEach(() => {
  global.window = {
    MAP_PROVIDER: "self_hosted",
  };
  global.document = createDocumentMock();
  global.localStorage = createStorageMock();
});

test.afterEach(() => {
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
  utils.fetchWithRetry = originalFetchWithRetry;
});

test("ensureBuildingsLayer adds a fill-extrusion layer on supported vector styles", () => {
  const map = createMockMap({ style: makeVectorStyle() });

  const added = ensureBuildingsLayer(map, { styleType: "dark" });

  assert.equal(added, true);
  assert.equal(map.addedLayers.length, 1);
  assert.equal(map.addedLayers[0].beforeLayerId, "road-label");
  assert.equal(map.addedLayers[0].layerDefinition.type, "fill-extrusion");
  assert.equal(map.addedLayers[0].layerDefinition.source, "composite");
  assert.equal(map.addedLayers[0].layerDefinition["source-layer"], "building");
  assert.ok(map.getLayer("es-3d-buildings"));
});

test("ensureBuildingsLayer skips satellite mode and raster-only styles", () => {
  const map = createMockMap({
    style: {
      sources: {
        "mapbox-satellite": { type: "raster" },
      },
      layers: [{ id: "satellite-base", type: "raster" }],
    },
  });

  const added = ensureBuildingsLayer(map, { styleType: "satellite" });

  assert.equal(added, false);
  assert.equal(map.addedLayers.length, 0);
});

test("ensureBuildingsLayer remains enabled on mobile viewport/coarse pointer", () => {
  global.window = {
    MAP_PROVIDER: "self_hosted",
    innerWidth: 390,
    matchMedia(query) {
      if (query === "(pointer: coarse)") {
        return { matches: true };
      }
      return { matches: false };
    },
  };

  const map = createMockMap({ style: makeVectorStyle() });

  const added = ensureBuildingsLayer(map, { styleType: "dark" });

  assert.equal(added, true);
  assert.equal(map.addedLayers.length, 1);
  assert.ok(map.getLayer("es-3d-buildings"));
});

test("ensureBuildingsLayer can scope 3D buildings to a selected coverage boundary", () => {
  const map = createMockMap({ style: makeVectorStyle() });
  const coverageBoundary = makeCoverageBoundaryFeatureCollection().features[0].geometry;

  const added = ensureBuildingsLayer(map, {
    styleType: "dark",
    coverageBoundary,
  });

  assert.equal(added, true);
  const layerFilter = map.addedLayers[0].layerDefinition.filter;
  assert.equal(layerFilter[0], "within");
  assert.deepEqual(layerFilter[1], coverageBoundary);
});

test("initBuildings3D re-applies buildings after style-change callbacks", async () => {
  const map = createMockMap({ style: makeVectorStyle() });

  const originalRegister = mapCore.registerStyleChangeHandler;
  const originalUnregister = mapCore.unregisterStyleChangeHandler;

  let capturedRef = null;
  let capturedHandler = null;
  let unregisterCalledWith = null;

  mapCore.registerStyleChangeHandler = (priority, handler) => {
    capturedRef = { priority, handler };
    capturedHandler = handler;
    return capturedRef;
  };

  mapCore.unregisterStyleChangeHandler = (ref) => {
    unregisterCalledWith = ref;
  };

  try {
    const controller = initBuildings3D({ map });
    assert.equal(map.addedLayers.length, 1);

    map.setStyleData(makeVectorStyle());
    await capturedHandler("dark");
    assert.equal(map.addedLayers.length, 2);

    controller.destroy();
    assert.equal(unregisterCalledWith, capturedRef);
  } finally {
    mapCore.registerStyleChangeHandler = originalRegister;
    mapCore.unregisterStyleChangeHandler = originalUnregister;
  }
});

test("isSupportedMapbox3D and ensureBuildingsLayer no-op for Google provider", () => {
  global.window = {
    MAP_PROVIDER: "google",
  };

  const map = createMockMap({ style: makeVectorStyle() });

  assert.equal(isSupportedMapbox3D(map, { styleType: "dark" }), false);
  assert.equal(ensureBuildingsLayer(map, { styleType: "dark" }), false);
  assert.equal(map.addedLayers.length, 0);
});

test("ensureBuildingsLayer honors disabled user preference from storage", () => {
  global.localStorage.setItem("map3dBuildingsEnabled", "false");
  const map = createMockMap({ style: makeVectorStyle() });

  assert.equal(isSupportedMapbox3D(map, { styleType: "dark" }), false);
  assert.equal(ensureBuildingsLayer(map, { styleType: "dark" }), false);
  assert.equal(map.addedLayers.length, 0);
});

test("initBuildings3D responds to settings toggle event", () => {
  const map = createMockMap({ style: makeVectorStyle() });
  const controller = initBuildings3D({ map });

  assert.equal(map.addedLayers.length, 1);
  assert.ok(map.getLayer("es-3d-buildings"));

  global.document.dispatchEvent({
    type: "es:map-3d-buildings-setting-changed",
    detail: { enabled: false },
  });
  assert.equal(map.getLayer("es-3d-buildings"), null);
  assert.ok(map.removedLayers.includes("es-3d-buildings"));

  global.document.dispatchEvent({
    type: "es:map-3d-buildings-setting-changed",
    detail: { enabled: true },
  });
  assert.ok(map.getLayer("es-3d-buildings"));
  assert.equal(map.addedLayers.length, 2);

  controller.destroy();
});

test("initBuildings3D scopes existing buildings layer when coverage selection changes", async () => {
  const map = createMockMap({ style: makeVectorStyle() });
  utils.fetchWithRetry = async () => ({
    boundary: makeCoverageBoundaryFeatureCollection().features[0].geometry,
  });

  const controller = initBuildings3D({ map });

  global.document.dispatchEvent({
    type: "es:coverage-area-selection-changed",
    detail: { areaId: "waco-area" },
  });
  await flushMicrotasks();

  const scopedFilter = map.filters.find(
    (entry) =>
      Array.isArray(entry?.filter) &&
      entry.filter[0] === "within"
  );
  assert.ok(scopedFilter);
  assert.ok(["Polygon", "MultiPolygon"].includes(scopedFilter.filter[1]?.type));

  controller.destroy();
});
