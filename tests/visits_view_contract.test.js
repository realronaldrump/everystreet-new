import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const templatePath = path.join(root, "templates", "visits.html");
const uiManagerPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "visits",
  "visits-ui-manager.js"
);

function assertId(source, id) {
  const pattern = new RegExp(`id=["']${id}["']`);
  assert.match(source, pattern, `visits.html missing required id: ${id}`);
}

test("Visits detail view contract remains aligned between template and UI manager", () => {
  const templateSource = fs.readFileSync(templatePath, "utf8");
  const uiManagerSource = fs.readFileSync(uiManagerPath, "utf8");

  assertId(templateSource, "trips-section");
  assertId(templateSource, "trips-for-place-table");

  assert.match(
    uiManagerSource,
    /showTripsForPlace/,
    "visits-ui-manager.js should call VisitsManager.showTripsForPlace when opening detail view"
  );

  assert.match(
    uiManagerSource,
    /document\.getElementById\("trips-section"\)/,
    "visits-ui-manager.js should gracefully fall back to #trips-section when legacy containers are absent"
  );
});
