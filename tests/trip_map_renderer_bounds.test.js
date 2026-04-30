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

test("trip map renderer omits features without decoded paths", () => {
  tripMapRenderer.layers.set("trips", {
    bundle: {
      trips: [
        { id: "trip-with-path", path: "_ibE_seK_ibE_ibE" },
        { id: "trip-without-path", path: "" },
      ],
    },
    decoded: {
      length: 1,
      positions: new Float64Array([-97.1467, 31.5493, -97.1455, 31.5504]),
      startIndices: new Uint32Array([0, 2]),
      tripIndices: new Uint32Array([0]),
    },
    tripById: new Map([
      ["trip-with-path", { trip: { id: "trip-with-path" }, index: 0 }],
      ["trip-without-path", { trip: { id: "trip-without-path" }, index: 1 }],
    ]),
    featureCollection: null,
  });

  const collection = tripMapRenderer.getFeatureCollection("trips");

  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ["trip-with-path"]
  );
  assert.deepEqual(collection.features[0].geometry.coordinates, [
    [-97.1467, 31.5493],
    [-97.1455, 31.5504],
  ]);
});
