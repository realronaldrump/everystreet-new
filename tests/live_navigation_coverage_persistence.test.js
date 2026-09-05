import assert from "node:assert/strict";
import test from "node:test";
import LiveNavigationAPI from "../static/js/modules/live-navigation/live-navigation-api.js";
import LiveNavigationCoverage, {
  mergeIntervals,
  traceIntervals,
} from "../static/js/modules/live-navigation/live-navigation-coverage.js";

const coordinates = [
  [-107, 39],
  [-106.998, 39],
];
const street = {
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties: {
    segment_id: "street",
    status: "undriven",
    length_miles: 0.1,
    intervals: [],
  },
};

test("navigation accumulates provisional intervals without persistent writes", async () => {
  const original = LiveNavigationAPI.fetchCoverageSegments;
  LiveNavigationAPI.fetchCoverageSegments = async () => ({
    type: "FeatureCollection",
    features: [structuredClone(street)],
  });
  try {
    const coverage = new LiveNavigationCoverage();
    await coverage.loadSegments("area");
    coverage.checkSegmentCoverage({ lon: -107, lat: 39, timestamp: 1000 });
    assert.equal(coverage.getCoverageStats().percentage, 0);
    coverage.checkSegmentCoverage({ lon: -106.999, lat: 39, timestamp: 10000 });
    assert.ok(Math.abs(coverage.getCoverageStats().percentage - 50) < 0.001);
    coverage.checkSegmentCoverage({ lon: -107, lat: 39, timestamp: 20000 });
    assert.ok(Math.abs(coverage.getCoverageStats().percentage - 50) < 0.001);
    assert.equal(coverage.getCoverageStats().provisional, true);
    assert.equal(LiveNavigationAPI.persistDrivenSegments, undefined);
    coverage.destroy();
  } finally {
    LiveNavigationAPI.fetchCoverageSegments = original;
  }
});

test("outages and poor fixes cannot add provisional mileage", async () => {
  const original = LiveNavigationAPI.fetchCoverageSegments;
  LiveNavigationAPI.fetchCoverageSegments = async () => ({
    features: [structuredClone(street)],
  });
  try {
    const coverage = new LiveNavigationCoverage();
    await coverage.loadSegments("area");
    coverage.checkSegmentCoverage({ lon: -107, lat: 39, timestamp: 1000 });
    coverage.checkSegmentCoverage({ lon: -106.998, lat: 39, timestamp: 200000 });
    assert.equal(coverage.getCoverageStats().percentage, 0);
    coverage.checkSegmentCoverage({
      lon: -107,
      lat: 39,
      timestamp: 201000,
      accuracy: 150,
    });
    assert.equal(coverage.getCoverageStats().percentage, 0);
  } finally {
    LiveNavigationAPI.fetchCoverageSegments = original;
  }
});

test("live interval math rejects perpendicular crossings and preserves gaps", () => {
  const result = traceIntervals(
    coordinates,
    [-106.999, 38.9999],
    [-106.999, 39.0001],
    39
  );
  assert.deepEqual(result, []);
  assert.deepEqual(
    mergeIntervals([
      [0, 0.4],
      [0.6, 1],
      [0.1, 0.3],
    ]),
    [
      [0, 0.4],
      [0.6, 1],
    ]
  );
});
