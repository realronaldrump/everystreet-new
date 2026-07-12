import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import apiClient from "../static/js/modules/core/api-client.js";
import {
  COVERAGE_ROUTE_DRAFT_KEY,
  createCoverageRouteDraft,
  isDioramaDraftRequest,
  readCoverageRouteDraft,
  saveCoverageRouteDraft,
} from "../static/js/modules/features/coverage-diorama/draft.js";
import {
  buildStreetPairPositions,
  buildTerrainMeshData,
  createLocalProjection,
  decodeTerrainRgb,
  extractLineParts,
  pointInBoundary,
  projectLonLat,
  selectTerrainTiles,
} from "../static/js/modules/features/coverage-diorama/terrain.js";
import { DriveSimulation } from "../static/js/modules/optimal-route/simulation.js";

const root = join(import.meta.dirname, "..");

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function flatMosaic(elevation = 100) {
  return {
    zoom: 0,
    minX: 0,
    minY: 0,
    width: 256,
    height: 256,
    elevations: new Float32Array(256 * 256).fill(elevation),
  };
}

test("Terrain-RGB values decode to documented meter elevations", () => {
  assert.equal(decodeTerrainRgb(0, 0, 0), -10_000);
  assert.equal(decodeTerrainRgb(1, 134, 160), 0);
  assert.equal(decodeTerrainRgb(1, 138, 136), 100);
});

test("terrain tile selection chooses the highest zoom within a 4 by 4 budget", () => {
  const plan = selectTerrainTiles([-97.25, 31.45, -97.05, 31.65]);
  assert.ok(plan.zoom >= 8 && plan.zoom <= 14);
  assert.ok(plan.columns <= 4);
  assert.ok(plan.rows <= 4);
  assert.ok(plan.tileCount <= 16);
});

test("local projection is centered and preserves east/north orientation", () => {
  const projection = createLocalProjection([-98, 31, -96, 33]);
  assert.deepEqual(projectLonLat(-97, 32, projection), { x: 0, z: -0 });
  assert.ok(projectLonLat(-96.9, 32, projection).x > 0);
  assert.ok(projectLonLat(-97, 32.1, projection).z < 0);
});

test("boundary hit testing respects polygon holes and multipolygons", () => {
  const polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
        [1, 1],
      ],
    ],
  };
  assert.equal(pointInBoundary(3, 3, polygon), true);
  assert.equal(pointInBoundary(1.5, 1.5, polygon), false);
  assert.equal(pointInBoundary(5, 5, polygon), false);
  assert.equal(
    pointInBoundary(3, 3, { type: "MultiPolygon", coordinates: [polygon.coordinates] }),
    true
  );
});

test("MultiLineString parts never gain a connector segment", () => {
  const geometry = {
    type: "MultiLineString",
    coordinates: [
      [
        [-0.8, 0],
        [-0.7, 0],
      ],
      [
        [0.7, 0],
        [0.8, 0],
      ],
    ],
  };
  assert.equal(extractLineParts(geometry).length, 2);
  const positions = buildStreetPairPositions(
    { geometry },
    {
      mosaic: flatMosaic(),
      projection: createLocalProjection([-1, -1, 1, 1]),
      baseElevation: 100,
      verticalScale: 1,
      maxDistanceM: Number.POSITIVE_INFINITY,
    }
  );
  assert.equal(positions.length, 12);
});

test("terrain mesh is clipped to the boundary and includes a slab", () => {
  const bounds = [-1, -1, 1, 1];
  const boundary = {
    type: "Polygon",
    coordinates: [
      [
        [-0.8, -0.8],
        [0.8, -0.8],
        [0.8, 0.8],
        [-0.8, 0.8],
        [-0.8, -0.8],
      ],
    ],
  };
  const mesh = buildTerrainMeshData({
    bounds,
    boundary,
    mosaic: flatMosaic(240),
    projection: createLocalProjection(bounds),
    resolution: 8,
    verticalScale: 2.5,
  });
  assert.ok(mesh.positions.length > 0);
  assert.equal(mesh.minElevation, 240);
  assert.equal(mesh.maxElevation, 240);
  assert.ok(mesh.bottomY < 0);
  assert.ok(Array.from(mesh.positions).includes(mesh.bottomY));
});

