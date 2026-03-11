import assert from "node:assert/strict";
import test from "node:test";

import {
  createClassList,
  createEventTarget,
} from "./helpers/dom-fixtures.js";

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

test("trip stats widget ignores duplicate init calls and expands on click", async () => {
  const originalDocument = global.document;
  const originalSetTimeout = global.setTimeout;

  const widget = createElement();
  const card = createElement();
  const compact = createElement();
  const expanded = createElement({ style: { display: "none" } });
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

  global.document = documentMock;
  global.setTimeout = (handler) => {
    handler();
    return 0;
  };

  try {
    const { default: tripStatsWidget } = await import(
      "../static/js/modules/trip-stats-widget.js"
    );

    tripStatsWidget.init();

    assert.equal(toggle.listeners.get("click")?.length, 1);

    toggle.dispatchEvent({ type: "click" });

    assert.equal(tripStatsWidget.isExpanded, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(expanded.style.display, "block");
    assert.equal(expanded.classList.contains("is-visible"), true);
  } finally {
    global.document = originalDocument;
    global.setTimeout = originalSetTimeout;
  }
});
