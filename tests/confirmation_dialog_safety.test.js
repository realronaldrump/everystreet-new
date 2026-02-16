import assert from "node:assert/strict";
import test from "node:test";

import { ConfirmationDialog } from "../static/js/modules/ui/confirmation-dialog.js";

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    style: initial.style || {},
    className: initial.className || "",
    textContent: initial.textContent || "",
    innerHTML: initial.innerHTML || "",
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatch(type, event = {}) {
      const handler = listeners.get(type);
      if (handler) {
        handler(event);
      }
    },
  };
}

function withMockDialogEnvironment(fn) {
  const originalDocument = global.document;
  const originalBootstrap = global.bootstrap;

  const titleEl = createEventTarget();
  const bodyEl = createEventTarget();
  const confirmBtn = createEventTarget({
    focus() {},
    blur() {},
  });
  const cancelBtn = createEventTarget({
    focus() {},
    blur() {},
  });

  const modalElement = createEventTarget({
    classList: {
      contains() {
        return true;
      },
    },
    querySelector(selector) {
      if (selector === ".modal-title") {
        return titleEl;
      }
      if (selector === ".modal-body") {
        return bodyEl;
      }
      if (selector === ".confirm-btn") {
        return confirmBtn;
      }
      if (selector === ".cancel-btn") {
        return cancelBtn;
      }
      if (selector === ":focus") {
        return null;
      }
      return null;
    },
    removeAttribute() {},
  });

  global.document = {
    body: {},
    getElementById(id) {
      if (id === "confirmationModal") {
        return modalElement;
      }
      return null;
    },
  };

  global.bootstrap = {
    Modal: class {
      show() {}

      hide() {}
    },
  };

  return Promise.resolve()
    .then(() => fn({ bodyEl, modalElement }))
    .finally(() => {
      global.document = originalDocument;
      global.bootstrap = originalBootstrap;
    });
}

test("confirmation dialog treats message as text by default", async () => {
  await withMockDialogEnvironment(async ({ bodyEl, modalElement }) => {
    const dialog = new ConfirmationDialog();
    const message = '<img src=x onerror=alert("xss")>';
    const pending = dialog.show({ title: "Delete", message });

    assert.equal(bodyEl.textContent, message);
    assert.notEqual(bodyEl.innerHTML, message);

    modalElement.dispatch("hidden.bs.modal");
    assert.equal(await pending, false);
  });
});

test("confirmation dialog only renders HTML when allowHtml is true", async () => {
  await withMockDialogEnvironment(async ({ bodyEl, modalElement }) => {
    const dialog = new ConfirmationDialog();
    const pending = dialog.show({
      title: "Delete",
      message: "<strong>Formatted</strong>",
      allowHtml: true,
    });

    assert.equal(bodyEl.innerHTML, "<strong>Formatted</strong>");

    modalElement.dispatch("hidden.bs.modal");
    assert.equal(await pending, false);
  });
});
