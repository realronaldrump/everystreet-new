import assert from "node:assert/strict";
import test from "node:test";

import {
  getTripLayerHeatmapPreference,
  setTripLayerHeatmapPreference,
} from "../static/js/modules/features/map/trip-layer-render-mode.js";
import {
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  CustomEvent: global.CustomEvent,
  document: global.document,
  localStorage: global.localStorage,
  window: global.window,
};

function createDocumentMock(elements = {}) {
  return {
    ...createEventTarget(),
    getElementById(id) {
      return elements[id] || null;
    },
  };
}

test.beforeEach(() => {
  global.CustomEvent = createCustomEventClass();
  global.document = createDocumentMock();
  global.localStorage = createStorageMock();
  global.window = {
    APP_SETTINGS_FLAGS: {
      tripLayersUseHeatmap: true,
    },
  };
});

test.afterEach(() => {
  global.CustomEvent = originalGlobals.CustomEvent;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
  global.window = originalGlobals.window;
});

test("getTripLayerHeatmapPreference falls back to app settings flags", () => {
  assert.equal(getTripLayerHeatmapPreference(), true);

  global.window.APP_SETTINGS_FLAGS.tripLayersUseHeatmap = false;
  assert.equal(getTripLayerHeatmapPreference(), false);
});

test("setTripLayerHeatmapPreference persists state, syncs controls, and emits events", () => {
  const settingsToggle = { checked: true };
  const received = [];
  global.document = createDocumentMock({
    "trip-layers-use-heatmap": settingsToggle,
  });
  global.document.addEventListener(
    "es:trip-layer-render-mode-setting-changed",
    (event) => {
      received.push(event.detail?.useHeatmap);
    }
  );

  assert.equal(setTripLayerHeatmapPreference(false), true);
  assert.equal(global.localStorage.getItem("tripLayersUseHeatmap"), "false");
  assert.equal(settingsToggle.checked, false);
  assert.equal(global.window.APP_SETTINGS_FLAGS.tripLayersUseHeatmap, false);
  assert.deepEqual(received, [false]);
});
