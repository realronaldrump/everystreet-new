import assert from "node:assert/strict";
import test from "node:test";

import {
  isAtOrBeforeJournalBoundary,
  journalDateKey,
} from "../static/js/modules/features/coverage-journal/date-boundaries.js";

test("coverage journal compares chart dates in the requested timezone", () => {
  const eveningInDenver = "2026-07-02T02:00:00Z";

  assert.equal(journalDateKey(eveningInDenver, "America/Denver"), "2026-07-01");
  assert.equal(
    isAtOrBeforeJournalBoundary(
      eveningInDenver,
      "2026-07-01",
      "America/Denver"
    ),
    true
  );
  assert.equal(
    isAtOrBeforeJournalBoundary(
      "2026-07-02T07:00:00Z",
      "2026-07-01",
      "America/Denver"
    ),
    false
  );
});
