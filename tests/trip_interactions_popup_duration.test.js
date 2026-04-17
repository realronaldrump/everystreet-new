import assert from "node:assert/strict";
import test from "node:test";

test("trip popup formats duration from numeric strings", async () => {
  const { default: tripInteractions } = await import(
    "../static/js/modules/trip-interactions.js"
  );

  const html = tripInteractions.createPopupContent({
    properties: {
      transactionId: "trip-1",
      duration: "345",
      distance: 12.5,
      avgSpeed: 42.3,
      maxSpeed: 58,
    },
  });

  assert.match(html, />5m 45s</);
  assert.doesNotMatch(html, /NaN/);
});

test("trip popup falls back to timestamps when duration is invalid", async () => {
  const { default: tripInteractions } = await import(
    "../static/js/modules/trip-interactions.js"
  );

  const html = tripInteractions.createPopupContent({
    properties: {
      transactionId: "trip-2",
      duration: "not-a-number",
      startTime: "2026-03-03T10:00:00Z",
      endTime: "2026-03-03T10:05:00Z",
      distance: 3.2,
    },
  });

  assert.match(html, />5m 0s</);
  assert.doesNotMatch(html, /NaN/);
});

test("deck trip popups defer outside-map click closing", async () => {
  const { default: tripInteractions } = await import(
    "../static/js/modules/trip-interactions.js"
  );

  const originalMap = globalThis.mapboxgl;
  const store = (await import("../static/js/modules/core/store.js")).default;
  const originalStateMap = store.map;
  const listeners = new Map();
  let removed = false;
  let closeHandler = null;

  globalThis.mapboxgl = {
    Popup: class {
      setLngLat() {
        return this;
      }
      setHTML() {
        return this;
      }
      addTo() {
        return this;
      }
      on(eventName, handler) {
        if (eventName === "close") {
          closeHandler = handler;
        }
      }
      remove() {
        removed = true;
        closeHandler?.();
      }
      getElement() {
        return { addEventListener() {} };
      }
    },
  };
  store.map = {
    on(eventName, handler) {
      listeners.set(eventName, handler);
    },
    off(eventName, handler) {
      if (listeners.get(eventName) === handler) {
        listeners.delete(eventName);
      }
    },
  };

  try {
    tripInteractions.handleTripClick(
      { lngLat: [-97, 32] },
      {
        properties: {
          transactionId: "trip-1",
          startTime: "2026-03-03T10:00:00Z",
          endTime: "2026-03-03T10:05:00Z",
        },
      },
      "trips",
      { closeOnClick: false }
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(typeof listeners.get("click"), "function");
    listeners.get("click")();
    assert.equal(removed, true);
    assert.equal(listeners.has("click"), false);
  } finally {
    globalThis.mapboxgl = originalMap;
    store.map = originalStateMap;
  }
});
