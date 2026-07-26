import assert from "node:assert/strict";
import test from "node:test";

import {
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

const setWindowLocation = (href) => {
  const url = new URL(href, "https://www.everystreet.me");
  global.window.location = {
    href: url.toString(),
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
  };
};

const historyCalls = [];

global.CustomEvent = createCustomEventClass();
global.document = {
  ...createEventTarget(),
  title: "Every Street - Map",
  body: null,
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};
global.localStorage = createStorageMock();
global.sessionStorage = createStorageMock();
global.window = {
  ...createEventTarget(),
  APP_SETTINGS_FLAGS: {},
  MAP_PROVIDER: "self_hosted",
  history: {
    state: null,
    replaceState(state, _title, href) {
      historyCalls.push(href);
      this.state = state;
      setWindowLocation(href);
    },
    pushState(state, _title, href) {
      historyCalls.push(href);
      this.state = state;
      setWindowLocation(href);
    },
  },
  innerWidth: 1440,
  matchMedia() {
    return { matches: false };
  },
};
global.requestAnimationFrame = (callback) => {
  callback();
  return 1;
};
global.CSS = { escape: (value) => String(value) };
setWindowLocation("https://www.everystreet.me/map");

const { CONFIG } = await import("../static/js/modules/core/config.js");
const store = (await import("../static/js/modules/core/store.js")).default;
const mapCore = (await import("../static/js/modules/map-core.js")).default;
const googleMapCore = (await import(
  "../static/js/modules/maps/google_map.js"
)).default;
const mapManager = (await import("../static/js/modules/map-manager.js")).default;
const tripMapRenderer = (await import(
  "../static/js/modules/trip-map-renderer.js"
)).default;
const AppController = (await import("../static/js/modules/app-controller.js")).default;

const originalFitBounds = mapManager.fitBounds;

function createMapMock() {
  return {
    fitBoundsCalls: [],
    jumpToCalls: [],
    fitBounds(bounds, options) {
      this.fitBoundsCalls.push({ bounds, options });
    },
    jumpTo(view) {
      this.jumpToCalls.push(view);
    },
  };
}

function resetHarness() {
  historyCalls.length = 0;
  global.localStorage = createStorageMock();
  global.sessionStorage = createStorageMock();
  setWindowLocation("https://www.everystreet.me/map");

  store.state = store.getDefaultState();
  store.map = createMapMock();
  store.mapInitialized = true;
  store.mapLayers = JSON.parse(JSON.stringify(CONFIG.LAYER_DEFAULTS));
  tripMapRenderer.layers.clear();
  mapManager.fitBounds = originalFitBounds;
}

test.beforeEach(resetHarness);

test.afterEach(() => {
  mapManager.fitBounds = originalFitBounds;
});

test("trip auto-fit ignores visible auxiliary map geometry", async () => {
  tripMapRenderer.layers.set("trips", {
    bundle: {
      bbox: [-97.0, 32.0, -96.0, 33.0],
      trip_count: 1,
      trips: [{ id: "trip-1" }],
    },
  });
  store.mapLayers.coverageAreaBoundingBox.visible = true;
  store.mapLayers.coverageAreaBoundingBox.layer = {
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [-107.3, 39.3],
            [-107.1, 39.5],
          ],
        },
      },
    ],
  };

  await mapManager.fitBounds(false);

  assert.deepEqual(store.map.fitBoundsCalls, [
    {
      bounds: [
        [-97.0, 32.0],
        [-96.0, 33.0],
      ],
      options: { duration: 0, maxZoom: 15, padding: 50 },
    },
  ]);
  assert.deepEqual(store.map.jumpToCalls, []);
});

test("empty trip bounds restore the configured default camera", async () => {
  store.mapLayers.coverageAreaBoundingBox.visible = true;
  store.mapLayers.coverageAreaBoundingBox.layer = {
    features: [
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [-96.7, 32.8],
            [-96.5, 33.0],
          ],
        },
      },
    ],
  };

  await mapManager.fitBounds(false);

  assert.deepEqual(store.map.fitBoundsCalls, []);
  assert.deepEqual(store.map.jumpToCalls, [
    {
      center: CONFIG.MAP.defaultCenter,
      zoom: CONFIG.MAP.defaultZoom,
    },
  ]);
});

test("bare or stale camera state cannot override the configured default", () => {
  global.localStorage = createStorageMock({
    mapView: JSON.stringify({ center: [-96.6389, 32.9126], zoom: 13.36 }),
  });
  setWindowLocation(
    "https://www.everystreet.me/map?lat=32.91260&lng=-96.63890&zoom=13.36"
  );

  const expectedView = {
    center: CONFIG.MAP.defaultCenter,
    zoom: CONFIG.MAP.defaultZoom,
  };
  assert.deepEqual(mapCore._getInitialView({}), expectedView);
  assert.deepEqual(googleMapCore._getInitialView({}), expectedView);
});

test("explicit map-view links retain their requested camera", () => {
  setWindowLocation(
    "https://www.everystreet.me/map?map_view=1&lat=32.91260&lng=-96.63890&zoom=13.36"
  );

  const expectedView = {
    center: [-96.6389, 32.9126],
    zoom: 13.36,
  };
  assert.deepEqual(mapCore._getInitialView({}), expectedView);
  assert.deepEqual(googleMapCore._getInitialView({}), expectedView);
});

test("SPA navigation applies only explicitly marked map views", () => {
  store.state.map.view = null;
  store.applyUrlParams(
    "https://www.everystreet.me/map?lat=32.91260&lng=-96.63890&zoom=13.36",
    { emit: false, persist: false }
  );
  assert.equal(store.state.map.view, null);

  store.applyUrlParams(
    "https://www.everystreet.me/map?map_view=1&lat=32.91260&lng=-96.63890&zoom=13.36",
    { emit: false, persist: false }
  );
  assert.deepEqual(store.state.map.view, {
    center: [-96.6389, 32.9126],
    zoom: 13.36,
  });
});

test("map movement does not inject camera coordinates into the URL", () => {
  store.state.filters.startDate = "2026-07-26";
  store.state.filters.endDate = "2026-07-26";
  store.state.map.view = {
    center: [-96.6389, 32.9126],
    zoom: 13.36,
  };

  store.syncUrl({ replace: true });

  const currentUrl = new URL(global.window.location.href);
  assert.equal(currentUrl.searchParams.get("start"), "2026-07-26");
  assert.equal(currentUrl.searchParams.get("end"), "2026-07-26");
  assert.equal(currentUrl.searchParams.has("lat"), false);
  assert.equal(currentUrl.searchParams.has("lng"), false);
  assert.equal(currentUrl.searchParams.has("zoom"), false);
});

test("initial explicit map-view links are not replaced by trip auto-fit", () => {
  let fitCalls = 0;
  mapManager.fitBounds = () => {
    fitCalls += 1;
  };
  setWindowLocation(
    "https://www.everystreet.me/map?map_view=1&lat=32.91260&lng=-96.63890&zoom=13.36"
  );

  AppController._applyPostInitialization();

  assert.equal(fitCalls, 0);
});
