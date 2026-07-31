import assert from "node:assert/strict";
import test from "node:test";
import { settleWithConcurrency } from "../static/js/modules/features/server-logs/request-pool.js";

test("settleWithConcurrency caps active Docker log requests", async () => {
  let active = 0;
  let maximumActive = 0;

  const results = await settleWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;

    if (value === 3) {
      throw new Error("container unavailable");
    }
    return value * 2;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled"],
  );
  assert.deepEqual(
    results.filter((result) => result.status === "fulfilled").map((result) => result.value),
    [2, 4, 8, 10],
  );
});
