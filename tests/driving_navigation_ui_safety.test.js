import assert from "node:assert/strict";
import test from "node:test";

import { DrivingNavigationUI } from "../static/js/modules/driving-navigation/ui.js";

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

  withMockDocument({ "target-info": targetInfo }, () => {
    const ui = new DrivingNavigationUI({ areaSelectId: "area-select" });
    ui.displayTargetInfo(
      '<img src=x onerror=alert("street")>',
      'segment-1" onclick="boom()"'
    );

    assert.ok(
      targetInfo.innerHTML.includes(
        "&lt;img src=x onerror=alert(&quot;street&quot;)&gt;"
      )
    );
    assert.ok(
      targetInfo.innerHTML.includes("segment-1&quot; onclick=&quot;boom()&quot;")
    );
    assert.ok(!targetInfo.innerHTML.includes('<img src=x onerror=alert("street")>'));
  });
});
