import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

const originalDeck = globalThis.deck;
const originalDecodeTrips = tripMapRenderer.decodeTrips;
const originalTripsLayer = structuredClone(store.mapLayers.trips);

function decodedFixture() {
  return {
    length: 3,
    positions: new Float64Array([
      -107.3, 39.5, -107.2, 39.6, -106.9, 39.2, -106.8, 39.3, -106.7, 39.4, -107.1,
      39.7, -107.0, 39.8,
    ]),
    startIndices: new Uint32Array([0, 2, 5, 7]),
    tripIndices: new Uint32Array([0, 1, 0]),
  };
}

test.beforeEach(() => {
  tripMapRenderer.layers.clear();
  tripMapRenderer.overlay = null;
  tripMapRenderer._nativeSourceData.clear();
  store.map = null;
  store.mapLayers.trips = {
    ...structuredClone(originalTripsLayer),
    visible: true,
    isHeatmap: false,
  };
});

test.afterEach(() => {
  tripMapRenderer.layers.clear();
  tripMapRenderer.overlay = null;
  tripMapRenderer._nativeSourceData.clear();
  tripMapRenderer.decodeTrips = originalDecodeTrips;
  store.map = null;
  store.mapLayers.trips = structuredClone(originalTripsLayer);
  globalThis.deck = originalDeck;
});

test("decoded paths are indexed once by trip for large-bundle lookups", async () => {
  const decoded = decodedFixture();
  tripMapRenderer.decodeTrips = async () => decoded;

  const layerState = await tripMapRenderer.setLayerData("trips", {
    revision: "performance-test",
    trip_count: 2,
    trips: [{ id: "trip-a" }, { id: "trip-b" }],
  });

  assert.deepEqual(layerState.pathIndicesByTrip.get(0), [0, 2]);
  assert.deepEqual(layerState.pathIndicesByTrip.get(1), [1]);

  // Lookups must use the index instead of rescanning every path in the bundle.
  decoded.tripIndices = null;
  assert.deepEqual(tripMapRenderer.getTripPaths("trips", "trip-a"), [
    [
      [-107.3, 39.5],
      [-107.2, 39.6],
    ],
    [
      [-107.1, 39.7],
      [-107.0, 39.8],
    ],
  ]);
});

test("unchanged binary geometry keeps stable deck data between renders", () => {
  globalThis.deck = {
    PathLayer: class PathLayer {
      constructor(props) {
        this.props = props;
      }
    },
  };
  const layerState = {
    bundle: { trip_count: 2, trips: [{ id: "trip-a" }, { id: "trip-b" }] },
    decoded: decodedFixture(),
    tripById: new Map(),
    featureCollection: null,
  };

  const [firstLayer] = tripMapRenderer.buildLayersForTripLayer(
    "trips",
    store.mapLayers.trips,
    layerState
  );
  const [secondLayer] = tripMapRenderer.buildLayersForTripLayer(
    "trips",
    store.mapLayers.trips,
    layerState
  );

  assert.equal(firstLayer.props.data, secondLayer.props.data);
});
