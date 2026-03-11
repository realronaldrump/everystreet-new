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
const wrappedExperience = (await import("../static/js/modules/ui/wrapped.js")).default;
const { CelebrationManager } = await import("../static/js/modules/ui/celebrations.js");
const { RouteArt } = await import("../static/js/modules/ui/route-art.js");
const {
  cleanupLandingTransientUi,
  resolveDateRange,
  updateStatContext,
} = await import("../static/js/modules/features/landing/index.js");
const { CoverageTimelapse } = await import(
  "../static/js/modules/coverage-timelapse.js"
);

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

function createStoryStatCard() {
  const classes = new Set();
  return {
    classList: {
      contains(name) {
        return classes.has(name);
      },
      toggle(name, enabled) {
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
  };
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

test("cleanupLandingTransientUi closes the wrapped overlay immediately", () => {
  const originalClose = wrappedExperience.close;
  let received = null;
  wrappedExperience.close = (options) => {
    received = options;
  };

  try {
    cleanupLandingTransientUi();
    assert.deepEqual(received, { immediate: true });
  } finally {
    wrappedExperience.close = originalClose;
  }
});

test("updateStatContext clears previously revealed story text for empty ranges", () => {
  const milesCard = createStoryStatCard();
  const tripsCard = createStoryStatCard();
  const milesCtx = {
    textContent: "",
    closest() {
      return milesCard;
    },
  };
  const tripsCtx = {
    textContent: "",
    closest() {
      return tripsCard;
    },
  };
  const originalDocumentRef = global.document;
  global.document = {
    ...originalDocumentRef,
    getElementById(id) {
      if (id === "stat-miles-context") return milesCtx;
      if (id === "stat-trips-context") return tripsCtx;
      return null;
    },
  };

  try {
    updateStatContext(120, 6);
    assert.equal(milesCtx.textContent.length > 0, true);
    assert.equal(tripsCtx.textContent, "~20.0 mi per trip");
    assert.equal(milesCard.classList.contains("stat-revealed"), true);
    assert.equal(tripsCard.classList.contains("stat-revealed"), true);

    updateStatContext(0, 0);
    assert.equal(milesCtx.textContent, "");
    assert.equal(tripsCtx.textContent, "");
    assert.equal(milesCard.classList.contains("stat-revealed"), false);
    assert.equal(tripsCard.classList.contains("stat-revealed"), false);
  } finally {
    global.document = originalDocumentRef;
  }
});

test("CoverageTimelapse progress uses the full eligible street count", () => {
  const timelapse = new CoverageTimelapse();
  const dateLabel = { textContent: "" };
  const statsLabel = { textContent: "" };
  const progressBar = { style: {} };

  timelapse._controlsEl = {
    querySelector(selector) {
      if (selector === ".timelapse-date") return dateLabel;
      if (selector === ".timelapse-stats") return statsLabel;
      if (selector === ".timelapse-progress-fill") return progressBar;
      return null;
    },
  };
  timelapse._segments = [
    { firstDriven: Date.parse("2026-01-01T00:00:00Z") },
    { firstDriven: Date.parse("2026-01-02T00:00:00Z") },
  ];
  timelapse._totalSegments = 5;
  timelapse._currentDate = Date.parse("2026-01-03T00:00:00Z");

  let payload = null;
  timelapse._onUpdate = (data) => {
    payload = data;
  };

  timelapse._updateDisplay();

  assert.equal(statsLabel.textContent, "2 / 5 streets (40.0%)");
  assert.equal(progressBar.style.width, "40%");
  assert.equal(payload.totalCount, 5);
  assert.equal(payload.percent, 40);
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

test("CelebrationManager applies the visible badge lifecycle classes", () => {
  const originalDocumentRef = global.document;
  const originalSetTimeoutRef = global.setTimeout;
  const originalClearTimeoutRef = global.clearTimeout;
  const originalRequestAnimationFrameRef = global.requestAnimationFrame;
  const timers = [];
  let badge = null;

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
  global.requestAnimationFrame = (fn) => {
    fn();
    return 1;
  };
  global.document = {
    ...originalDocumentRef,
    getElementById() {
      return null;
    },
    createElement() {
      return createDomNode();
    },
    body: {
      ...originalDocumentRef.body,
      appendChild(child) {
        badge = child;
        child.parentNode = this;
        return child;
      },
      removeChild(child) {
        if (badge === child) {
          badge = null;
        }
        child.parentNode = null;
      },
    },
  };

  try {
    const manager = new CelebrationManager();
    manager._showBadge({
      title: "Halfway There!",
      value: "50%",
      subtitle: "Keep exploring",
      icon: "fa-bolt",
      accent: "#4d9a6a",
    });

    assert.equal(badge?.classList.contains("entering"), true);

    const dismissTimer = timers[0];
    dismissTimer.fn();
    assert.equal(badge?.classList.contains("exiting"), true);
  } finally {
    global.document = originalDocumentRef;
    global.setTimeout = originalSetTimeoutRef;
    global.clearTimeout = originalClearTimeoutRef;
    global.requestAnimationFrame = originalRequestAnimationFrameRef;
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
