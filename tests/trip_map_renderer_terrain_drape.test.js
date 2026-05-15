import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

const originalDeck = globalThis.deck;

function makeLayerState() {
  return {
    bundle: { trips: [] },
    decoded: {
      length: 1,
      positions: new Float64Array([-106.8, 39.2, -106.79, 39.21]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map(),
    featureCollection: null,
  };
}

const layerInfo = { color: "#d4943c", weight: 2, opacity: 1 };

test.beforeEach(() => {
  globalThis.deck = {
    PathLayer: class PathLayer {
      constructor(props) {
        this.props = props;
      }
    },
  };
});

test.afterEach(() => {
  tripMapRenderer.layers.clear();
  tripMapRenderer.terrainActive = false;
  store.map = null;
  globalThis.deck = originalDeck;
});

test("trip paths stay flat (size 2) when terrain is inactive", () => {
  tripMapRenderer.terrainActive = false;
  tripMapRenderer.layers.set("trips", makeLayerState());
  store.map = {
    queryTerrainElevation() {
      return 1500;
    },
  };

  tripMapRenderer._ensureDrape("trips");
  const layerState = tripMapRenderer.layers.get("trips");
  assert.equal(layerState.drapedPositions, undefined);

  const [layer] = tripMapRenderer.buildLayersForTripLayer(
    "trips",
    layerInfo,
    layerState
  );
  assert.equal(layer.props.data.attributes.getPath.size, 2);
  assert.equal(layer.props.data.attributes.getPath.value, layerState.decoded.positions);
});

test("trip paths drape onto terrain elevation (size 3) when terrain is active", () => {
  tripMapRenderer.terrainActive = true;
  tripMapRenderer.layers.set("trips", makeLayerState());
  const elevations = new Map([
    ["-106.8,39.2", 2000],
    ["-106.79,39.21", 2100],
  ]);
  store.map = {
    getZoom() {
      return 12;
    },
    queryTerrainElevation([lng, lat]) {
      return elevations.has(`${lng},${lat}`) ? elevations.get(`${lng},${lat}`) : null;
    },
  };

  tripMapRenderer._ensureDrape("trips");
  const layerState = tripMapRenderer.layers.get("trips");
  assert.ok(layerState.drapedPositions instanceof Float64Array);
  assert.deepEqual(Array.from(layerState.drapedPositions), [
    -106.8, 39.2, 2000, -106.79, 39.21, 2100,
  ]);
  assert.equal(layerState.drapePending, false);

  const [layer] = tripMapRenderer.buildLayersForTripLayer(
    "trips",
    layerInfo,
    layerState
  );
  assert.equal(layer.props.data.attributes.getPath.size, 3);
  assert.equal(
    layer.props.data.attributes.getPath.value,
    layerState.drapedPositions
  );
});

test("draping marks the layer pending and retries on map idle when DEM tiles arrive", () => {
  tripMapRenderer.terrainActive = true;
  tripMapRenderer.layers.set("trips", makeLayerState());
  let elevationReady = false;
  store.map = {
    getZoom() {
      return 12;
    },
    queryTerrainElevation() {
      return elevationReady ? 2500 : null;
    },
  };

  tripMapRenderer._ensureDrape("trips");
  let layerState = tripMapRenderer.layers.get("trips");
  assert.equal(layerState.drapePending, true);
  assert.deepEqual(Array.from(layerState.drapedPositions), [
    -106.8, 39.2, 0, -106.79, 39.21, 0,
  ]);

  // DEM tiles finish loading; the idle pass should resample the pending layer.
  elevationReady = true;
  tripMapRenderer._handleMapIdle();
  layerState = tripMapRenderer.layers.get("trips");
  assert.equal(layerState.drapePending, false);
  assert.deepEqual(Array.from(layerState.drapedPositions), [
    -106.8, 39.2, 2500, -106.79, 39.21, 2500,
  ]);
});

test("disabling terrain drops draped positions so paths fall back to flat", () => {
  tripMapRenderer.terrainActive = true;
  tripMapRenderer.layers.set("trips", makeLayerState());
  store.map = {
    getZoom() {
      return 12;
    },
    queryTerrainElevation() {
      return 1800;
    },
  };

  tripMapRenderer._ensureDrape("trips");
  assert.ok(tripMapRenderer.layers.get("trips").drapedPositions instanceof Float64Array);

  tripMapRenderer.terrainActive = false;
  tripMapRenderer._ensureDrape("trips");
  assert.equal(tripMapRenderer.layers.get("trips").drapedPositions, null);
});
