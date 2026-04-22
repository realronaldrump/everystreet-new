import assert from "node:assert/strict";
import test from "node:test";

import tripMapRenderer from "../static/js/modules/trip-map-renderer.js";

test.afterEach(() => {
  tripMapRenderer.layers.clear();
});

test("trip map renderer derives layer bounds from decoded paths before stored bbox", () => {
  tripMapRenderer.layers.set("trips", {
    bundle: {
      bbox: [0, 0, 0, 0],
      trips: [{ id: "trip-1", bbox: [0, 0, 0, 0] }],
    },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.1467, 31.5493, -97.1455, 31.5504]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map([
      [
        "trip-1",
        {
          trip: { id: "trip-1", bbox: [0, 0, 0, 0] },
          index: 0,
        },
      ],
    ]),
    featureCollection: null,
  });

  assert.deepEqual(
    tripMapRenderer.getBundleBounds("trips"),
    [-97.1467, 31.5493, -97.1455, 31.5504]
  );
  assert.deepEqual(
    tripMapRenderer.getTripBounds("trips", "trip-1"),
    [-97.1467, 31.5493, -97.1455, 31.5504]
  );
});

test("trip map renderer ignores fake zero bbox when a layer has no decoded paths", () => {
  tripMapRenderer.layers.set("trips", {
    bundle: {
      bbox: [0, 0, 0, 0],
      trips: [],
    },
    decoded: {
      length: 0,
      positions: new Float64Array(),
      startIndices: new Uint32Array([0]),
      tripIndices: new Uint32Array(),
    },
    tripById: new Map(),
    featureCollection: null,
  });

  assert.equal(tripMapRenderer.getBundleBounds("trips"), null);
});
