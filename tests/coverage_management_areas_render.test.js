import assert from "node:assert/strict";
import test from "node:test";

test("renderAreaCards normalizes missing coverage percentage values", async () => {
  const grid = { innerHTML: "", style: { display: "none" } };
  const loading = { style: { display: "block" } };
  const emptyState = { classList: { add: () => {}, remove: () => {} } };

  const originalDocument = global.document;
  const originalWindow = global.window;
  global.document = {
    readyState: "loading",
    addEventListener: () => {},
    getElementById: (id) => {
      if (id === "area-cards-grid") return grid;
      if (id === "area-cards-loading") return loading;
      if (id === "area-empty-state") return emptyState;
      return null;
    },
  };
  global.window = {
    matchMedia: () => ({ matches: false }),
  };

  try {
    const { renderAreaCards } = await import(
      "../static/js/modules/features/coverage-management/areas.js"
    );
    const result = renderAreaCards({
      areas: [
        {
          id: "area-1",
          display_name: "Demo Area",
          area_type: "city",
          status: "ready",
          total_segments: 10,
          driven_segments: 3,
          undriveable_segments: 0,
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
    assert.equal(grid.style.display, "grid");
    assert.match(grid.innerHTML, /0\.0%/);
    assert.match(grid.innerHTML, /stroke-dashoffset:\s*125\.66;/);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});
