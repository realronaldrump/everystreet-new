import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetGoogleMapsLoaderForTests,
  waitForGoogleMaps,
} from "../static/js/modules/maps/google_maps_loader.js";

class MockScriptElement {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(eventName, handler) {
    const handlers = this.listeners.get(eventName) || [];
    handlers.push(handler);
    this.listeners.set(eventName, handlers);
  }

  removeEventListener(eventName, handler) {
    const handlers = this.listeners.get(eventName) || [];
    this.listeners.set(
      eventName,
      handlers.filter((candidate) => candidate !== handler)
    );
  }

  dispatch(eventName) {
    const handlers = this.listeners.get(eventName) || [];
    handlers.forEach((handler) => handler());
  }
}

function installGlobals({
  provider = "google",
  configured = true,
  state = configured ? "pending" : "unconfigured",
  error = null,
  script = null,
  bootstrapPromise = null,
} = {}) {
  globalThis.window = {
    MAP_PROVIDER: provider,
    GOOGLE_MAPS_BOOTSTRAP: {
      configured,
      scriptId: "es-google-maps-js-api",
    },
    __esGoogleMapsLoadState: {
      status: state,
      error,
    },
  };

  if (bootstrapPromise) {
    globalThis.window.__esGoogleMapsLoadPromise = bootstrapPromise;
  }

  globalThis.document = {
    getElementById(id) {
      return id === "es-google-maps-js-api" ? script : null;
    },
    querySelector() {
      return null;
    },
  };
}

function resetGlobals() {
  __resetGoogleMapsLoaderForTests();
  delete globalThis.google;
  delete globalThis.document;
  delete globalThis.window;
}

test.beforeEach(() => {
  resetGlobals();
});

test.afterEach(() => {
  resetGlobals();
});

test("waitForGoogleMaps fails fast when Google provider is selected without an API key", async () => {
  installGlobals({
    configured: false,
    state: "unconfigured",
  });

  await assert.rejects(
    waitForGoogleMaps(50),
    /no Google Maps API key is configured/i
  );
});

test("waitForGoogleMaps resolves from the shared Google bootstrap promise", async () => {
  const script = new MockScriptElement();
  const importLibraryCalls = [];
  let resolveBootstrap;

  installGlobals({
    configured: true,
    state: "pending",
    script,
    bootstrapPromise: new Promise((resolve) => {
      resolveBootstrap = resolve;
    }),
  });

  const waitPromise = waitForGoogleMaps(500);

  setTimeout(() => {
    globalThis.google = {
      maps: {
        Map: class MockGoogleMap {},
        async importLibrary(libraryName) {
          importLibraryCalls.push(libraryName);
          return { Map: this.Map };
        },
      },
    };
    globalThis.window.__esGoogleMapsLoadState.status = "loaded";
    resolveBootstrap(true);
    script.dispatch("load");
  }, 0);

  await waitPromise;
  assert.ok(importLibraryCalls.includes("maps"));
});

test("waitForGoogleMaps surfaces Google bootstrap failures immediately", async () => {
  installGlobals({
    configured: true,
    state: "failed",
    error: "Google Maps JavaScript API failed to load.",
  });

  await assert.rejects(
    waitForGoogleMaps(50),
    /Google Maps JavaScript API failed to load/i
  );
});
