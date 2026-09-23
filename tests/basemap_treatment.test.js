import assert from "node:assert/strict";
import test from "node:test";

import { applyBasemapTreatment } from "../static/js/modules/features/map/basemap-treatment.js";

function createMapMock(name = "Mapbox Light") {
  const paintCalls = [];
  const layoutCalls = [];
  const fogCalls = [];
  const map = {
    isStyleLoaded: () => true,
    getStyle: () => ({
      name,
      sources: {
        composite: { type: "vector" },
        places: { type: "geojson" },
      },
      layers: [
        { id: "land", type: "background" },
        { id: "water", type: "fill", source: "composite" },
        { id: "settlement-major-label", type: "symbol", source: "composite" },
        { id: "poi-label", type: "symbol", source: "composite" },
        { id: "poi-label-saved-places", type: "symbol", source: "places" },
      ],
    }),
    setPaintProperty: (...args) => paintCalls.push(args),
    setLayoutProperty: (...args) => layoutCalls.push(args),
    setFog: (fog) => fogCalls.push(fog),
  };

  return { map, paintCalls, layoutCalls, fogCalls };
}

function withPaperToken(value, fn) {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
  };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => (name === "--basemap-paper" ? ` ${value}` : ""),
  });
  try {
    fn();
  } finally {
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
  }
}

test("basemap treatment hides label chatter and fogs to the paper", () => {
  const { map, paintCalls, layoutCalls, fogCalls } = createMapMock();

  withPaperToken("#efe6d1", () => applyBasemapTreatment(map));

  assert.deepEqual(paintCalls, [], "colours come from the manual basemap");
  assert.deepEqual(layoutCalls, [["poi-label", "visibility", "none"]]);
  assert.deepEqual(fogCalls, [
    {
      color: "#efe6d1",
      "high-color": "#efe6d1",
      "space-color": "#efe6d1",
      "horizon-blend": 0.04,
      "star-intensity": 0,
    },
  ]);
});

test("the Streets style keeps its sky and satellite is left alone", () => {
  const streets = createMapMock("Mapbox Streets");
  withPaperToken("#efe6d1", () => applyBasemapTreatment(streets.map));
  assert.deepEqual(streets.layoutCalls, [["poi-label", "visibility", "none"]]);
  assert.deepEqual(streets.fogCalls, []);

  const satellite = createMapMock("Mapbox Satellite Streets");
  withPaperToken("#efe6d1", () => applyBasemapTreatment(satellite.map));
  assert.deepEqual(satellite.layoutCalls, []);
  assert.deepEqual(satellite.fogCalls, []);
});
