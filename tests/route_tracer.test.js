import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseHtml = readFileSync(join(root, "templates/base.html"), "utf8");
const tracerCss = readFileSync(
  join(root, "static/css/route-tracer.css"),
  "utf8",
);
const loadingManagerJs = readFileSync(
  join(root, "static/js/modules/ui/loading-manager.js"),
  "utf8",
);

const ROUTE_D = "M6 25 H20 V11 H38 V21 H52 V7 H66";

test("global loader stylesheet is wired into the shell", () => {
  assert.match(baseHtml, /route-tracer\.css/);
});

test("global overlay renders the route tracer, not a bare spinner", () => {
  assert.match(baseHtml, /class="route-tracer"/);
  assert.match(baseHtml, /class="route-tracer__line"/);
  assert.match(baseHtml, /<animateMotion/);
  assert.match(baseHtml, /<mpath href="#route-tracer-path"/);
  assert.doesNotMatch(baseHtml, /loading-spinner/);
});

test("loading manager uses the shell overlay instead of creating fallback markup", () => {
  assert.match(loadingManagerJs, /document\.querySelector\("\.loading-overlay"\)/);
  assert.doesNotMatch(loadingManagerJs, /createOverlay/);
  assert.doesNotMatch(loadingManagerJs, /loading-spinner/);
});

test("the drawn trace follows exactly the same geometry as the road", () => {
  const occurrences = baseHtml.split(ROUTE_D).length - 1;
  assert.equal(occurrences, 2, "road + trace should share one route path");
});

test("tracer inherits theme tokens", () => {
  assert.match(tracerCss, /var\(--accent\)/);
  assert.match(tracerCss, /var\(--primary\)/);
});

test("tracer degrades gracefully for reduced motion", () => {
  const reduced = tracerCss.slice(tracerCss.indexOf("prefers-reduced-motion"));
  assert.ok(reduced.length > 0, "a prefers-reduced-motion block must exist");
  assert.match(reduced, /animation:\s*none/);
  assert.match(reduced, /display:\s*none/); // the travelling dot is hidden
});
