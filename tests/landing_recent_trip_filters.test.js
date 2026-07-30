import assert from "node:assert/strict";
import test from "node:test";

import { readStaticJs } from "./helpers/fs-smoke.js";

test("landing recent trips use and react to the dashboard filters", () => {
  const source = readStaticJs("modules", "features", "landing", "index.js");

  assert.match(
    source,
    /async function loadRecentTrips\(\)\s*{[\s\S]*?const params = buildTripMetricsQueryParams\(\);[\s\S]*?params\.set\("limit", "60"\);[\s\S]*?apiGet\(`\/api\/trips\/history\?\$\{params\.toString\(\)\}`\)/,
    "the activity request should share the metrics date and vehicle parameters"
  );
  assert.match(
    source,
    /const refreshDashboard = \(\) => \{[\s\S]*?loadMetrics\([\s\S]*?loadRecordSources\([\s\S]*?loadRecentTrips\(\);/,
    "filter changes should refresh recent activity as well as aggregate metrics"
  );
  assert.match(
    source,
    /requestId !== recentTripsLoadRequestId/,
    "a slower response for an old filter must not replace newer activity"
  );
  assert.match(
    source,
    /valueEl\.textContent = lastTripTime[\s\S]*?: "--"/,
    "an empty selected range should clear the previous recent-trip timestamp"
  );
});
