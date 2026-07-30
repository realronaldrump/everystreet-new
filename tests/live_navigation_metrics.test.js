import assert from "node:assert/strict";
import test from "node:test";

import LiveNavigationGPS from "../static/js/modules/live-navigation/live-navigation-gps.js";
import { resolveLiveCoveragePercent } from "../static/js/modules/live-navigation/live-navigation-navigator.js";
import LiveNavigationUI from "../static/js/modules/live-navigation/live-navigation-ui.js";

test("live navigation preserves an explicit zero GPS speed", () => {
  const gps = new LiveNavigationGPS();
  gps.lastPosition = { lat: 31.5, lon: -97.1 };
  gps.lastPositionTime = 1_000;

  const speed = gps.resolveSpeed({
    lat: 31.5001,
    lon: -97.1,
    speed: 0,
    timestamp: 2_000,
  });

  assert.equal(speed, 0);
});

test("live navigation retains confirmed coverage when segment truth is unavailable", () => {
  assert.equal(resolveLiveCoveragePercent(50, { totalLength: 0, percentage: 0 }), 50);
  assert.equal(
    resolveLiveCoveragePercent(50, { totalLength: 1_000, percentage: 55 }),
    55
  );
});

test("live navigation duration rounding carries sixty minutes into hours", () => {
  const ui = new LiveNavigationUI();
  assert.equal(ui.formatDuration(7_199), "2h 0min");
});
