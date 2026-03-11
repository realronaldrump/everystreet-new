import assert from "node:assert/strict";
import test from "node:test";

import store from "../static/js/modules/core/store.js";
import destinationBloom from "../static/js/modules/destination-bloom.js";
import {
  setupDestinationBloomToggle,
  setupMap3dBuildingsToggle,
  setupParticleFlowToggle,
  setupRouteArtToggle,
} from "../static/js/modules/features/map/index.js";
import particleFlow from "../static/js/modules/particle-flow.js";
import routeArt from "../static/js/modules/ui/route-art.js";
import {
  createClassList,
  createCustomEventClass,
  createEventTarget,
  createStorageMock,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  CustomEvent: global.CustomEvent,
  localStorage: global.localStorage,
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
};

const originalStore = {
  map: store.map,
  mapLayers: store.mapLayers,
};

const originalParticleFlow = {
  isActive: particleFlow.isActive,
  activate: particleFlow.activate,
  deactivate: particleFlow.deactivate,
  destroy: particleFlow.destroy,
  refresh: particleFlow.refresh,
};

const originalDestinationBloom = {
  isActive: destinationBloom.isActive,
  activate: destinationBloom.activate,
  deactivate: destinationBloom.deactivate,
  destroy: destinationBloom.destroy,
  refresh: destinationBloom.refresh,
};

const originalRouteArt = {
  isActive: routeArt.isActive,
  launch: routeArt.launch,
  close: routeArt.close,
};

function createButton() {
  const eventTarget = createEventTarget();
  const attributes = new Map();

  return {
    ...eventTarget,
    classList: createClassList(),
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) || null;
    },
  };
}

function createDocumentMock(buttons) {
  const documentTarget = createEventTarget();
  return {
    ...documentTarget,
    getElementById(id) {
      return buttons[id] || null;
    },
  };
}

function dispatchClick(button) {
  button.dispatchEvent({ type: "click" });
}

test.afterEach(() => {
  store.mapLayers = originalStore.mapLayers;
  particleFlow.isActive = originalParticleFlow.isActive;
  particleFlow.activate = originalParticleFlow.activate;
  particleFlow.deactivate = originalParticleFlow.deactivate;
  particleFlow.destroy = originalParticleFlow.destroy;
  particleFlow.refresh = originalParticleFlow.refresh;
  destinationBloom.isActive = originalDestinationBloom.isActive;
  destinationBloom.activate = originalDestinationBloom.activate;
  destinationBloom.deactivate = originalDestinationBloom.deactivate;
  destinationBloom.destroy = originalDestinationBloom.destroy;
  destinationBloom.refresh = originalDestinationBloom.refresh;
  routeArt.isActive = originalRouteArt.isActive;
  routeArt.launch = originalRouteArt.launch;
  routeArt.close = originalRouteArt.close;
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.CustomEvent = originalGlobals.CustomEvent;
  global.localStorage = originalGlobals.localStorage;
  global.setTimeout = originalGlobals.setTimeout;
  global.clearTimeout = originalGlobals.clearTimeout;
  store.map = originalStore.map;
});

