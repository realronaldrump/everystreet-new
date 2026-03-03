import assert from "node:assert/strict";
import test from "node:test";

import {
  canAttemptRecovery,
  getCityTabStateRollups,
  getCountyActivityStateFips,
} from "../static/js/modules/features/county-map/index.js";

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
      "48001": {
        firstStop: "2026-01-01T00:00:00.000Z",
        lastStop: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  assert.deepEqual([...stateFips].sort(), ["01", "06", "48"]);
});

test("getCityTabStateRollups returns states with city totals regardless of county activity", () => {
  const rollups = getCityTabStateRollups([
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
  ]);

  assert.deepEqual(
    rollups.map((entry) => entry.stateFips),
    ["01", "48"]
  );
});
