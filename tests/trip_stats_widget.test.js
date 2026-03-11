import assert from "node:assert/strict";
import test from "node:test";

import {
  createClassList,
  createEventTarget,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  document: global.document,
  setTimeout: global.setTimeout,
  window: global.window,
};

function createElement(initial = {}) {
  const eventTarget = createEventTarget(initial);
  const attributes = new Map();

  return {
    ...eventTarget,
    classList: initial.classList || createClassList(),
    style: initial.style || {},
    offsetHeight: initial.offsetHeight || 0,
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
  };
}

function createTripStatsEnvironment() {
  const viewport = { mobile: false };
  const container = {
    clientWidth: 1200,
    clientHeight: 900,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
  };
  const header = createElement({
    classList: createClassList(),
    releasePointerCapture() {},
    setPointerCapture() {},
  });
  const widget = createElement({
    classList: createClassList(),
    parentElement: container,
    offsetWidth: 320,
    offsetHeight: 172,
    getBoundingClientRect() {
      const left = !this.style.left ? 12 : Number.parseFloat(this.style.left);
      const top = !this.style.top ? 12 : Number.parseFloat(this.style.top);
      return {
        left,
        top,
        width: this.offsetWidth,
        height: this.offsetHeight,
      };
    },
  });
  const card = createElement();
  const compact = createElement({
    querySelector(selector) {
      return selector === ".trip-stats-header" ? header : null;
    },
  });
  const expanded = createElement({ style: { display: "none" }, offsetHeight: 96 });
  const toggle = createElement();
  const totalTripsCompact = createElement();
  const totalDistanceCompact = createElement();
  const detailedTrips = createElement();
  const detailedDistance = createElement();
  const detailedAvgDistance = createElement();
  const detailedAvgSpeed = createElement();
  const detailedAvgStart = createElement({ textContent: "--:--" });
  const detailedAvgDuration = createElement({ textContent: "--:--" });

  const elements = {
    "trip-stats-widget": widget,
    "trip-stats-card": card,
    "trip-stats-compact": compact,
    "trip-stats-expanded": expanded,
    "trip-stats-toggle": toggle,
    "widget-total-trips": totalTripsCompact,
    "widget-total-distance": totalDistanceCompact,
    "widget-detailed-trips": detailedTrips,
    "widget-detailed-distance": detailedDistance,
    "widget-detailed-avg-distance": detailedAvgDistance,
    "widget-detailed-avg-speed": detailedAvgSpeed,
    "widget-detailed-avg-start": detailedAvgStart,
    "widget-detailed-avg-duration": detailedAvgDuration,
  };

  const documentMock = {
    ...createEventTarget(),
    readyState: "complete",
    getElementById(id) {
      return elements[id] || null;
    },
  };

  const windowMock = {
    ...createEventTarget(),
    innerWidth: 1200,
    matchMedia() {
      return { matches: viewport.mobile };
    },
    requestAnimationFrame(callback) {
      callback();
      return 0;
    },
  };

  return {
    card,
    compact,
    container,
    documentMock,
    expanded,
    header,
    setMobile(value) {
      viewport.mobile = Boolean(value);
    },
    toggle,
    widget,
    windowMock,
  };
}

async function loadTripStatsWidget(env) {
  global.document = env.documentMock;
  global.window = env.windowMock;

  const { default: tripStatsWidget } = await import(
    "../static/js/modules/trip-stats-widget.js"
  );

  tripStatsWidget.destroy?.();
  tripStatsWidget.init();
  return tripStatsWidget;
}

test.afterEach(() => {
  global.document = originalGlobals.document;
  global.setTimeout = originalGlobals.setTimeout;
  global.window = originalGlobals.window;
});

test("trip stats widget ignores duplicate init calls and expands on click", async () => {
  const env = createTripStatsEnvironment();
  global.setTimeout = (handler) => {
    handler();
    return 0;
  };

  const tripStatsWidget = await loadTripStatsWidget(env);

  try {
    tripStatsWidget.init();

    assert.equal(env.toggle.listeners.get("click")?.length, 1);

    env.toggle.dispatchEvent({ type: "click" });

    assert.equal(tripStatsWidget.isExpanded, true);
    assert.equal(env.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(env.expanded.style.display, "block");
    assert.equal(env.expanded.classList.contains("is-visible"), true);
  } finally {
    tripStatsWidget.destroy();
  }
});

test("trip stats widget can be dragged by its header on desktop", async () => {
  const env = createTripStatsEnvironment();
  const tripStatsWidget = await loadTripStatsWidget(env);

  try {
    env.header.dispatchEvent({
      type: "pointerdown",
      pointerId: 11,
      button: 0,
      clientX: 60,
      clientY: 80,
      preventDefault() {},
      target: {
        closest() {
          return null;
        },
      },
    });
    env.header.dispatchEvent({
      type: "pointermove",
      pointerId: 11,
      clientX: 110,
      clientY: 140,
    });

    assert.equal(env.widget.style.left, "62px");
    assert.equal(env.widget.style.top, "72px");
    assert.equal(env.widget.classList.contains("dragging"), true);

    env.header.dispatchEvent({
      type: "pointerup",
      pointerId: 11,
    });

    assert.equal(env.widget.classList.contains("dragging"), false);
    assert.equal(env.header.classList.contains("dragging"), false);
  } finally {
    tripStatsWidget.destroy();
  }
});

test("trip stats widget clears desktop drag positioning at the mobile breakpoint", async () => {
  const env = createTripStatsEnvironment();
  const tripStatsWidget = await loadTripStatsWidget(env);

  try {
    env.header.dispatchEvent({
      type: "pointerdown",
      pointerId: 15,
      button: 0,
      clientX: 60,
      clientY: 80,
      preventDefault() {},
      target: {
        closest() {
          return null;
        },
      },
    });
    env.header.dispatchEvent({
      type: "pointermove",
      pointerId: 15,
      clientX: 160,
      clientY: 210,
    });
    env.header.dispatchEvent({
      type: "pointerup",
      pointerId: 15,
    });

    assert.equal(env.widget.style.left, "112px");
    assert.equal(env.widget.style.top, "142px");

    env.setMobile(true);
    env.windowMock.dispatchEvent({ type: "resize" });

    assert.equal(env.widget.style.left, "");
    assert.equal(env.widget.style.top, "");
    assert.equal(env.widget.style.right, "");
    assert.equal(env.widget.style.bottom, "");
  } finally {
    tripStatsWidget.destroy();
  }
});
