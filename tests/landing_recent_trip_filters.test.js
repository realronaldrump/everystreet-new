import assert from "node:assert/strict";
import test from "node:test";

import { readStaticJs } from "./helpers/fs-smoke.js";

test("landing recent trips use and react to the dashboard filters", () => {
  const source = readStaticJs("modules", "features", "landing", "index.js");

  assert.match(
    source,
    /const RECENT_TRIPS_LIMIT = "60";/,
    "the logbook asks for enough trips to fill the page"
  );
  assert.match(
    source,
    /async function loadRecentTrips\(\)\s*{[\s\S]*?const params = tripQuery\(\);[\s\S]*?params\.set\("limit", RECENT_TRIPS_LIMIT\);[\s\S]*?featureApi\.get\(`\/api\/trips\/history\?\$\{params\}`\)/,
    "the activity request should share the metrics date and vehicle parameters"
  );
  assert.match(
    source,
    /function refreshForFilters\(\) \{[\s\S]*?loadMetrics\([\s\S]*?loadRecords\([\s\S]*?loadRecentTrips\(\);/,
    "filter changes should refresh recent activity as well as aggregate metrics"
  );
  assert.match(
    source,
    /document\.addEventListener\(\s*"filtersApplied",\s*refreshForFilters/,
    "the filter refresh listens for applied filters"
  );
  assert.match(
    source,
    /requestId === requestIds\.trips/,
    "a slower response for an old filter must not replace newer activity"
  );
  assert.match(
    source,
    /value\.textContent = when \? formatRelativeTimeShort\(new Date\(when\)\) : "--"/,
    "an empty selected range should clear the previous recent-trip timestamp"
  );
});
