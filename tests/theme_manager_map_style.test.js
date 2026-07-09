import assert from "node:assert/strict";
import test from "node:test";

import mapCore from "../static/js/modules/map-core.js";
import themeManager from "../static/js/modules/ui/theme-manager.js";
import { createStorageMock } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  CustomEvent: global.CustomEvent,
  document: global.document,
  localStorage: global.localStorage,
};
const originalMapCore = {
  isReady: mapCore.isReady,
  setStyle: mapCore.setStyle,
};

test.afterEach(() => {
  global.CustomEvent = originalGlobals.CustomEvent;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
  mapCore.isReady = originalMapCore.isReady;
  mapCore.setStyle = originalMapCore.setStyle;
});

function installThemeHarness(storedMapType) {
  const styleChanges = [];
  const events = [];

  global.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  global.document = {
    dispatchEvent(event) {
      events.push(event);
    },
  };
  global.localStorage = createStorageMock({ mapType: storedMapType });
  mapCore.isReady = () => true;
  mapCore.setStyle = async (styleType, options) => {
    styleChanges.push({ styleType, options });
  };

  return { events, styleChanges };
}

test("dark basemap follows a light application theme change", async () => {
  const { events, styleChanges } = installThemeHarness("dark");

  themeManager.updateMapTheme("light");
  await Promise.resolve();

  assert.deepEqual(styleChanges, [
    { styleType: "light", options: { persistPreference: true } },
  ]);
  assert.equal(events.at(-1)?.type, "mapThemeChanged");
  assert.deepEqual(events.at(-1)?.detail, { theme: "light" });
});

test("light basemap follows a dark application theme change", async () => {
  const { events, styleChanges } = installThemeHarness("light");

  themeManager.updateMapTheme("dark");
  await Promise.resolve();

  assert.deepEqual(styleChanges, [
    { styleType: "dark", options: { persistPreference: true } },
  ]);
  assert.equal(events.at(-1)?.type, "mapThemeChanged");
  assert.deepEqual(events.at(-1)?.detail, { theme: "dark" });
});

test("alternate basemaps remain selected when the application theme changes", async () => {
  const { events, styleChanges } = installThemeHarness("satellite");

  themeManager.updateMapTheme("light");
  await Promise.resolve();

  assert.deepEqual(styleChanges, []);
  assert.equal(events.at(-1)?.type, "mapThemeChanged");
  assert.deepEqual(events.at(-1)?.detail, { theme: "light" });
});
