import assert from "node:assert/strict";
import test from "node:test";

import initMapControls from "../static/js/modules/features/map/map-controls.js";
import {
  createClassList,
  createCustomEventClass,
  createEventTarget,
} from "./helpers/dom-fixtures.js";

const originalGlobals = {
  window: global.window,
  document: global.document,
  CustomEvent: global.CustomEvent,
};

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
  const viewport = { mobile: false };
  const controlsParent = {
    clientWidth: 1200,
    clientHeight: 900,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
    },
  };
  const header = createEventTarget({
    classList: createClassList(),
    releasePointerCapture() {},
    setPointerCapture() {},
  });
  const controls = createEventTarget({
    classList: createClassList(),
    parentElement: controlsParent,
    offsetWidth: 360,
    offsetHeight: 420,
    getBoundingClientRect() {
      const left = !this.style.left ? 16 : Number.parseFloat(this.style.left);
      const top =
        !this.style.top
          ? controlsParent.clientHeight - this.offsetHeight - 16
          : Number.parseFloat(this.style.top);
      return {
        left,
        top,
        width: this.offsetWidth,
        height: this.offsetHeight,
      };
    },
    querySelector(selector) {
      return selector === ".control-panel-header" ? header : null;
    },
  });
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
      return { matches: viewport.mobile };
    },
  };

  return {
    controls,
    controlsParent,
    dispatchedEvents,
    documentMock,
    focusBtn,
    header,
    locationSelect,
    setMobile(value) {
      viewport.mobile = Boolean(value);
    },
    streetButtons,
    toggleBtn,
    windowMock,
  };
}

test.beforeEach(() => {
  global.CustomEvent = createCustomEventClass();
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

test("desktop map controls panel can be dragged from its header", () => {
  const env = createTestEnvironment({ selectedAreaId: "area-42" });
  global.window = env.windowMock;
  global.document = env.documentMock;

  const teardown = initMapControls();
  try {
    env.header.dispatchEvent({
      type: "pointerdown",
      pointerId: 7,
      button: 0,
      clientX: 100,
      clientY: 500,
      preventDefault() {},
      target: {
        closest() {
          return null;
        },
      },
    });
    env.header.dispatchEvent({
      type: "pointermove",
      pointerId: 7,
      clientX: 140,
      clientY: 460,
    });

    assert.equal(env.controls.style.left, "56px");
    assert.equal(env.controls.style.top, "424px");
    assert.equal(env.controls.classList.contains("desktop-dragging"), true);

    env.header.dispatchEvent({
      type: "pointerup",
      pointerId: 7,
    });

    assert.equal(env.controls.classList.contains("desktop-dragging"), false);
    assert.equal(env.header.classList.contains("dragging"), false);
  } finally {
    teardown();
  }
});

test("desktop drag position is cleared when resizing into the mobile sheet breakpoint", async () => {
  const env = createTestEnvironment({ selectedAreaId: "area-42" });
  global.window = env.windowMock;
  global.document = env.documentMock;

  const teardown = initMapControls();
  try {
    env.header.dispatchEvent({
      type: "pointerdown",
      pointerId: 9,
      button: 0,
      clientX: 100,
      clientY: 500,
      preventDefault() {},
      target: {
        closest() {
          return null;
        },
      },
    });
    env.header.dispatchEvent({
      type: "pointermove",
      pointerId: 9,
      clientX: 180,
      clientY: 520,
    });
    env.header.dispatchEvent({
      type: "pointerup",
      pointerId: 9,
    });

    assert.equal(env.controls.style.left, "96px");
    assert.equal(env.controls.style.top, "480px");

    env.setMobile(true);
    env.windowMock.dispatchEvent({ type: "resize" });
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(env.controls.style.left, "");
    assert.equal(env.controls.style.top, "");
    assert.equal(env.controls.style.right, "");
    assert.equal(env.controls.style.bottom, "");
  } finally {
    teardown();
  }
});
