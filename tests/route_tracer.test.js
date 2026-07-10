import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseHtml = readFileSync(join(root, "templates/base.html"), "utf8");
const tracerCss = readFileSync(join(root, "static/css/route-tracer.css"), "utf8");
const loadingManagerJs = readFileSync(
  join(root, "static/js/modules/ui/loading-manager.js"),
  "utf8"
);
const loadingStyles = readFileSync(join(root, "static/css/loading-styles.css"), "utf8");

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
  assert.match(tracerCss, /var\(--action\)/);
  assert.match(tracerCss, /var\(--action-rgb\)/);
  assert.doesNotMatch(tracerCss, /var\(--accent\)/);
});

test("tracer degrades gracefully for reduced motion", () => {
  const reduced = tracerCss.slice(tracerCss.indexOf("prefers-reduced-motion"));
  assert.ok(reduced.length > 0, "a prefers-reduced-motion block must exist");
  assert.match(reduced, /animation:\s*none/);
  assert.match(reduced, /display:\s*none/); // the travelling dot is hidden
});

test("map loading status is anchored above map furniture and the mobile sheet", () => {
  assert.match(
    loadingStyles,
    /body\[data-route="\/map"\] \.loading-overlay\.non-blocking \.loading-indicator/
  );
  assert.match(loadingStyles, /bottom:\s*calc\(var\(--space-3\) \+ 30px\)/);
  assert.match(loadingStyles, /var\(--map-sheet-visible-height, 96px\)/);
  assert.match(loadingStyles, /font-family:\s*var\(--font-family-mono\)/);
});
