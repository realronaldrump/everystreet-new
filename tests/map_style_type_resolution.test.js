import assert from "node:assert/strict";
import test from "node:test";

import { resolveActiveStyleType } from "../static/js/modules/features/map/map-style.js";
import { createStorageMock } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  document: global.document,
  localStorage: global.localStorage,
};

test.afterEach(() => {
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
});

test("resolveActiveStyleType parses JSON-quoted stored map types", () => {
  global.document = { getElementById: () => null };
  global.localStorage = createStorageMock({ mapType: '"light"' });

  assert.equal(resolveActiveStyleType(), "light");
});

test("resolveActiveStyleType prefers the live basemap select over storage", () => {
  global.document = {
    getElementById: (id) => (id === "map-type-select" ? { value: "Satellite" } : null),
  };
  global.localStorage = createStorageMock({ mapType: '"dark"' });

  assert.equal(resolveActiveStyleType(), "satellite");
});

test("resolveActiveStyleType falls back to dark when nothing is stored", () => {
  global.document = { getElementById: () => null };
  global.localStorage = createStorageMock();

  assert.equal(resolveActiveStyleType(), "dark");
});
