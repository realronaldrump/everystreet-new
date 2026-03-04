import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataManagerPath = path.join(root, "static", "js", "modules", "data-manager.js");

test("data-manager coverage clip wiring is present for trips and matched trips", () => {
  const source = fs.readFileSync(dataManagerPath, "utf8");

  assert.match(
    source,
    /_readCoverageTripClipPreference\(\)/,
    "Expected helper to read coverage clip preference"
  );
  assert.match(
    source,
    /APP_SETTINGS_FLAGS\?\.mapTripsWithinCoverageOnly/,
    "Expected fallback to server-provided app settings flags"
  );
  assert.match(
    source,
    /if\s*\(coverageClip\.enabled\s*&&\s*coverageClip\.areaId\)\s*\{\s*params\.set\("coverage_area_id",\s*coverageClip\.areaId\);\s*params\.set\("clip_to_coverage",\s*"true"\);/s,
    "Expected conditional clip params to be applied when preference + selected area are active"
  );

  const coverageAreaParamHits = (
    source.match(/params\.set\("coverage_area_id",/g) || []
  ).length;
  const clipFlagHits = (
    source.match(/params\.set\("clip_to_coverage",\s*"true"\)/g) || []
  ).length;

  assert.ok(
    coverageAreaParamHits >= 2,
    "Expected coverage_area_id to be wired in both trip fetch methods"
  );
  assert.ok(
    clipFlagHits >= 2,
    "Expected clip_to_coverage flag to be wired in both trip fetch methods"
  );
});

test("data-manager skips server metrics fetch while clip mode is active", () => {
  const source = fs.readFileSync(dataManagerPath, "utf8");

  assert.match(
    source,
    /async fetchMetrics\(\)\s*\{\s*if\s*\(this\.getCoverageTripClipState\(\)\.enabled\)\s*\{\s*return null;\s*\}/s,
    "Expected fetchMetrics() to short-circuit while coverage clipping is active"
  );
});
