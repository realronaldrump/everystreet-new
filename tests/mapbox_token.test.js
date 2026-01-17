const assert = require("node:assert/strict");
const test = require("node:test");

class TestDocument {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      return;
    }
    this.listeners.get(type).delete(handler);
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type);
    if (!handlers) {
      return true;
    }
    handlers.forEach((handler) => handler(event));
    return true;
  }

  querySelector() {
    return null;
  }
}

test("waitForMapboxToken returns existing token", async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;

  global.window = { MAPBOX_ACCESS_TOKEN: "pk.existing-token" };
  global.document = new TestDocument();

  const { waitForMapboxToken } = await import(
    "../static/js/modules/mapbox-token.js"
  );

  const token = await waitForMapboxToken({ timeoutMs: 50 });
  assert.equal(token, "pk.existing-token");

  global.window = originalWindow;
  global.document = originalDocument;
});

test("waitForMapboxToken resolves after event", async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalCustomEvent = global.CustomEvent;

  global.window = {};
  global.document = new TestDocument();
  global.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };

  const { MAPBOX_TOKEN_EVENT, waitForMapboxToken } = await import(
    "../static/js/modules/mapbox-token.js"
  );

  const tokenPromise = waitForMapboxToken({ timeoutMs: 100 });

  setTimeout(() => {
    const token = "pk.event-token";
    global.window.MAPBOX_ACCESS_TOKEN = token;
    global.document.dispatchEvent(
      new CustomEvent(MAPBOX_TOKEN_EVENT, { detail: { token } })
    );
  }, 10);

  const token = await tokenPromise;
  assert.equal(token, "pk.event-token");

  global.window = originalWindow;
  global.document = originalDocument;
  global.CustomEvent = originalCustomEvent;
});
