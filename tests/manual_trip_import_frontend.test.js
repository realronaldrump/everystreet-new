import assert from "node:assert/strict";
import test from "node:test";

import { readRepoFile, readTemplate } from "./helpers/fs-smoke.js";

test("manual trip import keeps the upload, map, table, and explicit commit controls", () => {
  const template = readTemplate("trip_import.html");

  [
    "trip-import-file-input",
    "trip-import-scan",
    "trip-import-review",
    "trip-import-map",
    "trip-import-table-body",
    "trip-import-selection-count",
    "trip-import-commit",
    "trip-import-commit-label",
    "trip-import-progress",
    "trip-import-progress-track",
  ].forEach((id) => assert.match(template, new RegExp(`id=["']${id}["']`)));
  assert.match(template, /accept="\.zip,\.json/);
  assert.match(template, /Nothing is written until/);
});

test("manual import entrypoint is owner-routed and sends fingerprinted small batches", () => {
  const routeLoader = readRepoFile(
    "static",
    "js",
    "modules",
    "core",
    "route-loader.js",
  );
  const feature = readRepoFile(
    "static",
    "js",
    "modules",
    "features",
    "trip-import",
    "index.js",
  );
  const tripsTemplate = readTemplate("trips.html");

  assert.match(routeLoader, /"\/trip-import"[^\n]+"\.\.\/\.\.\/pages\/trip-import\.js"/);
  assert.match(feature, /manual-import\/preview/);
  assert.match(feature, /manual-import\/commit/);
  assert.match(feature, /fingerprint:\s*analysis\.fingerprint/);
  assert.match(feature, /max_import_batch_size/);
  assert.match(feature, /retry:\s*false/);
  assert.match(feature, /record\.status === "ready"/);
  assert.match(feature, /record\.max_speed/);
  assert.match(feature, /record\.average_speed/);
  assert.match(feature, /End time unavailable/);
  assert.match(tripsTemplate, /href="\/trip-import"/);
  assert.match(tripsTemplate, /auth_context\.is_owner/);
});
