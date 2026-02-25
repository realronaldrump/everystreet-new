import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCountyVisitFeatureState,
  buildCountyBorderColorExpression,
  buildCountyBorderWidthExpression,
  buildCountyFillColorExpression,
  buildCountyFillOpacityExpression,
  updateStopLayerVisibility,
} from "../static/js/modules/county-map/map-layers.js";
import * as CountyMapState from "../static/js/modules/county-map/state.js";

test.afterEach(() => {
  CountyMapState.resetState();
});

test("county style expressions switch stopped styling on/off", () => {
  assert.deepEqual(buildCountyFillColorExpression(true), [
    "case",
    ["boolean", ["feature-state", "stopped"], false],
    "#c45454",
    ["boolean", ["feature-state", "visited"], false],
    "#4d9a6a",
    "rgba(245, 242, 236, 0.02)",
  ]);
  assert.deepEqual(buildCountyFillOpacityExpression(true), [
    "case",
    ["boolean", ["feature-state", "stopped"], false],
    0.55,
    ["boolean", ["feature-state", "visited"], false],
    0.6,
    1,
  ]);
  assert.deepEqual(buildCountyBorderColorExpression(false), [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    "#3b7a53",
    "rgba(245, 242, 236, 0.15)",
  ]);
  assert.deepEqual(buildCountyBorderWidthExpression(false), [
    "case",
    ["boolean", ["feature-state", "visited"], false],
    1,
    0.5,
  ]);
});

test("applyCountyVisitFeatureState clears source state and merges stop/visit flags", () => {
  const featureStateCalls = [];
  const removeCalls = [];
  const map = {
    getSource(id) {
      return id === "counties" ? { id } : null;
    },
    removeFeatureState(args) {
      removeCalls.push(args);
    },
    setFeatureState(target, state) {
      featureStateCalls.push({ target, state });
    },
  };

  applyCountyVisitFeatureState(
    map,
    { "01001": { firstVisit: "2024-01-01" }, "01003": { firstVisit: "2024-01-02" } },
    { "01003": { firstStop: "2024-01-02" }, "01005": { firstStop: "2024-01-03" } }
  );

  assert.deepEqual(removeCalls, [{ source: "counties" }]);

  const byId = Object.fromEntries(
    featureStateCalls.map((entry) => [entry.target.id, entry.state])
  );
  assert.deepEqual(byId, {
    "01001": { visited: true },
    "01003": { visited: true, stopped: true },
    "01005": { stopped: true },
  });
});

test("updateStopLayerVisibility rewrites county layer paint properties", () => {
  const paintCalls = [];
  const map = {
    getLayer(id) {
      return id === "counties-fill" || id === "counties-border";
    },
    setPaintProperty(id, property, value) {
      paintCalls.push([id, property, value]);
    },
  };

  CountyMapState.setMap(map);
  CountyMapState.setShowStoppedCounties(true);
  updateStopLayerVisibility();

  assert.equal(paintCalls.length, 4);
  assert.deepEqual(paintCalls[0], [
    "counties-fill",
    "fill-color",
    buildCountyFillColorExpression(true),
  ]);
  assert.deepEqual(paintCalls[2], [
    "counties-border",
    "line-color",
    buildCountyBorderColorExpression(true),
  ]);
});
