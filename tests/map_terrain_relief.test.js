import assert from "node:assert/strict";
import test from "node:test";

import initTerrainRelief, {
  ensureTerrainRelief,
  getTerrainReliefPreference,
  isMapboxTerrainReliefSupported,
  isTerrainReliefApplied,
  isTerrainReliefSupported,
  setTerrainReliefPreference,
} from "../static/js/modules/features/map/terrain-relief.js";
import mapCore from "../static/js/modules/map-core.js";
import {
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  CustomEvent: global.CustomEvent,
  window: global.window,
  document: global.document,
  localStorage: global.localStorage,
};

function createDocumentMock(elements = {}) {
  return {
    ...createEventTarget(),
    getElementById(id) {
      return elements[id] || null;
    },
  };
}

function makeStyle() {
  return {
    sources: {
      composite: { type: "vector" },
    },
    layers: [
      { id: "land", type: "fill" },
      { id: "road-line", type: "line" },
      { id: "road-label", type: "symbol", layout: { "text-field": "Road" } },
    ],
  };
}

function createMockMap({ style = makeStyle() } = {}) {
  let activeStyle = style;
  const sources = new Map();
  const layers = new Map();

  return {
    addedSources: [],
    addedLayers: [],
    removedSources: [],
    removedLayers: [],
    paintUpdates: [],
    terrainCalls: [],
    getStyle() {
      return activeStyle;
    },
    setStyleData(nextStyle) {
      activeStyle = nextStyle;
      sources.clear();
      layers.clear();
    },
    addSource(id, source) {
      sources.set(id, { ...source });
      this.addedSources.push({ id, source });
      return this;
    },
    getSource(id) {
      return sources.get(id) || null;
    },
    removeSource(id) {
      sources.delete(id);
      this.removedSources.push(id);
      return this;
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
    setPaintProperty(id, property, value) {
      this.paintUpdates.push({ id, property, value });
      return this;
    },
    setTerrain(value) {
      this.terrainCalls.push(value);
      return this;
    },
  };
}

test.beforeEach(() => {
  global.window = {
    MAP_PROVIDER: "self_hosted",
    APP_SETTINGS_FLAGS: {},
  };
  global.document = createDocumentMock();
  global.CustomEvent = createCustomEventClass();
  global.localStorage = createStorageMock();
});

test.afterEach(() => {
  global.CustomEvent = originalGlobals.CustomEvent;
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
});

test("terrain relief defaults off and does not add Mapbox terrain layers", () => {
  const map = createMockMap();

  assert.equal(getTerrainReliefPreference(), false);
  assert.equal(isMapboxTerrainReliefSupported(map), true);
  assert.equal(ensureTerrainRelief(map, { styleType: "dark" }), false);
  assert.equal(map.addedSources.length, 0);
  assert.equal(map.addedLayers.length, 0);
});

test("ensureTerrainRelief adds DEM source, terrain, and hillshade when enabled", () => {
  const map = createMockMap();
  setTerrainReliefPreference(true);

  const applied = ensureTerrainRelief(map, { styleType: "streets" });

  assert.equal(applied, true);
  assert.equal(map.addedSources.length, 1);
  assert.equal(map.addedSources[0].id, "es-mapbox-dem");
  assert.deepEqual(map.addedSources[0].source, {
    type: "raster-dem",
    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14,
  });
  assert.deepEqual(map.terrainCalls.at(-1), {
    source: "es-mapbox-dem",
    exaggeration: 1.35,
  });
  assert.equal(map.addedLayers.length, 1);
  assert.equal(map.addedLayers[0].beforeLayerId, "road-line");
  assert.equal(map.addedLayers[0].layerDefinition.type, "hillshade");
  assert.equal(map.addedLayers[0].layerDefinition.source, "es-mapbox-dem");
});

test("ensureTerrainRelief removes terrain layer and source when disabled", () => {
  const map = createMockMap();
  setTerrainReliefPreference(true);
  ensureTerrainRelief(map, { styleType: "dark" });

  setTerrainReliefPreference(false);
  assert.equal(ensureTerrainRelief(map, { styleType: "dark" }), false);

  assert.deepEqual(map.terrainCalls.at(-1), null);
  assert.ok(map.removedLayers.includes("es-terrain-hillshade"));
  assert.ok(map.removedSources.includes("es-mapbox-dem"));
});

test("ensureTerrainRelief broadcasts applied state for overlay renderers", () => {
  const map = createMockMap();
  const applied = [];
  global.document.addEventListener("es:map-terrain-relief-applied", (event) => {
    applied.push(event.detail?.active);
  });

  setTerrainReliefPreference(true);
  ensureTerrainRelief(map, { styleType: "dark" });
  assert.equal(isTerrainReliefApplied(), true);

  setTerrainReliefPreference(false);
  ensureTerrainRelief(map, { styleType: "dark" });
  assert.equal(isTerrainReliefApplied(), false);

  assert.deepEqual(applied, [true, false]);
});

test("initTerrainRelief re-applies terrain before other style-change handlers", async () => {
  const map = createMockMap();
  setTerrainReliefPreference(true);

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
    const controller = initTerrainRelief({ map });
    assert.equal(capturedRef.priority, 0);
    assert.equal(map.addedLayers.length, 1);

    map.setStyleData(makeStyle());
    await capturedHandler("satellite");

    assert.equal(map.addedSources.length, 2);
    assert.equal(map.addedLayers.length, 2);
    assert.deepEqual(map.terrainCalls.at(-1), {
      source: "es-mapbox-dem",
      exaggeration: 1.2,
    });

    controller.destroy();
    assert.equal(unregisterCalledWith, capturedRef);
  } finally {
    mapCore.registerStyleChangeHandler = originalRegister;
    mapCore.unregisterStyleChangeHandler = originalUnregister;
  }
});

test("terrain relief supports Google provider by switching to terrain map type", () => {
  global.window = {
    MAP_PROVIDER: "google",
    APP_SETTINGS_FLAGS: {},
  };

  let styleName = "dark";
  const calls = [];
  const map = {
    getStyle() {
      return { name: styleName };
    },
    setStyle(style) {
      calls.push(style);
      styleName = style;
    },
  };

  assert.equal(isTerrainReliefSupported(map), true);

  setTerrainReliefPreference(true);
  assert.equal(ensureTerrainRelief(map), true);
  assert.deepEqual(calls, ["terrain"]);

  setTerrainReliefPreference(false);
  assert.equal(ensureTerrainRelief(map), false);
  assert.deepEqual(calls, ["terrain", "dark"]);
});

test("setTerrainReliefPreference persists state, syncs settings toggle, and emits event", () => {
  const settingsToggle = { checked: false };
  const received = [];
  global.document = createDocumentMock({
    "map-terrain-relief-toggle": settingsToggle,
  });
  global.document.addEventListener("es:map-terrain-relief-setting-changed", (event) => {
    received.push(event.detail?.enabled);
  });

  assert.equal(setTerrainReliefPreference(true), true);
  assert.equal(global.localStorage.getItem("mapTerrainReliefEnabled"), "true");
  assert.equal(settingsToggle.checked, true);
  assert.equal(global.window.APP_SETTINGS_FLAGS.mapTerrainReliefEnabled, true);
  assert.deepEqual(received, [true]);
});
