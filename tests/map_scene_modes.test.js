import assert from "node:assert/strict";
import test from "node:test";

import destinationBloom from "../static/js/modules/features/map/destination-bloom.js";
import { setupExclusiveSceneModeGuard } from "../static/js/modules/features/map/index.js";
import particleFlow from "../static/js/modules/features/map/particle-flow.js";
import { createCustomEventClass, createEventTarget } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  CustomEvent: global.CustomEvent,
};

const originalParticleFlow = {
  isActive: particleFlow.isActive,
  activate: particleFlow.activate,
  destroy: particleFlow.destroy,
  ensureTripLayersHidden: particleFlow.ensureTripLayersHidden,
  refresh: particleFlow.refresh,
};

const originalDestinationBloom = {
  isActive: destinationBloom.isActive,
  activate: destinationBloom.activate,
  destroy: destinationBloom.destroy,
  ensureTripLayersHidden: destinationBloom.ensureTripLayersHidden,
  refresh: destinationBloom.refresh,
};

function createDocumentMock() {
  const documentTarget = createEventTarget();
  return {
    ...documentTarget,
    getElementById() {
      return null;
    },
  };
}

test.afterEach(() => {
  particleFlow.isActive = originalParticleFlow.isActive;
  particleFlow.activate = originalParticleFlow.activate;
  particleFlow.destroy = originalParticleFlow.destroy;
  particleFlow.ensureTripLayersHidden = originalParticleFlow.ensureTripLayersHidden;
  particleFlow.refresh = originalParticleFlow.refresh;
  destinationBloom.isActive = originalDestinationBloom.isActive;
  destinationBloom.activate = originalDestinationBloom.activate;
  destinationBloom.destroy = originalDestinationBloom.destroy;
  destinationBloom.ensureTripLayersHidden =
    originalDestinationBloom.ensureTripLayersHidden;
  destinationBloom.refresh = originalDestinationBloom.refresh;
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.CustomEvent = originalGlobals.CustomEvent;
});

test("scene mode guard repairs direct activations and re-hides trips on reload events", () => {
  global.CustomEvent = createCustomEventClass();
  global.document = createDocumentMock();
  global.window = {};

  let particleFlowActive = true;
  let destinationBloomActive = false;
  let particleFlowDestroyCalls = 0;
  let particleFlowHideCalls = 0;
  let destinationBloomDestroyCalls = 0;
  let destinationBloomHideCalls = 0;

  particleFlow.isActive = () => particleFlowActive;
  particleFlow.activate = () => {
    particleFlowActive = true;
    document.dispatchEvent(new CustomEvent("particleFlow:activated"));
  };
  particleFlow.destroy = () => {
    particleFlowDestroyCalls += 1;
    particleFlowActive = false;
    document.dispatchEvent(new CustomEvent("particleFlow:deactivated"));
  };
  particleFlow.ensureTripLayersHidden = () => {
    particleFlowHideCalls += 1;
  };
  particleFlow.refresh = () => {};

  destinationBloom.isActive = () => destinationBloomActive;
  destinationBloom.activate = () => {
    destinationBloomActive = true;
    document.dispatchEvent(new CustomEvent("destinationBloom:activated"));
  };
  destinationBloom.destroy = () => {
    destinationBloomDestroyCalls += 1;
    destinationBloomActive = false;
    document.dispatchEvent(new CustomEvent("destinationBloom:deactivated"));
  };
  destinationBloom.ensureTripLayersHidden = () => {
    destinationBloomHideCalls += 1;
  };
  destinationBloom.refresh = () => {};

  const cleanupFns = [];
  setupExclusiveSceneModeGuard((fn) => cleanupFns.push(fn));

  destinationBloom.activate();

  assert.equal(particleFlowDestroyCalls, 1);
  assert.equal(destinationBloomHideCalls, 1);
  assert.equal(destinationBloomActive, true);
  assert.equal(particleFlowActive, false);

  document.dispatchEvent(new CustomEvent("tripsDataLoaded"));
  document.dispatchEvent(new CustomEvent("matchedTripsDataLoaded"));
  document.dispatchEvent(new CustomEvent("es:filters-change"));
  document.dispatchEvent(new CustomEvent("es:layers-change"));
  document.dispatchEvent(new CustomEvent("mapStyleLoaded"));

  assert.equal(destinationBloomHideCalls, 6);
  assert.equal(particleFlowHideCalls, 1);
  assert.equal(destinationBloomDestroyCalls, 0);

  cleanupFns.forEach((fn) => fn());
});

test("scene mode guard prefers particle flow when it is the surviving mode", () => {
  global.CustomEvent = createCustomEventClass();
  global.document = createDocumentMock();
  global.window = {};

  let particleFlowActive = false;
  let destinationBloomActive = true;
  let destinationBloomDestroyCalls = 0;
  let particleFlowHideCalls = 0;

  particleFlow.isActive = () => particleFlowActive;
  particleFlow.activate = () => {
    particleFlowActive = true;
    document.dispatchEvent(new CustomEvent("particleFlow:activated"));
  };
  particleFlow.destroy = () => {
    particleFlowActive = false;
  };
  particleFlow.ensureTripLayersHidden = () => {
    particleFlowHideCalls += 1;
  };
  particleFlow.refresh = () => {};

  destinationBloom.isActive = () => destinationBloomActive;
  destinationBloom.destroy = () => {
    destinationBloomDestroyCalls += 1;
    destinationBloomActive = false;
  };
  destinationBloom.ensureTripLayersHidden = () => {};
  destinationBloom.refresh = () => {};

  const cleanupFns = [];
  setupExclusiveSceneModeGuard((fn) => cleanupFns.push(fn));

  particleFlow.activate();

  assert.equal(destinationBloomDestroyCalls, 1);
  assert.equal(particleFlowActive, true);
  assert.equal(particleFlowHideCalls, 1);
  assert.equal(destinationBloomActive, false);

  cleanupFns.forEach((fn) => fn());
});
