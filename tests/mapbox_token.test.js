import assert from "node:assert/strict";
import test from "node:test";

class TestDocument {
  constructor() {
    this._metaToken = "";
    this.head = {};
    this.documentElement = {};
  }

  setMetaToken(token) {
    this._metaToken = token || "";
  }

  querySelector(selector) {
    if (selector !== 'meta[name="mapbox-access-token"]') {
      return null;
    }
    const value = (this._metaToken || "").trim();
    if (!value) {
      return null;
    }
    return {
      getAttribute(name) {
        return name === "content" ? value : null;
      },
    };
  }
}

class TestMutationObserver {
  static observers = new Set();

  static notify() {
    TestMutationObserver.observers.forEach((observer) => observer._callback());
  }

  constructor(callback) {
    this._callback = typeof callback === "function" ? callback : () => {};
  }

  observe() {
    TestMutationObserver.observers.add(this);
  }

  disconnect() {
    TestMutationObserver.observers.delete(this);
  }
}

test("waitForMapboxToken returns existing token from meta", async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;

  const doc = new TestDocument();
  doc.setMetaToken("pk.existing-token");
  global.window = {};
  global.document = doc;
  global.MutationObserver = TestMutationObserver;

  const { waitForMapboxToken } = await import("../static/js/modules/mapbox-token.js");

  const token = await waitForMapboxToken({ timeoutMs: 50 });
  assert.equal(token, "pk.existing-token");

  global.window = originalWindow;
  global.document = originalDocument;
  global.MutationObserver = originalMutationObserver;
});

test("waitForMapboxToken resolves after meta appears", async () => {
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalMutationObserver = global.MutationObserver;

  global.window = {};
  const doc = new TestDocument();
  global.document = doc;
  global.MutationObserver = TestMutationObserver;

  const { waitForMapboxToken } = await import("../static/js/modules/mapbox-token.js");

  const tokenPromise = waitForMapboxToken({ timeoutMs: 100 });

  setTimeout(() => {
    doc.setMetaToken("pk.event-token");
    TestMutationObserver.notify();
  }, 10);

  const token = await tokenPromise;
  assert.equal(token, "pk.event-token");

  global.window = originalWindow;
  global.document = originalDocument;
  global.MutationObserver = originalMutationObserver;
});
