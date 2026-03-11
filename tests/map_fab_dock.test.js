import assert from "node:assert/strict";
import test from "node:test";

import initMapFabDock from "../static/js/modules/features/map/fab-dock.js";
import { createClassList, createEventTarget } from "./helpers/dom-fixtures.js";

const originalGlobals = {
  document: global.document,
  window: global.window,
};

function createElement(initial = {}) {
  const eventTarget = createEventTarget(initial);
  const attributes = new Map();

  return {
    ...eventTarget,
    children: initial.children || [],
    classList: initial.classList || createClassList(),
    hidden: Boolean(initial.hidden),
    style: initial.style || {},
    contains(target) {
      return target === this || this.children.includes(target);
    },
    querySelector(selector) {
      if (selector === "i") {
        return initial.icon || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-map-fab-item]") {
        return this.children.filter((child) => child.dataset?.mapFabItem !== undefined);
      }
      return [];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
  };
}

function createButton({ active = false, hidden = false } = {}) {
  const button = createElement({
    classList: createClassList(active ? ["active"] : []),
    hidden,
  });
  button.dataset = { mapFabItem: "" };
  button.setAttribute("aria-pressed", String(active));
  return button;
}

function createEnvironment() {
  const icon = { className: "fas fa-sliders" };
  const count = createElement({ hidden: true });
  const toggle = createElement({ icon });
  const firstItem = createButton();
  const secondItem = createButton({ active: true });
  const thirdItem = createButton({ hidden: true, active: true });
  const stack = createElement({ children: [firstItem, secondItem, thirdItem] });
  const dock = createElement({
    classList: createClassList(["is-collapsed"]),
    children: [stack, toggle],
  });

  const documentMock = {
    ...createEventTarget(),
    getElementById(id) {
      const lookup = {
        "map-fab-dock": dock,
        "map-fab-dock-stack": stack,
        "map-fab-dock-toggle": toggle,
        "map-fab-dock-count": count,
      };
      return lookup[id] || null;
    },
  };

  const windowMock = {
    ...createEventTarget(),
    innerWidth: 1280,
    matchMedia() {
      return { matches: false };
    },
  };

  return {
    count,
    dock,
    documentMock,
    firstItem,
    secondItem,
    stack,
    thirdItem,
    toggle,
    windowMock,
  };
}

test.afterEach(() => {
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
});

test("map fab dock starts collapsed and toggles open/closed", () => {
  const env = createEnvironment();
  global.document = env.documentMock;
  global.window = env.windowMock;

  const controller = initMapFabDock();

  try {
    assert.equal(env.dock.classList.contains("is-collapsed"), true);
    assert.equal(env.toggle.getAttribute("aria-expanded"), "false");
    assert.equal(env.stack.getAttribute("aria-hidden"), "true");
    assert.equal(env.toggle.getAttribute("aria-label"), "Show map feature toggles (1 active feature)");

    env.toggle.dispatchEvent({ type: "click", target: env.toggle });

    assert.equal(env.dock.classList.contains("is-collapsed"), false);
    assert.equal(env.toggle.getAttribute("aria-expanded"), "true");
    assert.equal(env.stack.getAttribute("aria-hidden"), "false");
    assert.equal(env.toggle.getAttribute("aria-label"), "Hide map feature toggles");

    env.toggle.dispatchEvent({ type: "click", target: env.toggle });

    assert.equal(env.dock.classList.contains("is-collapsed"), true);
    assert.equal(env.toggle.getAttribute("aria-expanded"), "false");
  } finally {
    controller.destroy();
  }
});

test("map fab dock badge sync only counts visible active items", () => {
  const env = createEnvironment();
  global.document = env.documentMock;
  global.window = env.windowMock;

  const controller = initMapFabDock();

  try {
    assert.equal(env.count.hidden, false);
    assert.equal(env.count.textContent, "1");
    assert.equal(env.toggle.classList.contains("active"), true);

    env.secondItem.classList.remove("active");
    env.secondItem.setAttribute("aria-pressed", "false");
    controller.sync();

    assert.equal(env.count.hidden, true);
    assert.equal(env.toggle.classList.contains("active"), false);

    env.firstItem.classList.add("active");
    env.firstItem.setAttribute("aria-pressed", "true");
    controller.sync();

    assert.equal(env.count.hidden, false);
    assert.equal(env.count.textContent, "1");
    assert.equal(env.toggle.classList.contains("active"), true);
  } finally {
    controller.destroy();
  }
});

test("map fab dock collapses when clicking outside the dock", () => {
  const env = createEnvironment();
  global.document = env.documentMock;
  global.window = env.windowMock;

  const controller = initMapFabDock();

  try {
    controller.setExpanded(true);
    assert.equal(env.dock.classList.contains("is-collapsed"), false);

    env.documentMock.dispatchEvent({ type: "click", target: {} });

    assert.equal(env.dock.classList.contains("is-collapsed"), true);
    assert.equal(env.toggle.getAttribute("aria-expanded"), "false");
  } finally {
    controller.destroy();
  }
});
