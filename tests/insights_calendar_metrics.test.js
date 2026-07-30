import assert from "node:assert/strict";
import test from "node:test";

import { aggregateByView } from "../static/js/modules/insights/charts.js";
import {
  calculateDaysDiff,
  calculatePreviousRange,
} from "../static/js/modules/insights/formatters.js";

test("previous insight range uses calendar dates without local timezone shifts", () => {
  assert.equal(calculateDaysDiff("2026-01-01", "2026-01-31"), 31);
  assert.deepEqual(calculatePreviousRange("2026-01-01", 31), {
    start: "2025-12-01",
    end: "2025-12-31",
  });
});

test("insight chart buckets preserve API calendar dates and Monday weeks", () => {
  const daily = aggregateByView(
    [{ date: "2026-07-01", distance: 5, count: 1 }],
    "daily"
  );
  const weekly = aggregateByView(
    [{ date: "2026-07-27", distance: 5, count: 1 }],
    "weekly"
  );
  const monthly = aggregateByView(
    [{ date: "2026-07-01", distance: 5, count: 1 }],
    "monthly"
  );

  assert.equal(daily[0].label, "Jul 1");
  assert.deepEqual(
    { start: weekly[0].start, end: weekly[0].end },
    { start: "2026-07-27", end: "2026-08-02" }
  );
  assert.equal(monthly[0].label, "Jul 2026");
  assert.deepEqual(
    { start: monthly[0].start, end: monthly[0].end },
    { start: "2026-07-01", end: "2026-07-31" }
  );
});