test("scene toggles stay mutually exclusive across route art, particle flow, and destination bloom", () => {
  global.CustomEvent = createCustomEventClass();

  const buttons = {
    "route-art-toggle": createButton(),
    "particle-flow-toggle": createButton(),
    "destination-bloom-toggle": createButton(),
  };

  global.document = createDocumentMock(buttons);
  global.window = {};

  store.mapLayers = {
    trips: {
      visible: true,
      layer: {
        features: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [-97.75, 30.25],
                [-97.71, 30.29],
              ],
            },
            properties: { transactionId: "trip-1" },
          },
        ],
      },
    },
    matchedTrips: { visible: false, layer: { features: [] } },
  };

  const cleanupFns = [];
  const registerCleanup = (fn) => cleanupFns.push(fn);

  let particleFlowActive = true;
  let destinationBloomActive = false;
  let routeArtActive = false;
  let particleFlowDestroyCalls = 0;
  let destinationBloomDestroyCalls = 0;
  let routeArtLaunchCalls = 0;

  particleFlow.isActive = () => particleFlowActive;
  particleFlow.activate = () => {
    particleFlowActive = true;
    document.dispatchEvent(new CustomEvent("particleFlow:activated"));
  };
  particleFlow.deactivate = () => {
    particleFlowActive = false;
    document.dispatchEvent(new CustomEvent("particleFlow:deactivated"));
  };
  particleFlow.destroy = () => {
    particleFlowDestroyCalls += 1;
    particleFlowActive = false;
    document.dispatchEvent(new CustomEvent("particleFlow:deactivated"));
  };
  particleFlow.refresh = () => {};

  destinationBloom.isActive = () => destinationBloomActive;
  destinationBloom.activate = () => {
    destinationBloomActive = true;
    document.dispatchEvent(new CustomEvent("destinationBloom:activated"));
  };
  destinationBloom.deactivate = () => {
    destinationBloomActive = false;
    document.dispatchEvent(new CustomEvent("destinationBloom:deactivated"));
  };
  destinationBloom.destroy = () => {
    destinationBloomDestroyCalls += 1;
    destinationBloomActive = false;
    document.dispatchEvent(new CustomEvent("destinationBloom:deactivated"));
  };
  destinationBloom.refresh = () => {};

  routeArt.isActive = () => routeArtActive;
  routeArt.launch = () => {
    routeArtLaunchCalls += 1;
    routeArtActive = true;
    document.dispatchEvent(new CustomEvent("routeArt:activated"));
  };
  routeArt.close = () => {
    routeArtActive = false;
    document.dispatchEvent(new CustomEvent("routeArt:deactivated"));
  };

  setupRouteArtToggle(registerCleanup);
  setupParticleFlowToggle(registerCleanup);
  setupDestinationBloomToggle(registerCleanup);

  dispatchClick(buttons["destination-bloom-toggle"]);
  assert.equal(particleFlowDestroyCalls, 1);
  assert.equal(destinationBloomActive, true);
  assert.equal(buttons["destination-bloom-toggle"].classList.contains("active"), true);
  assert.equal(buttons["particle-flow-toggle"].classList.contains("active"), false);

  dispatchClick(buttons["route-art-toggle"]);
  assert.equal(routeArtLaunchCalls, 1);
  assert.equal(destinationBloomDestroyCalls, 1);
  assert.equal(routeArtActive, true);
  assert.equal(buttons["route-art-toggle"].classList.contains("active"), true);
  assert.equal(buttons["destination-bloom-toggle"].classList.contains("active"), false);

  routeArt.close();
  assert.equal(buttons["route-art-toggle"].classList.contains("active"), false);

  cleanupFns.forEach((fn) => fn());
});

test("destination bloom refreshes on trip reloads, filter changes, and style reloads", () => {
  global.CustomEvent = createCustomEventClass();
  global.setTimeout = (callback) => {
    callback();
    return 1;
  };
  global.clearTimeout = () => {};

  const buttons = {
    "destination-bloom-toggle": createButton(),
  };

  global.document = createDocumentMock(buttons);
  global.window = {};

  let refreshCalls = 0;
  destinationBloom.isActive = () => true;
  destinationBloom.activate = () => {};
  destinationBloom.deactivate = () => {};
  destinationBloom.destroy = () => {};
  destinationBloom.refresh = () => {
    refreshCalls += 1;
  };

  const cleanupFns = [];
  setupDestinationBloomToggle((fn) => cleanupFns.push(fn));

  document.dispatchEvent(new CustomEvent("tripsDataLoaded"));
  document.dispatchEvent(new CustomEvent("matchedTripsDataLoaded"));
  document.dispatchEvent(new CustomEvent("es:filters-change"));
  document.dispatchEvent(new CustomEvent("mapStyleLoaded"));

  assert.equal(refreshCalls, 4);

  cleanupFns.forEach((fn) => fn());
});

test("3D buildings toggle mirrors shared preference and hides when the map style cannot support it", () => {
  global.CustomEvent = createCustomEventClass();
  global.localStorage = createStorageMock();

  const buttons = {
    "map-3d-buildings-fab": createButton(),
    "map-3d-buildings-toggle": { checked: true },
  };

  global.document = createDocumentMock(buttons);
  global.window = {
    MAP_PROVIDER: "self_hosted",
  };

  const vectorStyle = {
    sources: {
      composite: { type: "vector" },
    },
    layers: [{ id: "road-label", type: "symbol", layout: { "text-field": "road" } }],
  };
  const rasterStyle = {
    sources: {
      satellite: { type: "raster" },
    },
    layers: [{ id: "satellite", type: "raster" }],
  };

  const mockMap = {
    getStyle() {
      return vectorStyle;
    },
    addLayer() {},
    getLayer() {
      return null;
    },
  };
  store.map = mockMap;

  const cleanupFns = [];
  setupMap3dBuildingsToggle((fn) => cleanupFns.push(fn));

  assert.equal(buttons["map-3d-buildings-fab"].hidden, false);
  assert.equal(buttons["map-3d-buildings-fab"].getAttribute("aria-pressed"), "true");

  dispatchClick(buttons["map-3d-buildings-fab"]);
  assert.equal(global.localStorage.getItem("map3dBuildingsEnabled"), "false");
  assert.equal(buttons["map-3d-buildings-toggle"].checked, false);
  assert.equal(buttons["map-3d-buildings-fab"].getAttribute("aria-pressed"), "false");

  mockMap.getStyle = () => rasterStyle;
  document.dispatchEvent(new CustomEvent("mapStyleLoaded"));
  assert.equal(buttons["map-3d-buildings-fab"].hidden, true);

  cleanupFns.forEach((fn) => fn());
});
