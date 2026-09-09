import assert from "node:assert/strict";
import test from "node:test";

import { moveFocusOutOfModal } from "../static/js/modules/ui/modal-focus.js";

test("moveFocusOutOfModal moves focus before a modal is hidden", () => {
  let focused = null;
  const fallback = {
    isConnected: true,
    focus() {
      focused = fallback;
      documentRef.activeElement = fallback;
    },
  };
  const modal = {
    contains(element) {
      return element === modal;
    },
  };
  const documentRef = {
    activeElement: modal,
    querySelector(selector) {
      assert.equal(selector, "#main-content");
      return fallback;
    },
  };

  assert.equal(moveFocusOutOfModal(modal, { documentRef }), true);
  assert.equal(focused, fallback);
  assert.equal(documentRef.activeElement, fallback);
});
