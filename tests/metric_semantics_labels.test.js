import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import VisitsPopup from "../static/js/modules/visits/visits-popup.js";

test("visit popup labels the average gap as time between visits", () => {
  const popup = new VisitsPopup();
  const markup = popup._createStatsPopupHTML("place-1", "Test Place", {
    totalVisits: 2,
    averageTimeSinceLastVisit: "3 days",
  });

  assert.match(markup, /Avg Time Between Visits/);
  assert.doesNotMatch(markup, />Time Since Last</);
});

test("coverage metrics label segment counts as segments", () => {
  const root = join(import.meta.dirname, "..");
  const planner = readFileSync(
    join(root, "templates/coverage_route_planner.html"),
    "utf8"
  );
  assert.match(planner, />Total Segments</);
  assert.match(planner, />segments selected</);
});
