import assert from "node:assert/strict";
import test from "node:test";

import initCinematicIntro from "../static/js/modules/features/map/cinematic-intro.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  localStorage: global.localStorage,
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
};

function createStorageMock() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      handlers.push(handler);
      listeners.set(eventName, handlers);
    },
    removeEventListener(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        handlers.filter((candidate) => candidate !== handler)
      );
    },
    dispatch(eventName, payload = {}) {
      const handlers = listeners.get(eventName) || [];
      handlers.forEach((handler) => handler(payload));
    },
  };
}

function createMockMap() {
  const listeners = new Map();

  return {
    moving: false,
    onCalls: [],
    offCalls: [],
    easeToCalls: [],
    setBearingCalls: [],
    stopCalls: 0,
    on(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      handlers.push(handler);
      listeners.set(eventName, handlers);
      this.onCalls.push(eventName);
    },
    off(eventName, handler) {
      const handlers = listeners.get(eventName) || [];
      listeners.set(
        eventName,
        handlers.filter((candidate) => candidate !== handler)
      );
      this.offCalls.push(eventName);
    },
    trigger(eventName, payload = {}) {
      const handlers = listeners.get(eventName) || [];
      handlers.forEach((handler) => handler(payload));
    },
    isMoving() {
      return this.moving;
    },
    getStyle() {
      return {
        sources: {
          composite: { type: "vector" },
        },
      };
    },
    easeTo(options = {}) {
      this.easeToCalls.push(options);
    },
    getBearing() {
      return 12;
    },
    setBearing(value) {
      this.setBearingCalls.push(value);
    },
    stop() {
      this.stopCalls += 1;
    },
  };
}

function makeMatchMedia({ reduced = false, coarse = false } = {}) {
  return (query) => {
    if (query === "(prefers-reduced-motion: reduce)") {
      return { matches: reduced };
    }
    if (query === "(pointer: coarse)") {
      return { matches: coarse };
    }
    return { matches: false };
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await sleep(10);
  }
  return false;
}

function setupGlobals({ reducedMotion = false, coarsePointer = false, width = 1280 } = {}) {
  const windowTarget = createEventTarget();
  global.window = {
    MAP_PROVIDER: "self_hosted",
    innerWidth: width,
    matchMedia: makeMatchMedia({ reduced: reducedMotion, coarse: coarsePointer }),
    addEventListener: windowTarget.addEventListener,
    removeEventListener: windowTarget.removeEventListener,
    dispatchEvent(event) {
      windowTarget.dispatch(event?.type || "", event);
    },
  };

  const documentTarget = createEventTarget();
  global.document = {
    hidden: false,
    addEventListener: documentTarget.addEventListener,
    removeEventListener: documentTarget.removeEventListener,
    getElementById() {
      return null;
    },
    dispatchEvent(event) {
      documentTarget.dispatch(event?.type || "", event);
      return true;
    },
  };

  global.localStorage = createStorageMock();
  global.requestAnimationFrame = (callback) =>
    setTimeout(() => callback(Date.now()), 8);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
}

test.afterEach(() => {
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.localStorage = originalGlobals.localStorage;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.cancelAnimationFrame = originalGlobals.cancelAnimationFrame;
});

test("cinematic intro does not run when reduced motion is preferred", async () => {
  setupGlobals({ reducedMotion: true, width: 1400 });
  const map = createMockMap();

  const controller = initCinematicIntro({
    map,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: true,
      initialPitch: 60,
      rotationDegPerSec: 0.25,
      maxDurationMs: 60,
    },
  });

  await sleep(50);

  assert.equal(controller.isActive(), false);
  assert.equal(map.easeToCalls.length, 0);
});

test("cinematic intro does not run on non-desktop viewport", async () => {
  setupGlobals({ width: 900 });
  const map = createMockMap();

  const controller = initCinematicIntro({
    map,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: true,
      initialPitch: 60,
      rotationDegPerSec: 0.25,
      maxDurationMs: 60,
    },
  });

  await sleep(50);

  assert.equal(controller.isActive(), false);
  assert.equal(map.easeToCalls.length, 0);
});

test("cinematic intro runs once and honors first-visit storage gate", async () => {
  setupGlobals({ width: 1400 });

  const firstMap = createMockMap();
  const firstController = initCinematicIntro({
    map: firstMap,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: true,
      initialPitch: 60,
      rotationDegPerSec: 1,
      maxDurationMs: 40,
    },
  });

  const firstStarted = await waitFor(() => firstMap.easeToCalls.length > 0);
  assert.equal(firstStarted, true);
  firstController.destroy();

  const secondMap = createMockMap();
  const secondController = initCinematicIntro({
    map: secondMap,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: true,
      initialPitch: 60,
      rotationDegPerSec: 1,
      maxDurationMs: 40,
    },
  });

  await sleep(70);

  assert.equal(secondController.isActive(), false);
  assert.equal(secondMap.easeToCalls.length, 0);
});

test("cinematic intro stops immediately on user interaction", async () => {
  setupGlobals({ width: 1400 });
  const map = createMockMap();

  const controller = initCinematicIntro({
    map,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: false,
      initialPitch: 60,
      rotationDegPerSec: 0.5,
      maxDurationMs: 5000,
    },
  });

  const started = await waitFor(() => map.easeToCalls.length > 0);
  assert.equal(started, true);

  map.trigger("dragstart", { originalEvent: {} });
  await sleep(30);

  assert.equal(controller.isActive(), false);
  assert.ok(map.stopCalls >= 1);
});

test("cinematic intro cleanup unregisters listeners and cancels animation", async () => {
  setupGlobals({ width: 1400 });
  const map = createMockMap();

  const controller = initCinematicIntro({
    map,
    config: {
      enabled: true,
      desktopOnly: true,
      firstVisitOnly: false,
      initialPitch: 60,
      rotationDegPerSec: 0.5,
      maxDurationMs: 5000,
    },
  });

  const started = await waitFor(() => map.easeToCalls.length > 0);
  assert.equal(started, true);
  const onCallCount = map.onCalls.length;

  controller.destroy();
  await sleep(20);

  assert.equal(controller.isActive(), false);
  assert.ok(map.stopCalls >= 1);
  assert.ok(map.offCalls.length >= onCallCount);
});
