import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DISCOVERY_MIN_VISITS,
  normalizeDiscoveryMinVisits,
  sortDiscoveries,
} from "../static/js/modules/features/visits/discovery-controls.js";
import { readTemplate } from "./helpers/fs-smoke.js";

const suggestions = [
  {
    suggestedName: "Later, fewer",
    totalVisits: 3,
    firstVisit: "2026-04-01T12:00:00Z",
    lastVisit: "2026-05-01T12:00:00Z",
  },
  {
    suggestedName: "Earlier, more",
    totalVisits: 12,
    firstVisit: "2026-01-01T12:00:00Z",
    lastVisit: "2026-02-01T12:00:00Z",
  },
  {
    suggestedName: "Middle",
    totalVisits: 8,
    firstVisit: "2026-03-01T12:00:00Z",
    lastVisit: "2026-06-01T12:00:00Z",
  },
];

test("discovery sorting supports total visits and visit dates", () => {
  assert.deepEqual(
    sortDiscoveries(suggestions, "totalVisits-desc").map((s) => s.suggestedName),
    ["Earlier, more", "Middle", "Later, fewer"]
  );
  assert.deepEqual(
    sortDiscoveries(suggestions, "firstVisit-asc").map((s) => s.suggestedName),
    ["Earlier, more", "Middle", "Later, fewer"]
  );
  assert.deepEqual(
    sortDiscoveries(suggestions, "lastVisit-desc").map((s) => s.suggestedName),
    ["Middle", "Later, fewer", "Earlier, more"]
  );
});

test("discovery sorting keeps missing values at the end", () => {
  const sorted = sortDiscoveries(
    [{ suggestedName: "Missing", totalVisits: 9 }, ...suggestions],
    "lastVisit-desc"
  );

  assert.equal(sorted.at(-1).suggestedName, "Missing");
  assert.deepEqual(sortDiscoveries(null), []);
});

test("minimum discovery visits normalizes numeric input", () => {
  assert.equal(normalizeDiscoveryMinVisits("7"), 7);
  assert.equal(normalizeDiscoveryMinVisits("0"), DEFAULT_DISCOVERY_MIN_VISITS);
  assert.equal(normalizeDiscoveryMinVisits(""), DEFAULT_DISCOVERY_MIN_VISITS);
  assert.equal(normalizeDiscoveryMinVisits("bad", 4), 4);
});

test("visits page defaults discovery radius to small", () => {
  const template = readTemplate("visits.html");
  assert.match(template, /<option value="150" selected>/);
  assert.doesNotMatch(template, /<option value="250" selected>/);
});
