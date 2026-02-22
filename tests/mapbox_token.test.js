import assert from "node:assert/strict";
import test from "node:test";

import { MAPBOX_PUBLIC_ACCESS_TOKEN } from "../static/js/modules/core/config.js";
import {
  getMapboxToken,
  isMapboxStyleUrl,
  waitForMapboxToken,
} from "../static/js/modules/mapbox-token.js";

test("getMapboxToken returns the hard-coded token", () => {
  assert.equal(getMapboxToken(), MAPBOX_PUBLIC_ACCESS_TOKEN);
});

test("waitForMapboxToken resolves immediately with hard-coded token", async () => {
  const token = await waitForMapboxToken({ timeoutMs: 1 });
  assert.equal(token, MAPBOX_PUBLIC_ACCESS_TOKEN);
});

test("isMapboxStyleUrl detects mapbox styles and API URLs", () => {
  assert.equal(isMapboxStyleUrl("mapbox://styles/mapbox/dark-v11"), true);
  assert.equal(
    isMapboxStyleUrl("https://api.mapbox.com/styles/v1/mapbox/light-v11"),
    true
  );
  assert.equal(isMapboxStyleUrl("https://example.com/style.json"), false);
  assert.equal(isMapboxStyleUrl(""), false);
});
