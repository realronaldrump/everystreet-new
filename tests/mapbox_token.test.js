import assert from "node:assert/strict";
import test from "node:test";

import {
  getMapboxToken,
  isMapboxStyleUrl,
  waitForMapboxToken,
} from "../static/js/modules/mapbox-token.js";

test("getMapboxToken is empty without server-injected configuration", () => {
  assert.equal(getMapboxToken(), "");
});

test("waitForMapboxToken rejects without server-injected configuration", async () => {
  await assert.rejects(
    waitForMapboxToken({ timeoutMs: 1 }),
    /Mapbox access token not configured/
  );
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
