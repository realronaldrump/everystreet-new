import assert from "node:assert/strict";
import test from "node:test";

import { applyBasemapTreatment } from "../static/js/modules/features/map/basemap-treatment.js";

function createMapMock() {
  const paintCalls = [];
  const layoutCalls = [];
  const fogCalls = [];
  const map = {
    isStyleLoaded: () => true,
    getStyle: () => ({
      name: "Mapbox Light",
      layers: [
        { id: "land", type: "background" },
        { id: "water", type: "fill" },
        { id: "national-park", type: "fill" },
        { id: "settlement-major-label", type: "symbol" },
        { id: "poi-label", type: "symbol" },
      ],
    }),
    setPaintProperty: (...args) => paintCalls.push(args),
    setLayoutProperty: (...args) => layoutCalls.push(args),
    setFog: (fog) => fogCalls.push(fog),
  };

  return { map, paintCalls, layoutCalls, fogCalls };
}

test("light basemap treatment uses the app's warm paper palette", () => {
  const { map, paintCalls, layoutCalls, fogCalls } = createMapMock();

  applyBasemapTreatment(map);

  assert.deepEqual(
    paintCalls.filter(([, property]) => property === "background-color"),
    [["land", "background-color", "#f4f1e8"]]
  );
  assert.deepEqual(
    paintCalls.filter(([, property]) => property === "fill-color"),
    [
      ["water", "fill-color", "#dfe3dc"],
      ["national-park", "fill-color", "#e8e8d9"],
    ]
  );
  assert.deepEqual(layoutCalls, [["poi-label", "visibility", "none"]]);
  assert.deepEqual(fogCalls, [
    {
      color: "#f4f1e8",
      "high-color": "#eee9dc",
      "horizon-blend": 0.04,
      "star-intensity": 0,
    },
  ]);
});
