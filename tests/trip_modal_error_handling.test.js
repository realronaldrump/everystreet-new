import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL(
    "../static/js/modules/features/trips/index.js",
    import.meta.url
  ),
  "utf8"
);
const loadTripDataSource = source.slice(source.indexOf("async function loadTripData"));

test("trip detail loading handles missing trips as a recoverable state", () => {
  assert.match(loadTripDataSource, /err\?\.status === 404/);
  assert.match(loadTripDataSource, /This trip is no longer available/);
  assert.match(loadTripDataSource, /tripModalInstance\?\.hide\(\)/);
  assert.match(loadTripDataSource, /err\?\.name === "AbortError"/);
});
