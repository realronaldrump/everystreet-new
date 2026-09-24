import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import layerManager from "../static/js/modules/layer-manager.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

const originalTripsLayer = structuredClone(store.mapLayers.trips);
const originalSetLayerData = tripMapRenderer.setLayerData;
const originalSetLayerVisibility = tripMapRenderer.setLayerVisibility;
const originalSetUseHeatmap = tripMapRenderer.setUseHeatmap;

test.afterEach(() => {
  store.map = null;
  store.mapInitialized = false;
  store.mapLayers.trips = structuredClone(originalTripsLayer);
  tripMapRenderer.setLayerData = originalSetLayerData;
  tripMapRenderer.setLayerVisibility = originalSetLayerVisibility;
  tripMapRenderer.setUseHeatmap = originalSetUseHeatmap;
  layerManager._layerUpdateQueue.clear();
});

test("trip bundle updates go to the trip renderer and leave its layers alone", async () => {
  const removed = [];
  let setLayerDataArgs = null;
  store.mapInitialized = true;
  store.map = {
    isStyleLoaded() {
      return true;
    },
    getLayer(id) {
      return { id };
    },
    getSource(id) {
      return { id };
    },
    off() {},
    removeLayer(id) {
      removed.push(id);
    },
    removeSource(id) {
      removed.push(id);
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

  assert.deepEqual(removed, []);
  assert.deepEqual(setLayerDataArgs, { layerName: "trips", bundle });
});

test("toggling trips shows or hides them in the renderer before data arrives", async () => {
  const calls = [];
  store.map = {};
  store.mapLayers.trips = { ...structuredClone(originalTripsLayer), layer: null };
  tripMapRenderer.setLayerVisibility = (layerName, visible) => {
    calls.push([layerName, visible]);
  };
  const originalDocument = globalThis.document;
  const originalSync = layerManager.syncVisibilityToStore;
  globalThis.document = {
    dispatchEvent() {},
    getElementById() {
      return null;
    },
  };
  layerManager.syncVisibilityToStore = () => {};
  try {
    await layerManager.toggleLayer("trips", false);
  } finally {
    globalThis.document = originalDocument;
    layerManager.syncVisibilityToStore = originalSync;
  }

  assert.deepEqual(calls, [["trips", false]]);
});

test("the render mode switch hands both trip layers to the renderer", async () => {
  let useHeatmap = null;
  tripMapRenderer.setUseHeatmap = (value) => {
    useHeatmap = value;
  };

  await layerManager.setTripLayerRenderMode(false);

  assert.equal(useHeatmap, false);
});
