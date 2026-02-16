import assert from "node:assert/strict";
import test from "node:test";

import { OptimalRouteUI } from "../static/js/modules/optimal-route/ui.js";

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

function createContainer() {
  return {
    innerHTML: "",
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

test("updateActiveMissionCard escapes mission-controlled strings", () => {
  const activeContainer = createContainer();

  withMockDocument({ "active-mission-card": activeContainer }, () => {
    const ui = new OptimalRouteUI();
    ui.updateActiveMissionCard({
      id: 'mission-1" data-pwn="yes',
      area_id: 'area-1" onclick="boom()"',
      area_display_name: '<img src=x onerror=alert(1)>',
      status: 'active" aria-label="injected',
      session_segments_completed: 3,
      session_gain_miles: 1.25,
    });

    assert.ok(
      activeContainer.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;")
    );
    assert.ok(activeContainer.innerHTML.includes("mission-1&quot; data-pwn=&quot;yes"));
    assert.ok(
      activeContainer.innerHTML.includes('area-1&quot; onclick=&quot;boom()&quot;')
    );
    assert.ok(!activeContainer.innerHTML.includes('<img src=x onerror=alert(1)>'));
  });
});

test("updateMissionHistory escapes mission-controlled strings", () => {
  const historyContainer = createContainer();

  withMockDocument({ "mission-history": historyContainer }, () => {
    const ui = new OptimalRouteUI();
    ui.updateMissionHistory([
      {
        id: 'mission-2" onmouseover="boom()"',
        area_id: 'area-2" data-x="1"',
        area_display_name: "<script>alert('x')</script>",
        status: "completed",
        started_at: "2026-01-01T00:00:00Z",
        session_segments_completed: 9,
        session_gain_miles: 4.75,
      },
    ]);

    assert.ok(
      historyContainer.innerHTML.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;")
    );
    assert.ok(
      historyContainer.innerHTML.includes("mission-2&quot; onmouseover=&quot;boom()&quot;")
    );
    assert.ok(historyContainer.innerHTML.includes('area-2&quot; data-x=&quot;1&quot;'));
    assert.ok(!historyContainer.innerHTML.includes("<script>alert('x')</script>"));
  });
});

test("updateSavedRoutes escapes area-controlled strings", () => {
  const historyContainer = createContainer();

  withMockDocument({ "route-history": historyContainer }, () => {
    const ui = new OptimalRouteUI();
    ui.updateSavedRoutes(
      [
        {
          id: 'area-1" onclick="boom()"',
          has_optimal_route: true,
          display_name: "<img src=x onerror=alert(1)>",
          optimal_route_generated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      () => {}
    );

    assert.ok(
      historyContainer.innerHTML.includes("&lt;img src=x onerror=alert(1)&gt;")
    );
    assert.ok(
      historyContainer.innerHTML.includes('area-1&quot; onclick=&quot;boom()&quot;')
    );
    assert.ok(!historyContainer.innerHTML.includes('<img src=x onerror=alert(1)>'));
  });
});
