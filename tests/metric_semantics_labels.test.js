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

test("memory city labels its segment-granular model as segments", () => {
  const root = join(import.meta.dirname, "..");
  const template = readFileSync(join(root, "templates/memory_city.html"), "utf8");
  const controller = readFileSync(
    join(root, "static/js/modules/features/memory-city/index.js"),
    "utf8"
  );

  assert.match(template, /memory-city-figure-label">Segments</);
  assert.match(controller, /model\.count\)} segments stacked/);
});

test("coverage metrics label segment counts as segments", () => {
  const root = join(import.meta.dirname, "..");
  const planner = readFileSync(
    join(root, "templates/coverage_route_planner.html"),
    "utf8"
  );
  const progressCard = readFileSync(
    join(root, "static/js/modules/ui/progress-card.js"),
    "utf8"
  );

  assert.match(planner, />Total Segments</);
  assert.match(planner, />segments selected</);
  assert.match(progressCard, /label: "Segments Driven"/);
  assert.doesNotMatch(progressCard, /totalAreaMiles|drivenStreets/);
});
