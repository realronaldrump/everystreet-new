import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const controllerPath = path.join(
  root,
  "static",
  "js",
  "modules",
  "features",
  "visits",
  "visits-controller.js"
);

test("Visits deep-link contract handles both place and place_name query params", () => {
  const controllerSource = fs.readFileSync(controllerPath, "utf8");

  assert.match(
    controllerSource,
    /get\(\s*["']place["']\s*\)/,
    "visits-controller.js should read the place query param"
  );

  assert.match(
    controllerSource,
    /get\(\s*["']place_name["']\s*\)/,
    "visits-controller.js should read the place_name query param"
  );

  assert.match(
    controllerSource,
    /this\.showPlaceDetail\(/,
    "visits-controller.js should open place detail from deep-link handling"
  );
});
