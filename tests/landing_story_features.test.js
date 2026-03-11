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

const store = (await import("../static/js/modules/core/store.js")).default;
const { CONFIG: APP_CONFIG } = await import("../static/js/modules/core/config.js");
const { RouteArt } = await import("../static/js/modules/ui/route-art.js");
const { resolveDateRange } = await import("../static/js/modules/features/landing/index.js");

after(() => {
  global.document = originalDocument;
  global.window = originalWindow;
  global.localStorage = originalLocalStorage;
  global.requestAnimationFrame = originalRequestAnimationFrame;
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
});

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("resolveDateRange uses fallback windows when no explicit date filter is set", () => {
  const originalGet = store.get;
  store.get = () => null;
  storage.clear();

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expectedStart = new Date(today);
    expectedStart.setDate(expectedStart.getDate() - 13);

    const range = resolveDateRange({ fallbackDays: 14 });

    assert.deepEqual(range, {
      startDate: formatLocalDate(expectedStart),
      endDate: formatLocalDate(today),
    });
  } finally {
    store.get = originalGet;
  }
});

test("resolveDateRange honors explicit stored filters before fallback defaults", () => {
  const originalGet = store.get;
  store.get = () => null;
  storage.clear();
  storage.set(APP_CONFIG.STORAGE_KEYS.startDate, "2026-02-01");
  storage.set(APP_CONFIG.STORAGE_KEYS.endDate, "2026-02-15");

  try {
    const range = resolveDateRange({ fallbackDays: 30 });
    assert.deepEqual(range, {
      startDate: "2026-02-01",
      endDate: "2026-02-15",
    });
  } finally {
    store.get = originalGet;
  }
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
