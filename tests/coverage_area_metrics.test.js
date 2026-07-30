import assert from "node:assert/strict";
import test from "node:test";

import {
  getDriveableMiles,
  getDriveableSegments,
  getRemainingDriveableMiles,
} from "../static/js/modules/features/navigation-core/coverage-areas.js";
import { buildMissionLine } from "../static/js/modules/features/landing/hero.js";

test("coverage mileage excludes undriveable streets from total and remaining", () => {
  const area = {
    display_name: "Testville",
    coverage_percentage: 50,
    total_length_miles: 100,
    driveable_length_miles: 80,
    driven_length_miles: 40,
  };

  assert.equal(getDriveableMiles(area), 80);
  assert.equal(getRemainingDriveableMiles(area), 40);
  assert.equal(
    buildMissionLine([area]),
    "Testville is 50.0% driven — 40.0 miles of streets to go."
  );
});

test("coverage mileage preserves a valid zero and does not fall back to total miles", () => {
  const area = {
    total_length_miles: 10,
    driveable_length_miles: 0,
    driven_length_miles: 0,
  };

  assert.equal(getDriveableMiles(area), 0);
  assert.equal(getRemainingDriveableMiles(area), 0);
  assert.equal(getDriveableMiles({ driveable_length_miles: null }), null);
  assert.equal(getDriveableMiles({ driveable_length_miles: -1 }), null);
  assert.equal(getRemainingDriveableMiles({ total_length_miles: 10 }), null);
});

test("coverage segment denominator excludes undriveable segments", () => {
  assert.equal(
    getDriveableSegments({ total_segments: 100, undriveable_segments: 20 }),
    80
  );
  assert.equal(getDriveableSegments({ total_segments: 100 }), null);
});
