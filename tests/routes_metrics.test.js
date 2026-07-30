import assert from "node:assert/strict";
import test from "node:test";

import {
  computeDistanceStats,
  fillMissingMonthlyBuckets,
} from "../static/js/modules/features/routes/index.js";

test("route distance range requires observed timeline distances", () => {
  assert.equal(
    computeDistanceStats({ timeline: [] }, { distance_miles_median: 10 }),
    null
  );
  assert.deepEqual(
    computeDistanceStats({ timeline: [{ distance: 10 }, { distance: 20 }] }),
    { count: 2, min: 10, max: 20, mean: 15 }
  );
});

test("route monthly metrics insert zero-count calendar months", () => {
  const buckets = fillMissingMonthlyBuckets([
    { _id: "2026-01", count: 1 },
    { _id: "2026-04", count: 1 },
    { _id: "2026-07", count: 1 },
  ]);

  assert.equal(buckets.length, 7);
  assert.deepEqual(buckets.slice(-3), [
    { _id: "2026-05", count: 0 },
    { _id: "2026-06", count: 0 },
    { _id: "2026-07", count: 1 },
  ]);
});
