import assert from "node:assert/strict";
import test from "node:test";
import * as CountyMapState from "../static/js/modules/county-map/state.js";
import {
  canAttemptRecovery,
  getCityTabStateRollups,
  getCountyActivityStateFips,
} from "../static/js/modules/features/county-map/index.js";

test.afterEach(() => {
  CountyMapState.resetState();
});

test("canAttemptRecovery enforces attempt limits and cooldown", () => {
  assert.equal(
    canAttemptRecovery({
      attempts: 0,
      lastAttemptAtMs: 0,
      nowMs: 10_000,
      maxAttempts: 2,
      cooldownMs: 30_000,
    }),
    true
  );

  assert.equal(
    canAttemptRecovery({
      attempts: 2,
      lastAttemptAtMs: 0,
      nowMs: 10_000,
      maxAttempts: 2,
      cooldownMs: 30_000,
    }),
    false
  );

  assert.equal(
    canAttemptRecovery({
      attempts: 1,
      lastAttemptAtMs: 100_000,
      nowMs: 120_000,
      maxAttempts: 2,
      cooldownMs: 30_000,
    }),
    false
  );

  assert.equal(
    canAttemptRecovery({
      attempts: 1,
      lastAttemptAtMs: 100_000,
      nowMs: 130_000,
      maxAttempts: 2,
      cooldownMs: 30_000,
    }),
    true
  );
});

test("getCountyActivityStateFips includes states with visits or stops", () => {
  const stateFips = getCountyActivityStateFips({
    countyVisits: {
      1001: {
        firstVisit: "2026-01-01T00:00:00.000Z",
        lastVisit: "2026-01-01T00:00:00.000Z",
      },
      "06001": {
        firstVisit: "2026-01-01T00:00:00.000Z",
        lastVisit: "2026-01-01T00:00:00.000Z",
      },
    },
    countyStops: {
      48001: {
        firstStop: "2026-01-01T00:00:00.000Z",
        lastStop: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  assert.deepEqual([...stateFips].sort(), ["01", "06", "48"]);
});

test("getCityTabStateRollups returns only states with city totals AND county activity", () => {
  // State "01" has city total > 0 but no county activity → excluded
  // State "48" has city total > 0 AND county activity → included
  const activitySet = new Set(["48"]);
  const rollups = getCityTabStateRollups(
    [
      {
        stateFips: "01",
        city: { total: 5, visited: 0 },
        county: { visited: 0, total: 67 },
      },
      {
        stateFips: "06",
        city: { total: 0, visited: 0 },
        county: { visited: 0, total: 58 },
      },
      {
        stateFips: "48",
        city: { total: 10, visited: 1 },
        county: { visited: 1, total: 254 },
      },
    ],
    activitySet
  );

  assert.deepEqual(
    rollups.map((entry) => entry.stateFips),
    ["48"]
  );
});

test("county map state normalizes county visit and stop keys to 5-digit FIPS", () => {
  CountyMapState.setCountyVisits({
    1001: { firstVisit: "2026-01-01T00:00:00.000Z" },
    "06001": { firstVisit: "2026-01-02T00:00:00.000Z" },
  });
  CountyMapState.setCountyStops({
    2001: { firstStop: "2026-01-03T00:00:00.000Z" },
  });

  assert.deepEqual(Object.keys(CountyMapState.getCountyVisits()).sort(), [
    "01001",
    "06001",
  ]);
  assert.deepEqual(Object.keys(CountyMapState.getCountyStops()), ["02001"]);
});
