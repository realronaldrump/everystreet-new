import assert from "node:assert/strict";
import test from "node:test";

import {
  canAttemptRecovery,
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
