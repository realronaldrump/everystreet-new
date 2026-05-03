import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import layerManager from "../static/js/modules/layer-manager.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

const originalTripsLayer = structuredClone(store.mapLayers.trips);
const originalSetLayerData = tripMapRenderer.setLayerData;
const originalDocument = globalThis.document;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

function restoreGlobals() {
  if (originalDocument === undefined) {
    globalThis.document = undefined;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalRequestAnimationFrame === undefined) {
    globalThis.requestAnimationFrame = undefined;
  } else {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
}

test.afterEach(() => {
  store.map = null;
  store.mapInitialized = false;
  store.mapLayers.trips = structuredClone(originalTripsLayer);
  tripMapRenderer.setLayerData = originalSetLayerData;
  layerManager._layerUpdateQueue.clear();
  restoreGlobals();
});

test("heatmap refresh ignores deck-backed trip bundles", async () => {
  const calls = [];
  globalThis.document = {
    documentElement: {
      getAttribute() {
        return "dark";
      },
    },
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

  store.mapInitialized = true;
  store.map = {
    getLayer() {
      return null;
    },
    isStyleLoaded() {
      return true;
    },
    once() {
      calls.push("once");
    },
    getSource() {
      return null;
    },
    addSource() {
      calls.push("addSource");
    },
    addLayer() {
      calls.push("addLayer");
    },
    off() {},
    removeLayer() {},
    removeSource() {},
  };
  store.mapLayers.trips = {
    ...structuredClone(originalTripsLayer),
    isHeatmap: true,
    visible: true,
    layer: {
      type: "TripMapBundle",
      bundle: { trips: [] },
      features: null,
    },
  };

  layerManager._refreshHeatmapStyle("trips");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, []);
  assert.equal(store.mapLayers.trips._heatmapRebuildInProgress, undefined);
});

test("deck trip bundle updates remove stale mapbox trip layers", async () => {
  const removedLayers = [];
  const removedSources = [];
  let setLayerDataArgs = null;
  const liveLayers = new Set([
    "trips-layer-0",
    "trips-layer-1",
    "trips-layer",
    "trips-hitbox",
  ]);
  const liveSources = new Set(["trips-source"]);

  store.mapInitialized = true;
  store.map = {
    isStyleLoaded() {
      return true;
    },
    getLayer(id) {
      return liveLayers.has(id) ? { id } : null;
    },
    getSource(id) {
      return liveSources.has(id) ? { id } : null;
    },
    off() {},
    removeLayer(id) {
      removedLayers.push(id);
      liveLayers.delete(id);
    },
    removeSource(id) {
      removedSources.push(id);
      liveSources.delete(id);
    },
  };
  tripMapRenderer.setLayerData = async (layerName, bundle) => {
    setLayerDataArgs = { layerName, bundle };
  };

  const bundle = { revision: "test", trip_count: 0, trips: [] };
  await layerManager._updateMapLayerInternal("trips", {
    type: "TripMapBundle",
    bundle,
  });

  assert.deepEqual(removedLayers, [
    "trips-hitbox",
    "trips-layer-0",
    "trips-layer-1",
    "trips-layer",
  ]);
  assert.deepEqual(removedSources, ["trips-source"]);
  assert.deepEqual(setLayerDataArgs, { layerName: "trips", bundle });
});
