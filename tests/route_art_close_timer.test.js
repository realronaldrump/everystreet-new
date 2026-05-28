import assert from "node:assert/strict";
import test, { after } from "node:test";

const originalDocument = global.document;
const originalWindow = global.window;
const originalLocalStorage = global.localStorage;
const originalRequestAnimationFrame = global.requestAnimationFrame;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

const storage = new Map();
function createClassList() {
  const classes = new Set();
  return {
    add(...names) {
      names.forEach((name) => classes.add(name));
    },
    remove(...names) {
      names.forEach((name) => classes.delete(name));
    },
    contains(name) {
      return classes.has(name);
    },
    toggle(name, enabled) {
      if (enabled === undefined) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      }
      if (enabled) {
        classes.add(name);
      } else {
        classes.delete(name);
      }
      return enabled;
    },
  };
}
function createDomNode() {
  return {
    className: "",
    innerHTML: "",
    role: "",
    style: {},
    dataset: {},
    classList: createClassList(),
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      if (child) {
        child.parentNode = null;
      }
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    addEventListener() {},
    remove() {
      if (this.parentNode?.removeChild) {
        this.parentNode.removeChild(this);
      }
    },
  };
}

global.localStorage = {
  clear() {
    storage.clear();
  },
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  removeItem(key) {
    storage.delete(key);
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
};

global.window = {
  CountUp: null,
  countUp: null,
  location: {
    origin: "https://example.test",
    pathname: "/landing",
  },
  matchMedia: () => ({ matches: false }),
};

global.document = {
  readyState: "loading",
  addEventListener() {},
  createElement() {
    return createDomNode();
  },
  removeEventListener() {},
  getElementById() {
    return null;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  documentElement: {
    setAttribute() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
  },
  body: {
    appendChild(child) {
      child.parentNode = this;
      return child;
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    dataset: {},
    style: {},
  },
};

const { RouteArt } = await import("../static/js/modules/features/map/route-art.js");

after(() => {
  global.document = originalDocument;
  global.window = originalWindow;
  global.localStorage = originalLocalStorage;
  global.requestAnimationFrame = originalRequestAnimationFrame;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});

test("RouteArt cancels stale close timers before reopening", () => {
  const originalSetTimeoutRef = global.setTimeout;
  const originalClearTimeoutRef = global.clearTimeout;
  const timers = [];

  global.setTimeout = (fn, delay) => {
    const handle = { fn, delay, cleared: false };
    timers.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle) {
      handle.cleared = true;
    }
  };

  const createOverlayNode = () => {
    const node = createDomNode();
    node.removed = false;
    node.parentNode = {
      removeChild(child) {
        child.parentNode = null;
      },
    };
    node.remove = () => {
      node.removed = true;
      node.parentNode?.removeChild?.(node);
    };
    return node;
  };

  try {
    const routeArt = new RouteArt();
    const firstOverlay = createOverlayNode();
    const secondOverlay = createOverlayNode();
    let openCount = 0;

    routeArt._createOverlay = () => {
      routeArt._container = openCount === 0 ? firstOverlay : secondOverlay;
      routeArt._canvas = {};
      openCount += 1;
    };
    routeArt._render = () => {};

    routeArt.launch({ trips: [{ geometry: { type: "LineString", coordinates: [] } }] });
    routeArt.close();
    const firstCloseTimer = timers.at(-1);

    routeArt.launch({ trips: [{ geometry: { type: "LineString", coordinates: [] } }] });
    assert.equal(firstCloseTimer?.cleared, true);

    routeArt.close();
    const secondCloseTimer = timers.at(-1);
    secondCloseTimer.fn();

    assert.equal(firstOverlay.removed, false);
    assert.equal(secondOverlay.removed, true);
  } finally {
    global.setTimeout = originalSetTimeoutRef;
    global.clearTimeout = originalClearTimeoutRef;
  }
});
