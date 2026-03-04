import assert from "node:assert/strict";
import test from "node:test";

import { DrivingNavigationUI } from "../static/js/modules/driving-navigation/ui.js";
import { escapeHtml } from "../static/js/modules/utils.js";

function withMockDocument(elements, fn) {
  const originalDocument = global.document;
  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };

  try {
    fn();
  } finally {
    global.document = originalDocument;
  }
}

test("displayTargetInfo escapes street-controlled strings", () => {
  const targetInfo = { innerHTML: "" };
  const untrustedStreetName = '<img src=x onerror=alert("street")>';
  const untrustedSegmentId = 'segment-1" onclick="boom()"';

  withMockDocument({ "target-info": targetInfo }, () => {
    const ui = new DrivingNavigationUI({ areaSelectId: "area-select" });
    ui.displayTargetInfo(untrustedStreetName, untrustedSegmentId);

    assert.ok(targetInfo.innerHTML.includes(escapeHtml(untrustedStreetName)));
    assert.ok(targetInfo.innerHTML.includes(escapeHtml(untrustedSegmentId)));
    assert.ok(!targetInfo.innerHTML.includes(untrustedStreetName));
    assert.ok(!targetInfo.innerHTML.includes(untrustedSegmentId));
  });
});
