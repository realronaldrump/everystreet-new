import assert from "node:assert/strict";
import test from "node:test";
import { basemapLayers } from "../static/js/modules/maps/manual-basemap.js";

test("the basemap printer leaves the app's own layers alone", () => {
  const style = {
    sources: {
      composite: { type: "vector", url: "mapbox://mapbox.mapbox-streets-v8" },
      streets: { type: "geojson" },
      "modal-trip": { type: "geojson" },
    },
    layers: [
      { id: "land", type: "background" },
      { id: "road-street", type: "line", source: "composite" },
      { id: "road-secondary-tertiary-case", type: "line", source: "composite" },
      { id: "streets-driven", type: "line", source: "streets" },
      { id: "trip-path-outline", type: "line", source: "modal-trip" },
    ],
  };

  assert.deepEqual(
    basemapLayers(style).map((layer) => layer.id),
    ["land", "road-street", "road-secondary-tertiary-case"]
  );
});

test("a style without layers prints nothing", () => {
  assert.deepEqual(basemapLayers({}), []);
  assert.deepEqual(basemapLayers(null), []);
});
