import assert from "node:assert/strict";
import test from "node:test";

import {
  angleDelta,
  bearing,
  haversineDistance,
  projectToSegment,
} from "../static/js/modules/utils/geo-math.js";

test("haversineDistance returns expected meter distances", () => {
  assert.equal(haversineDistance(0, 0, 0, 0), 0);

  const oneDegreeAtEquator = haversineDistance(0, 0, 0, 1);
  assert.ok(Math.abs(oneDegreeAtEquator - 111194.9) < 300);
});

test("bearing returns cardinal directions", () => {
  assert.ok(Math.abs(bearing(0, 0, 1, 0) - 0) < 1e-9);
  assert.ok(Math.abs(bearing(0, 0, 0, 1) - 90) < 1e-9);
  assert.ok(Math.abs(bearing(0, 0, -1, 0) - 180) < 1e-9);
  assert.ok(Math.abs(bearing(0, 0, 0, -1) - 270) < 1e-9);
});

test("angleDelta wraps across north correctly", () => {
  assert.equal(angleDelta(350, 10), 20);
  assert.equal(angleDelta(10, 350), -20);
  assert.equal(angleDelta(90, 270), -180);
});

test("projectToSegment projects and clamps to endpoints", () => {
  const nearMiddle = projectToSegment([0.5, 0.1], [0, 0], [1, 0]);
  assert.ok(nearMiddle.distance > 10000 && nearMiddle.distance < 12000);
  assert.ok(Math.abs(nearMiddle.t - 0.5) < 0.02);

  const clamped = projectToSegment([2, 0], [0, 0], [1, 0]);
  assert.equal(clamped.t, 1);
  assert.ok(Math.abs(clamped.point[0] - 1) < 1e-9);
  assert.ok(Math.abs(clamped.point[1] - 0) < 1e-9);
});
