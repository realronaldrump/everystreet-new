import assert from "node:assert/strict";
import test from "node:test";

import { canAttemptRecovery } from "../static/js/modules/features/county-map/index.js";

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
