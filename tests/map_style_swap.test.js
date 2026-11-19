import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "../static/js/modules/core/config.js";
import { preferredMapStyleType } from "../static/js/modules/core/map-style-resolver.js";
import state from "../static/js/modules/core/store.js";
import mapCore from "../static/js/modules/map-core.js";
import {
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

global.CustomEvent = createCustomEventClass();
global.document = {
  ...createEventTarget(),
  documentElement: { getAttribute: () => "dark" },
};
global.localStorage = createStorageMock();
global.window = {};

/**
 * A Mapbox map seconds after load: tiles are still streaming, so
 * isStyleLoaded() is false even though the style itself is in.
 */
function createStreamingMap() {
  const listeners = new Map();
  const emit = (type) => {
    for (const fn of [...(listeners.get(type) || [])]) {
      fn();
    }
  };
  return {
    styleCalls: [],
    jumpCalls: [],
    on(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    off(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((listener) => listener !== fn)
      );
    },
    isStyleLoaded: () => false,
    setStyle(url, options) {
      this.styleCalls.push({ url, options });
      setTimeout(() => emit("style.load"), 0);
    },
    jumpTo(view) {
      this.jumpCalls.push(view);
    },
    remove() {},
  };
}

const map = createStreamingMap();
state.map = map;
state.mapInitialized = true;

test.after(() => mapCore.destroy());

test("re-requesting the showing style while tiles stream does not reload it", async () => {
  await mapCore.setStyle("dark");
  map.styleCalls.length = 0;

  let handlerRuns = 0;
  const ref = mapCore.registerStyleChangeHandler(1, () => {
    handlerRuns += 1;
  });
  await mapCore.setStyle("dark", { persistPreference: true });
  mapCore.unregisterStyleChangeHandler(ref);

  assert.deepEqual(map.styleCalls, []);
  assert.equal(handlerRuns, 0);
});

test("switching basemaps rebuilds the style and never moves the camera", async () => {
  map.jumpCalls.length = 0;
  map.styleCalls.length = 0;

  const handled = [];
  const ref = mapCore.registerStyleChangeHandler(1, (styleType) => {
    handled.push(styleType);
  });
  await mapCore.setStyle("satellite");
  mapCore.unregisterStyleChangeHandler(ref);

  assert.deepEqual(map.styleCalls, [
    { url: CONFIG.MAP.styles.satellite, options: { diff: false } },
  ]);
  assert.deepEqual(map.jumpCalls, []);
  assert.deepEqual(handled, ["satellite"]);
});

test("the map opens on a picked basemap, or on the theme for dark and light", () => {
  assert.equal(preferredMapStyleType("satellite", "light"), "satellite");
  assert.equal(preferredMapStyleType("streets", "dark"), "streets");
  assert.equal(preferredMapStyleType("dark", "light"), "light");
  assert.equal(preferredMapStyleType("light", "dark"), "dark");
  assert.equal(preferredMapStyleType(null, "light"), "light");
  assert.equal(preferredMapStyleType("unknown", "dark"), "dark");
});
