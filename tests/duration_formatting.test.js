import assert from "node:assert/strict";
import test from "node:test";

import { formatDurationShort } from "../static/js/modules/features/map/lens-trips.js";
import { formatDurationFromHours } from "../static/js/modules/utils/formatting.js";

test("rounded duration formatters never emit sixty residual minutes", () => {
  assert.equal(formatDurationFromHours(1.999), "2 hours");
  assert.equal(formatDurationShort(7_199), "2h 0m");
});