test("Diorama route drafts dedupe, expire, and require an explicit draft query", () => {
  const storage = createStorage();
  const now = 1_800_000_000_000;
  const draft = createCoverageRouteDraft("area-1", ["a", "a", "b"], now);
  assert.deepEqual(draft.segmentIds, ["a", "b"]);
  saveCoverageRouteDraft(storage, draft);
  assert.deepEqual(readCoverageRouteDraft(storage, now + 1_000), draft);
  assert.equal(readCoverageRouteDraft(storage, now + 31 * 60 * 1_000), null);
  assert.equal(storage.getItem(COVERAGE_ROUTE_DRAFT_KEY), null);
  assert.equal(isDioramaDraftRequest("?draft=diorama"), true);
  assert.equal(isDioramaDraftRequest("?draft=other"), false);
});

test("route planner hydration accepts only currently undriven segment features", async () => {
  const originalDocument = global.document;
  const sources = new Map();
  const mapgl = {
    addSource(id, definition) {
      const source = {
        data: definition.data,
        setData(data) {
          this.data = data;
        },
      };
      sources.set(id, source);
    },
    getSource(id) {
      return sources.get(id) || null;
    },
    getLayer() {
      return null;
    },
    addLayer() {},
    on() {},
    off() {},
  };
  global.document = { getElementById: () => null };
  try {
    const simulation = new DriveSimulation({ map: mapgl });
    let simulated = 0;
    simulation._simulate = async () => {
      simulated += 1;
    };
    const count = simulation.hydrateSelection("area-1", [
      { properties: { segment_id: "undriven-1", status: "undriven" } },
      { properties: { segment_id: "driven-1", status: "driven" } },
      { properties: { segment_id: "undriven-2" } },
    ]);
    await Promise.resolve();
    assert.equal(count, 2);
    assert.equal(simulated, 1);
    assert.deepEqual(
      sources
        .get("simulation-selected")
        .data.features.map((feature) => feature.properties.segment_id),
      ["undriven-1", "undriven-2"]
    );
    simulation.destroy();
  } finally {
    global.document = originalDocument;
  }
});

test("route planner simulation ignores a stale response after selection changes", async () => {
  const originalPost = apiClient.post;
  let resolveFirst;
  let callCount = 0;
  const updates = [];
  apiClient.post = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return {
      success: true,
      marker: "current",
      current: { coverage_percentage: 10 },
      projected: { coverage_percentage: 11 },
    };
  };
  try {
    const simulation = new DriveSimulation(
      { map: null },
      { onStatsUpdate: (data) => updates.push(data) }
    );
    simulation.areaId = "area-1";
    simulation.selectedSegments.set("first", {
      properties: { segment_id: "first", status: "undriven" },
    });
    const staleRequest = simulation._simulate();
    simulation.selectedSegments.clear();
    simulation.selectedSegments.set("second", {
      properties: { segment_id: "second", status: "undriven" },
    });
    await simulation._simulate();
    resolveFirst({
      success: true,
      marker: "stale",
      current: { coverage_percentage: 10 },
      projected: { coverage_percentage: 12 },
    });
    await staleRequest;
    assert.equal(updates.length, 1);
    assert.equal(updates[0].marker, "current");
    assert.equal(updates[0].selectedCount, 1);
  } finally {
    apiClient.post = originalPost;
  }
});

test("app plumbing exposes the dedicated page and lazy Three.js route", () => {
  const routes = readFileSync(
    join(root, "static/js/modules/core/route-loader.js"),
    "utf8"
  );
  const template = readFileSync(join(root, "templates/coverage_diorama.html"), "utf8");
  const base = readFileSync(join(root, "templates/base.html"), "utf8");
  assert.match(
    routes,
    /"\/coverage-diorama", "\.\.\/\.\.\/pages\/coverage-diorama\.js"/
  );
  assert.match(template, /id="coverage-diorama-canvas"/);
  assert.match(template, /id="coverage-diorama-continue"/);
  assert.match(base, /"three\/addons\/"/);
  assert.match(base, /type="importmap"/);
});
