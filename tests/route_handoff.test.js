import assert from "node:assert/strict";
import test from "node:test";

import { OptimalRoutesManager } from "../static/js/modules/optimal-route/manager.js";
import LiveNavigationAPI, {
  buildLiveNavigationUrl,
} from "../static/js/modules/live-navigation/live-navigation-api.js";
import LiveNavigationNavigator from "../static/js/modules/live-navigation/live-navigation-navigator.js";
import { OptimalRouteAPI } from "../static/js/modules/optimal-route/api.js";

const route = {
  route_id: "cluster-result",
  area_id: "area-1",
  kind: "cluster",
  selected_segment_ids: ["street-1"],
  coordinates: [
    [-107, 39],
    [-107, 39.01],
  ],
};
const noop = () => {};
let previousWindow;
test.beforeEach(() => {
  previousWindow = global.window;
  global.window = {
    location: { href: "https://www.everystreet.me/coverage-route-planner?area=area-1" },
    history: {
      replaceState(_state, _title, url) {
        global.window.location.href = String(url);
      },
    },
    localStorage: { setItem: noop },
  };
});
test.afterEach(() => {
  global.window = previousWindow;
});

test("cluster task result stays selected for preview, reload URL and export", async () => {
  const manager = Object.assign(Object.create(OptimalRoutesManager.prototype), {
    currentTaskId: "task-cluster",
    selectedAreaId: "area-1",
    selectionEpoch: 1,
    coverageAreas: [
      { id: "area-1", optimal_route_id: "old-full-route", has_optimal_route: true },
    ],
    api: {
      loadTaskResult: async (taskId) => {
        assert.equal(taskId, "task-cluster");
        return route;
      },
    },
    map: {
      displayRoute: (coordinates) => assert.deepEqual(coordinates, route.coordinates),
    },
    ui: { showResults: noop, updateSavedRoutes: noop, showNotification: noop },
  });
  await manager.onGenerationComplete();
  assert.equal(manager.currentRouteId, route.route_id);
  assert.equal(manager.coverageAreas[0].optimal_route_id, "old-full-route");
  assert.equal(
    new URL(window.location.href).searchParams.get("routeId"),
    route.route_id
  );
  assert.equal(new URL(window.location.href).searchParams.has("taskId"), false);
  let exported;
  window.open = (url) => {
    exported = url;
  };
  manager.exportGPX();
  assert.equal(exported, "/api/generated-routes/cluster-result/gpx");
  assert.equal(
    buildLiveNavigationUrl({
      areaId: manager.selectedAreaId,
      routeId: manager.currentRouteId,
    }),
    "/live-navigation?areaId=area-1&routeId=cluster-result"
  );
});

test("late generation result cannot overwrite a newly selected area", async () => {
  let finish;
  const manager = Object.assign(Object.create(OptimalRoutesManager.prototype), {
    currentTaskId: "old-task",
    selectedAreaId: "area-1",
    selectionEpoch: 1,
    api: {
      loadTaskResult: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    acceptRouteResult: () => assert.fail("A stale result was displayed"),
  });
  const pending = manager.onGenerationComplete();
  manager.selectionEpoch += 1;
  manager.selectedAreaId = "area-2";
  finish(route);
  await pending;
});

test("failed progress at 100 percent is never interpreted as successful completion", () => {
  let completed = 0;
  let failed = 0;
  const api = new OptimalRouteAPI({
    onComplete: () => completed++,
    onError: () => failed++,
  });
  api.handleTerminalState({ status: "failed", progress: 100 });
  assert.equal(completed, 0);
  assert.equal(failed, 1);
});

function fakeNavigator() {
  return Object.assign(Object.create(LiveNavigationNavigator.prototype), {
    selectedAreaId: "area-1",
    selectedRouteId: route.route_id,
    ui: new Proxy({}, { get: () => noop }),
    map: new Proxy({}, { get: (_target, key) => (key === "mapReady" ? false : noop) }),
    coverage: { loadSegments: async () => {} },
    state: { transitionTo: noop },
    buildRouteMetrics() {
      this.totalDistance = 100;
    },
    buildManeuvers() {
      this.maneuvers = [];
    },
    fetchRouteETA: async () => {},
    checkRouteStale: noop,
    autoGenerateRoute: () =>
      assert.fail("Explicit route selection must never generate another route"),
  });
}

test("navigation loads the exact cluster even when a full-area route exists", async (t) => {
  t.mock.method(LiveNavigationAPI, "fetchCoverageArea", async () => ({
    has_optimal_route: true,
  }));
  t.mock.method(LiveNavigationAPI, "fetchGeneratedRoute", async (id) => {
    assert.equal(id, route.route_id);
    return route;
  });
  t.mock.method(LiveNavigationAPI, "fetchOptimalRoute", () =>
    assert.fail("Wrong route lookup")
  );
  const navigator = fakeNavigator();
  await navigator.loadRoute();
  assert.equal(navigator.routeLoaded, true);
  assert.deepEqual(navigator.routeCoords, route.coordinates);
  assert.equal(
    new URL(window.location.href).searchParams.get("routeId"),
    route.route_id
  );
});

test("a deleted explicit route does not fall through to full-area generation", async (t) => {
  t.mock.method(LiveNavigationAPI, "fetchCoverageArea", async () => ({
    has_optimal_route: false,
  }));
  t.mock.method(LiveNavigationAPI, "fetchGeneratedRoute", async () => {
    throw Object.assign(new Error("Route not found"), { status: 404 });
  });
  const navigator = fakeNavigator();
  await navigator.loadRoute();
  assert.equal(navigator.routeLoaded, false);
  assert.equal(navigator.selectedAreaId, "area-1");
});

test("regenerating a cluster retains its requested streets and starting point", async () => {
  const start = [-107, 39];
  const navigator = fakeNavigator();
  navigator.currentRouteData = { ...route, start_coords: start };
  navigator.resetRouteState = function () {
    this.currentRouteData = null;
  };
  navigator.autoGenerateRoute = async (segments, coords) => {
    assert.deepEqual(segments, route.selected_segment_ids);
    assert.deepEqual(coords, start);
  };
  await navigator.regenerateRoute();
});
