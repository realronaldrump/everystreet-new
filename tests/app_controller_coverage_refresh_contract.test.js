import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const appControllerPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "app-controller.js"
);

test("coverage selection change triggers trip layer refresh when clip preference is enabled", () => {
  const source = fs.readFileSync(appControllerPath, "utf8");

  assert.match(
    source,
    /refreshTripLayersForCoverageSelectionChange/,
    "Expected dedicated coverage-selection trip refresh helper"
  );
  assert.match(
    source,
    /dataManager\.isCoverageTripClipPreferenceEnabled\(\)\s*\?\s*this\.refreshTripLayersForCoverageSelectionChange/,
    "Expected location change handler to schedule clip-mode trip refresh"
  );
  assert.match(
    source,
    /if\s*\(state\.mapLayers\.trips\.visible\)\s*\{\s*requests\.push\(dataManager\.fetchTrips\(\)\);\s*\}/s,
    "Expected trips layer refetch in coverage refresh helper"
  );
  assert.match(
    source,
    /if\s*\(state\.mapLayers\.matchedTrips\.visible\)\s*\{\s*requests\.push\(dataManager\.fetchMatchedTrips\(\)\);\s*\}/s,
    "Expected matched trips layer refetch in coverage refresh helper"
  );
});
