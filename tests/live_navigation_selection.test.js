import assert from "node:assert/strict";
import test from "node:test";

import LiveNavigationAPI from "../static/js/modules/live-navigation/live-navigation-api.js";
import LiveNavigationNavigator from "../static/js/modules/live-navigation/live-navigation-navigator.js";

const originalWindow = global.window;
const originalLocation = global.location;

function createWindowMock({ search = "", storedArea = null } = {}) {
  const storage = new Map();
  if (storedArea !== null) {
    storage.set("liveNavigationAreaId", storedArea);
  }

  return {
    location: {
      href: `https://www.everystreet.me/live-navigation${search}`,
      search,
      pathname: "/live-navigation",
      hash: "",
    },
    history: {
      replaceState() {},
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
}

test.beforeEach(() => {
  global.window = createWindowMock();
  global.location = global.window.location;
});

test.afterEach(() => {
  global.window = originalWindow;
  global.location = originalLocation;
});

test("clearPersistedAreaSelection removes stale selection from storage and URL", () => {
  global.window = createWindowMock({
    search: "?areaId=stale-area&autoStart=true",
    storedArea: "stale-area",
  });
  global.location = global.window.location;

  let replacedPath = null;
  global.window.history.replaceState = (_state, _title, nextPath) => {
    replacedPath = nextPath;
  };

  LiveNavigationNavigator.prototype.clearPersistedAreaSelection.call({}, "stale-area");

  assert.equal(global.window.localStorage.getItem("liveNavigationAreaId"), null);
  assert.equal(replacedPath, "/live-navigation?autoStart=true");
});

test("applyInitialSelection invalidates stale area ids before route loading", async () => {
  global.window = createWindowMock({ search: "?areaId=stale-area" });
  global.location = global.window.location;

  const calls = {
    invalidated: null,
    loaded: 0,
  };

  const fake = {
    coverageAreas: [{ id: "valid-area", display_name: "Valid Area" }],
    selectedAreaId: null,
    selectedAreaName: null,
    ui: {
      setAreaSelectValue() {},
      getSelectedAreaName() {
        return "";
      },
    },
    findCoverageAreaById: LiveNavigationNavigator.prototype.findCoverageAreaById,
    invalidateSelectedArea(id, payload) {
      calls.invalidated = { id, payload };
    },
    loadRoute: async () => {
      calls.loaded += 1;
    },
  };

  await LiveNavigationNavigator.prototype.applyInitialSelection.call(fake);

  assert.deepEqual(calls.invalidated, {
    id: "stale-area",
    payload: { message: "Selected coverage area is no longer available." },
  });
  assert.equal(calls.loaded, 0);
});

test("loadRoute auto-generates when selected area has no optimal route", async () => {
  const originalFetchCoverageArea = LiveNavigationAPI.fetchCoverageArea;
  const originalFetchOptimalRouteGpx = LiveNavigationAPI.fetchOptimalRouteGpx;

  let gpxFetches = 0;
  let autoGenerateCalls = 0;

  LiveNavigationAPI.fetchCoverageArea = async () => ({
    success: true,
    area: { id: "area-1" },
    has_optimal_route: false,
  });
  LiveNavigationAPI.fetchOptimalRouteGpx = async () => {
    gpxFetches += 1;
    return "";
  };

  const fake = {
    selectedAreaId: "area-1",
    routeLoaded: false,
    ui: {
      setSetupStatus() {},
      setNavStatus() {},
      setLoadRouteLoading() {},
      setStartEnabled() {},
      resetGuidanceUI() {},
    },
    autoGenerateRoute: async () => {
      autoGenerateCalls += 1;
    },
    map: {
      clearRouteLayers() {},
    },
  };

  try {
    await LiveNavigationNavigator.prototype.loadRoute.call(fake);
    assert.equal(autoGenerateCalls, 1);
    assert.equal(gpxFetches, 0);
  } finally {
    LiveNavigationAPI.fetchCoverageArea = originalFetchCoverageArea;
    LiveNavigationAPI.fetchOptimalRouteGpx = originalFetchOptimalRouteGpx;
  }
});
