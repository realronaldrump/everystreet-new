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

test("renderAreaCards formats city card titles as City, ST", async () => {
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
    renderAreaCards({
      areas: [
        {
          id: "area-city-1",
          display_name: "Waco, McLennan County, Texas, United States",
          area_type: "city",
          status: "ready",
          total_segments: 10,
          driven_segments: 3,
          undriveable_segments: 0,
          total_length_miles: 10,
          driven_length_miles: 3,
          coverage_percentage: 30,
          last_synced: null,
        },
      ],
      activeJobsByAreaId: new Map(),
      areaErrorById: new Map(),
      areaNameById: new Map(),
    });

    assert.match(grid.innerHTML, />Waco, TX<\/h3>/);
    assert.doesNotMatch(grid.innerHTML, /McLennan County/);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});

test("renderAreaCards separates route progress from coverage rebuild progress", async () => {
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
    renderAreaCards({
      areas: [
        {
          id: "area-route-1",
          display_name: "Demo Area",
          area_type: "city",
          status: "rebuilding",
          total_segments: 10,
          driven_segments: 3,
          undriveable_segments: 0,
          total_length_miles: 10,
          driven_length_miles: 3,
          coverage_percentage: 30,
          last_synced: null,
          has_optimal_route: false,
          optimal_route_generated_at: null,
        },
      ],
      activeJobsByAreaId: new Map([
        [
          "area-route-1",
          {
            status: "running",
            progress: 42,
            message: "Rebuilding street network",
            job_type: "area_rebuild",
          },
        ],
      ]),
      activeRouteJobsByAreaId: new Map([
        [
          "area-route-1",
          {
            status: "running",
            progress: 12,
            message: "Optimizing route with local search",
            job_type: "optimal_route",
          },
        ],
      ]),
      areaErrorById: new Map(),
      areaNameById: new Map(),
    });

    assert.match(grid.innerHTML, /Rebuilding street network/);
    assert.match(grid.innerHTML, /Optimizing route with local search/);
    assert.match(grid.innerHTML, /Stop Route/);
    assert.match(grid.innerHTML, /Restart Optimal Route/);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});

test("renderAreaCards exposes rebuild recovery actions when area is in error", async () => {
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
    renderAreaCards({
      areas: [
        {
          id: "area-error-1",
          display_name: "Waco, Texas, United States",
          area_type: "city",
          status: "error",
          total_segments: 10,
          driven_segments: 0,
          undriveable_segments: 0,
          total_length_miles: 10,
          driven_length_miles: 0,
          coverage_percentage: 0,
          last_synced: null,
          has_optimal_route: false,
          optimal_route_generated_at: null,
        },
      ],
      activeJobsByAreaId: new Map(),
      activeRouteJobsByAreaId: new Map(),
      areaErrorById: new Map(),
      areaNameById: new Map(),
    });

    assert.match(grid.innerHTML, /Retry Build/);
    assert.match(grid.innerHTML, /Retry Build from OSM/);
    assert.doesNotMatch(grid.innerHTML, /data-area-action="rebuild"[^>]*disabled/);
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
  }
});
