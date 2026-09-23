import assert from "node:assert/strict";
import test from "node:test";

import VisitsMapController from "../static/js/modules/visits/map-controller.js";
import VisitsManager from "../static/js/modules/visits/visits-manager.js";
import { ensureLibraries } from "../static/js/modules/core/library-loader.js";

const place = {
  id: "place-1",
  name: "Test place",
  geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] },
};

function fakeMap() {
  const handlers = new Map();
  const sources = new Map();
  const layers = new Set();
  return {
    removed: false,
    on(name, ...args) {
      handlers.set(name, args.at(-1));
    },
    off(name) {
      handlers.delete(name);
    },
    emit(name, event) {
      handlers.get(name)?.(event);
    },
    getSource: (name) => sources.get(name),
    addSource(name, source) {
      sources.set(name, { ...source, setData(data) { this.data = data; } });
    },
    getLayer: (name) => layers.has(name),
    addLayer: (layer) => layers.add(layer.id),
    resize() {},
    remove() {
      this.removed = true;
      handlers.clear();
    },
  };
}

function environment(t) {
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalRaf = global.requestAnimationFrame;
  global.document = {
    documentElement: { getAttribute: () => "dark" },
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  global.window = {};
  global.requestAnimationFrame = (callback) => callback();
  t.after(() => {
    global.document = originalDocument;
    global.window = originalWindow;
    global.requestAnimationFrame = originalRaf;
  });
}

test("map timeout releases resources and permits retry with previously loaded places", async (t) => {
  environment(t);
  const maps = [];
  const controller = new VisitsMapController({
    loadLibraries: () => {},
    initializationTimeoutMs: 5,
    mapFactory: () => {
      const map = fakeMap();
      maps.push(map);
      return map;
    },
  });
  t.after(() => controller.destroy());
  controller.setPlaces([place]);
  const first = controller.initialize("dark");
  assert.equal(controller.initialize("dark"), first);
  await assert.rejects(first, /timed out/i);
  assert.equal(maps[0].removed, true);
  assert.equal(controller.getMap(), null);

  const retry = controller.initialize("dark");
  maps[1].emit("load");
  assert.equal(await retry, true);
  assert.equal(maps[1].getSource("custom-places").data.features.length, 1);
});

test("destroy settles a pending map load without waiting for the timeout", async (t) => {
  environment(t);
  const map = fakeMap();
  const controller = new VisitsMapController({ mapFactory: () => map, loadLibraries: () => {} });
  const pending = controller.initialize("dark");
  controller.destroy();
  assert.equal(await pending, false);
  assert.equal(map.removed, true);
  assert.equal(controller.getMap(), null);
  assert.equal(await controller.initialize("dark"), false);
});

test("map deadline includes library loading and ignores libraries arriving after timeout", async (t) => {
  environment(t);
  let finishLibraries;
  const controller = new VisitsMapController({
    initializationTimeoutMs: 5,
    loadLibraries: () => new Promise((resolve) => { finishLibraries = resolve; }),
    mapFactory: () => assert.fail("an expired map attempt must not create a map"),
  });
  t.after(() => controller.destroy());
  await assert.rejects(controller.initialize("dark"), /timed out/i);
  finishLibraries();
  await Promise.resolve();
  assert.equal(controller.getMap(), null);
});

test("places and visit rows render while map initialization is still pending", async (t) => {
  environment(t);
  const manager = new VisitsManager({
    dataService: {
      fetchPlaces: () => assert.fail("page controller owns data requests"),
      fetchPlaceStatistics: () => assert.fail("page controller owns data requests"),
    },
  });
  let finishMap;
  let tablesInitialized = false;
  let eventsInitialized = false;
  let displayed;
  manager.mapController.initialize = () => new Promise((resolve) => { finishMap = resolve; });
  manager.initializeTables = () => {
    tablesInitialized = true;
    manager.visitsTable = {
      clear() { return this; },
      rows: { add(rows) { displayed = rows; return { draw() {} }; } },
    };
  };
  manager.events.setupEventListeners = () => { eventsInitialized = true; };
  manager.loadingManager = { show: () => assert.fail("no page-wide overlay"), hide() {} };
  const pending = manager.initialize();
  assert.equal(tablesInitialized, true);
  assert.equal(eventsInitialized, true);
  manager.setPlaces([place]);
  const stats = Object.freeze([Object.freeze({ id: place.id, name: place.name, totalVisits: 2 })]);
  manager.updateVisitsData(stats);
  assert.equal(displayed[0].totalVisits, 2);
  assert.equal(manager.places.get(place.id), place);
  assert.equal(manager.mapController.customPlacesData.features.length, 1);
  finishMap(false);
  await pending;
});

test("mutations notify the page once without a duplicate statistics request", async (t) => {
  environment(t);
  let calls = 0;
  const manager = new VisitsManager({
    dataService: { fetchPlaceStatistics: () => assert.fail("duplicate statistics fetch") },
    onDataChanged: async () => { calls++; },
  });
  manager.setPlaces([place]);
  await manager.refreshAfterMutation();
  assert.equal(calls, 1);
  manager.destroyed = true;
  await manager.refreshAfterMutation();
  assert.equal(calls, 1);
});

test("map errors remove the spinner and retry only the map while keeping data usable", async (t) => {
  environment(t);
  t.mock.method(console, "error", () => {});
  let retry;
  const overlay = { style: {} };
  const drawButton = {};
  const mapElement = {
    innerHTML: "",
    setAttribute() {},
    querySelector() { return { addEventListener(_name, callback) { retry = callback; } }; },
  };
  document.getElementById = (id) => ({ map: mapElement, "map-loading": overlay, "start-drawing": drawButton }[id] || null);
  const manager = new VisitsManager();
  let tableInitializations = 0;
  let mapInitializations = 0;
  manager.initializeTables = () => { tableInitializations++; };
  manager.events.setupEventListeners = () => {};
  manager.mapController.initialize = async () => {
    if (++mapInitializations === 1) {
      throw new Error("map provider unavailable");
    }
    return true;
  };
  manager.mapController.getMap = () => fakeMap();
  manager.drawing.initialize = () => { manager.drawing.draw = {}; };
  assert.equal(await manager.initialize(), false);
  assert.equal(overlay.style.display, "none");
  assert.match(mapElement.innerHTML, /Retry map/);
  assert.equal(drawButton.disabled, true);
  manager.setPlaces([place]);
  assert.equal(manager.places.size, 1);
  assert.equal(await retry(), true);
  assert.equal(tableInitializations, 1);
  assert.equal(mapInitializations, 2);
  assert.equal(drawButton.disabled, false);
});

test("table libraries do not block events, map initialization, or incoming place statistics", async (t) => {
  environment(t);
  let finishLibraries;
  let displayed;
  let readyCallbacks = 0;
  let mapStarted = false;
  let eventsStarted = false;
  const manager = new VisitsManager({
    loadLibraries: () => new Promise((resolve) => { finishLibraries = resolve; }),
    onTablesReady: () => { readyCallbacks++; },
  });
  manager.events.setupEventListeners = () => { eventsStarted = true; };
  manager.initializeMap = () => { mapStarted = true; return Promise.resolve(false); };
  manager._createTables = () => {
    manager.visitsTable = {
      clear() { return this; },
      rows: { add(rows) { displayed = rows; return { draw() {} }; } },
    };
    manager.tripsTable = {};
  };
  await manager.initialize();
  assert.equal(eventsStarted, true);
  assert.equal(mapStarted, true);
  assert.equal(manager.visitsTable, null);
  manager.setPlaces([place]);
  manager.updateVisitsData([{ id: place.id, totalVisits: 1 }]);
  manager.updateVisitsData([{ id: place.id, totalVisits: 9 }]);
  assert.equal(manager.places.size, 1);
  finishLibraries();
  assert.equal(await manager.tablesInitialization, true);
  assert.equal(displayed[0].totalVisits, 9);
  assert.equal(readyCallbacks, 1);
});

test("table errors are contained in list view and retry restores the latest statistics", async (t) => {
  environment(t);
  t.mock.method(console, "error", () => {});
  let retry;
  const status = {
    hidden: true,
    querySelector: () => ({ addEventListener(_name, callback) { retry = callback; } }),
  };
  const wrapper = {};
  document.getElementById = (id) => ({
    "visits-table-status": status,
    "visits-table": { closest: () => wrapper },
  }[id] || null);
  let calls = 0;
  let displayed;
  const manager = new VisitsManager({
    loadLibraries: async () => {
      if (++calls === 1) throw new Error("CDN unavailable");
    },
  });
  manager._createTables = () => {
    manager.visitsTable = {
      clear() { return this; },
      rows: { add(rows) { displayed = rows; return { draw() {} }; } },
    };
    manager.tripsTable = {};
  };
  manager.setPlaces([place]);
  manager.updateVisitsData([{ id: place.id, totalVisits: 5 }]);
  assert.equal(await manager.initializeTables(), false);
  assert.equal(status.hidden, false);
  assert.equal(wrapper.hidden, true);
  assert.match(status.innerHTML, /Retry list/);
  assert.equal(await retry(), true);
  assert.equal(status.hidden, true);
  assert.equal(wrapper.hidden, false);
  assert.equal(displayed[0].totalVisits, 5);
});

test("table libraries arriving after navigation do not create tables or update the new page", async (t) => {
  environment(t);
  let finishLibraries;
  const manager = new VisitsManager({
    loadLibraries: () => new Promise((resolve) => { finishLibraries = resolve; }),
    onTablesReady: () => assert.fail("late readiness callback"),
  });
  manager._createTables = () => assert.fail("late table creation");
  const pending = manager.initializeTables();
  manager.destroy();
  finishLibraries();
  assert.equal(await pending, false);
});

test("failed library scripts are removed so a list retry starts a fresh download", async (t) => {
  environment(t);
  const originalCdn = global.ES_CDN;
  const originalJquery = global.$;
  global.ES_CDN = { jquery: "https://example.test/jquery.js", datatablesJs: "https://example.test/datatables.js" };
  delete global.$;
  t.after(() => { global.ES_CDN = originalCdn; global.$ = originalJquery; });
  const scripts = [];
  const parent = {
    appendChild(script) {
      script.parentNode = parent;
      scripts.push(script);
    },
  };
  document.scripts = scripts;
  document.head = parent;
  document.getElementById = (id) => scripts.find((script) => script.id === id);
  document.createElement = () => Object.assign(new EventTarget(), {
    getAttribute(name) { return this[name]; },
    remove() {
      scripts.splice(scripts.indexOf(this), 1);
      this.parentNode = null;
    },
  });
  const failed = ensureLibraries(["datatables"]);
  const first = scripts[0];
  first.dispatchEvent(new Event("error"));
  await assert.rejects(failed, /Failed to load library/);
  assert.equal(scripts.length, 0);
  const retried = ensureLibraries(["datatables"]);
  assert.notEqual(scripts[0], first);
  global.$ = { fn: { DataTable() {} } };
  scripts[0].dispatchEvent(new Event("load"));
  await retried;
  assert.equal(scripts.length, 1);
});
