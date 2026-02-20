import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "../static/js/modules/core/config.js";
import {
  buildMapboxRasterTileUrl,
  getCurrentTheme,
  resolveMapStyle,
} from "../static/js/modules/core/map-style-resolver.js";

const originalDocument = global.document;

test.afterEach(() => {
  global.document = originalDocument;
});

test("getCurrentTheme returns dark by default", () => {
  global.document = undefined;
  assert.equal(getCurrentTheme(), "dark");
});

test("getCurrentTheme reads light theme from document", () => {
  global.document = {
    documentElement: {
      getAttribute(name) {
        return name === "data-bs-theme" ? "light" : null;
      },
    },
  };
  assert.equal(getCurrentTheme(), "light");
});

test("resolveMapStyle prefers requested style when available", () => {
  const resolved = resolveMapStyle({ requestedType: "satellite", theme: "light" });
  assert.equal(resolved.styleType, "satellite");
  assert.equal(resolved.styleUrl, CONFIG.MAP.styles.satellite);
});

test("resolveMapStyle falls back to theme style for unknown requested type", () => {
  const resolved = resolveMapStyle({ requestedType: "unknown", theme: "light" });
  assert.equal(resolved.styleType, "light");
  assert.equal(resolved.styleUrl, CONFIG.MAP.styles.light);
});

test("buildMapboxRasterTileUrl builds raster endpoint from style URL", () => {
  const url = buildMapboxRasterTileUrl({
    styleUrl: CONFIG.MAP.styles.dark,
    token: "pk.test-token-12345678901234567890",
  });
  assert.match(url, /https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/dark-v11\/tiles\/256/);
  assert.match(url, /access_token=pk\.test-token-12345678901234567890/);
});

test("buildMapboxRasterTileUrl throws for non-mapbox style URL", () => {
  assert.throws(
    () =>
      buildMapboxRasterTileUrl({
        styleUrl: "https://example.com/style.json",
        token: "pk.test-token-12345678901234567890",
      }),
    /Invalid Mapbox style URL/
  );
});

test("buildMapboxRasterTileUrl throws when token missing", () => {
  assert.throws(
    () =>
      buildMapboxRasterTileUrl({
        styleUrl: CONFIG.MAP.styles.dark,
        token: "",
      }),
    /Mapbox access token not configured/
  );
});

