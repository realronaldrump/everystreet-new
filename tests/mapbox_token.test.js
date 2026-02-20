import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "../static/js/modules/core/config.js";
import {
  getMapboxToken,
  isMapboxStyleUrl,
  waitForMapboxToken,
} from "../static/js/modules/mapbox-token.js";

const ORIGINAL_TOKEN = CONFIG.MAP.accessToken;

test.afterEach(() => {
  CONFIG.MAP.accessToken = ORIGINAL_TOKEN;
});

test("getMapboxToken returns the configured token", () => {
  CONFIG.MAP.accessToken = "pk.config-token-12345678901234567890";
  assert.equal(getMapboxToken(), "pk.config-token-12345678901234567890");
});

test("waitForMapboxToken resolves immediately with configured token", async () => {
  CONFIG.MAP.accessToken = "pk.immediate-token-12345678901234567890";
  const token = await waitForMapboxToken({ timeoutMs: 1 });
  assert.equal(token, "pk.immediate-token-12345678901234567890");
});

test("waitForMapboxToken throws when token is not configured", async () => {
  CONFIG.MAP.accessToken = "";
  await assert.rejects(
    () => waitForMapboxToken({ timeoutMs: 1 }),
    /Mapbox access token not configured/
  );
});

test("isMapboxStyleUrl detects mapbox styles and API URLs", () => {
  assert.equal(isMapboxStyleUrl("mapbox://styles/mapbox/dark-v11"), true);
  assert.equal(isMapboxStyleUrl("https://api.mapbox.com/styles/v1/mapbox/light-v11"), true);
  assert.equal(isMapboxStyleUrl("https://example.com/style.json"), false);
  assert.equal(isMapboxStyleUrl(""), false);
});

