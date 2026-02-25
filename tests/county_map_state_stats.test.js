import assert from "node:assert/strict";
import test from "node:test";

import * as CountyMapState from "../static/js/modules/county-map/state.js";
import {
  calculateStateStats,
  zoomToState,
} from "../static/js/modules/county-map/state-stats.js";

test.afterEach(() => {
  CountyMapState.resetState();
});

test("calculateStateStats uses county indexes without geometry retention", () => {
  CountyMapState.setStateTotals({
    48: { name: "Texas", total: 2 },
    35: { name: "New Mexico", total: 1 },
  });
  CountyMapState.setCountyToState({
    48001: { stateFips: "48", stateName: "Texas" },
    48003: { stateFips: "48", stateName: "Texas" },
    35001: { stateFips: "35", stateName: "New Mexico" },
  });
  CountyMapState.setCountyVisits({
    48001: {
      firstVisit: "2024-02-03T00:00:00.000Z",
      lastVisit: "2024-02-03T00:00:00.000Z",
    },
    48003: {
      firstVisit: "2024-01-01T00:00:00.000Z",
      lastVisit: "2024-03-01T00:00:00.000Z",
    },
  });

  const stats = calculateStateStats();
  const byState = Object.fromEntries(stats.map((entry) => [entry.fips, entry]));

  assert.equal(byState["48"].visited, 2);
  assert.equal(byState["48"].total, 2);
  assert.equal(byState["48"].percentage, 100);
  assert.equal(byState["48"].firstVisit.toISOString(), "2024-01-01T00:00:00.000Z");
  assert.equal(byState["48"].lastVisit.toISOString(), "2024-03-01T00:00:00.000Z");

  assert.equal(byState["35"].visited, 0);
  assert.equal(byState["35"].total, 1);
  assert.equal(byState["35"].percentage, 0);
});

test("zoomToState fits to precomputed state bounds", () => {
  const calls = [];
  CountyMapState.setMap({
    fitBounds(bounds, options) {
      calls.push({ bounds, options });
    },
  });
  CountyMapState.setStateBounds({
    48: [
      [-106.65, 25.83],
      [-93.51, 36.5],
    ],
  });

  zoomToState("48");
  zoomToState("35");

  assert.deepEqual(calls, [
    {
      bounds: [
        [-106.65, 25.83],
        [-93.51, 36.5],
      ],
      options: { padding: 50, maxZoom: 8 },
    },
  ]);
});
