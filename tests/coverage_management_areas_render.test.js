import assert from "node:assert/strict";
import test from "node:test";

test("renderAreasTable tolerates missing coverage percentage values", async () => {
  const tbody = { innerHTML: "" };
  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = {
    readyState: "loading",
    addEventListener: () => {},
    querySelector: (selector) =>
      selector === "#coverage-areas-table tbody" ? tbody : null,
  };
  global.window = {
    matchMedia: () => ({ matches: false }),
  };

  try {
    const { renderAreasTable } = await import(
      "../static/js/modules/features/coverage-management/areas.js"
    );
    const result = renderAreasTable({
      areas: [
        {
          id: "area-1",
          display_name: "Demo Area",
          area_type: "city",
          status: "ready",
          total_length_miles: 10,
          driven_length_miles: 3,
          coverage_percentage: null,
          last_synced: null,
        },
      ],
      activeJobsByAreaId: new Map(),
      areaErrorById: new Map(),
      areaNameById: new Map(),
    });

    assert.equal(result.hasAreas, true);
    assert.match(tbody.innerHTML, /width: 0%/);
    assert.match(tbody.innerHTML, /0\.00%/);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});
