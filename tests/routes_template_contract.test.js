import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const templatePath = path.join(root, "templates", "routes.html");

function assertId(source, id) {
  const pattern = new RegExp(`id=["']${id}["']`);
  assert.match(source, pattern, `routes.html missing required id: ${id}`);
}

function assertClass(source, className) {
  const pattern = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["']`);
  assert.match(
    source,
    pattern,
    `routes.html missing required class: ${className}`,
  );
}

test("Routes template includes required IDs/classes used by routes controller", () => {
  const source = fs.readFileSync(templatePath, "utf8");

  [
    "hero-stat-routes",
    "hero-stat-trips",
    "hero-stat-miles",
    "hero-stat-freq",
    "route-modal-show-all-trips",
    "route-modal-places",
    "route-places-list",
    "route-stat-frequency",
    "route-stat-first",
    "route-stat-total-dist",
    "route-stat-total-time",
    "route-stat-fuel",
    "route-stat-speed",
    "route-stat-cost",
    "route-chart-monthly",
    "route-chart-hour",
    "route-chart-dow",
    "route-chart-distance-trend",
    "routes-explorer-start-place",
    "routes-explorer-end-place",
    "routes-explorer-run-btn",
  ].forEach((id) => assertId(source, id));

  ["routes-modal-tab", "routes-modal-tab-content"].forEach((className) =>
    assertClass(source, className),
  );
});
