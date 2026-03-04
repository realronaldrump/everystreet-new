import assert from "node:assert/strict";
import test from "node:test";

import initMapControls from "../static/js/modules/features/map/map-controls.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  CustomEvent: global.CustomEvent,
};

function createClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(...tokens) {
      tokens.forEach((token) => values.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => values.delete(token));
    },
    contains(token) {
      return values.has(token);
    },
    toggle(token, force) {
      if (force === true) {
        values.add(token);
        return true;
      }
      if (force === false) {
        values.delete(token);
        return false;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    },
  };
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      listeners.set(
        type,
        handlers.filter((candidate) => candidate !== handler)
      );
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event?.type || "") || [];
      handlers.forEach((handler) => handler(event));
      return true;
    },
  };
}

function createButton(streetMode = null) {
  const eventTarget = createEventTarget();
  const dataset = streetMode ? { streetMode } : {};
  const icon = { style: {} };
  return {
    ...eventTarget,
    dataset,
    disabled: false,
    classList: createClassList(),
    setAttribute() {},
    querySelector(selector) {
      return selector === "i" ? icon : null;
    },
  };
}

function createLocationSelect(initialValue = "") {
  const eventTarget = createEventTarget();
  return {
    ...eventTarget,
    value: initialValue,
    triggerChange() {
      this.dispatchEvent({ type: "change", target: this });
    },
  };
}

function createTestEnvironment({ selectedAreaId = "" } = {}) {
  const controls = {
    classList: createClassList(),
  };
  const toggleBtn = createButton();
  const focusBtn = createButton();
  const locationSelect = createLocationSelect(selectedAreaId);
  const streetButtons = ["undriven", "driven", "all"].map((mode) => createButton(mode));
  const dispatchedEvents = [];

  const documentEventTarget = createEventTarget();
  const documentMock = {
    ...documentEventTarget,
    getElementById(id) {
      const lookup = {
        "map-controls": controls,
        "controls-toggle": toggleBtn,
        "streets-location": locationSelect,
        "focus-coverage-area-btn": focusBtn,
      };
      return lookup[id] || null;
    },
    querySelectorAll(selector) {
      if (selector === ".quick-action-btn[data-street-mode]") {
        return streetButtons;
      }
      return [];
    },
    dispatchEvent(event) {
      dispatchedEvents.push(event);
      return documentEventTarget.dispatchEvent(event);
    },
  };

  const windowEventTarget = createEventTarget();
  const windowMock = {
    ...windowEventTarget,
    innerWidth: 1200,
    matchMedia() {
      return { matches: false };
    },
  };

  return {
    controls,
    dispatchedEvents,
    documentMock,
    focusBtn,
    locationSelect,
    streetButtons,
    toggleBtn,
    windowMock,
  };
}

test.beforeEach(() => {
  global.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail || null;
      this.bubbles = Boolean(init.bubbles);
    }
  };
});

test.afterEach(() => {
  global.window = originalGlobals.window;
  global.document = originalGlobals.document;
  global.CustomEvent = originalGlobals.CustomEvent;
});

test("street mode and focus quick actions are disabled when no coverage area is selected", () => {
  const env = createTestEnvironment({ selectedAreaId: "" });
  global.window = env.windowMock;
  global.document = env.documentMock;

  const teardown = initMapControls();

  env.streetButtons.forEach((button) => {
    assert.equal(button.disabled, true);
  });
  assert.equal(env.focusBtn.disabled, true);

  env.documentMock.dispatchEvent(
    new CustomEvent("es:coverage-area-selection-changed", {
      detail: { areaId: "area-123" },
    })
  );
  env.streetButtons.forEach((button) => {
    assert.equal(button.disabled, false);
  });
  assert.equal(env.focusBtn.disabled, false);

  env.documentMock.dispatchEvent(
    new CustomEvent("es:coverage-area-selection-changed", {
      detail: { areaId: "" },
    })
  );
  env.streetButtons.forEach((button) => {
    assert.equal(button.disabled, true);
    assert.equal(button.classList.contains("active"), false);
  });
  assert.equal(env.focusBtn.disabled, true);

  teardown();
});

test("focus action dispatches only when a coverage area is selected", () => {
  const env = createTestEnvironment({ selectedAreaId: "" });
  global.window = env.windowMock;
  global.document = env.documentMock;

  const teardown = initMapControls();

  env.focusBtn.dispatchEvent({ type: "click" });
  assert.equal(
    env.dispatchedEvents.filter(
      (event) => event.type === "es:focus-selected-coverage-area"
    ).length,
    0
  );

  env.locationSelect.value = "area-42";
  env.locationSelect.triggerChange();

  env.focusBtn.dispatchEvent({ type: "click" });
  const focusEvents = env.dispatchedEvents.filter(
    (event) => event.type === "es:focus-selected-coverage-area"
  );
  assert.equal(focusEvents.length, 1);
  assert.deepEqual(focusEvents[0].detail, { areaId: "area-42" });

  teardown();
});
