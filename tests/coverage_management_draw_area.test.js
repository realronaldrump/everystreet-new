import assert from "node:assert/strict";
import test from "node:test";

import { areaSubtitle } from "../static/js/modules/features/coverage-management/area-name.js";
import {
  boundaryAreaSqMiles,
  boundaryFromFeatures,
  formatSquareMiles,
} from "../static/js/modules/features/coverage-management/draw-area.js";
import { boundaryBounds } from "../static/js/modules/features/coverage-management/modal-map.js";

// About 1.18 by 1.38 miles near Waco, Texas.
const SQUARE = [
  [
    [-97.2, 31.5],
    [-97.18, 31.5],
    [-97.18, 31.52],
    [-97.2, 31.52],
    [-97.2, 31.5],
  ],
];

const polygonFeature = (coordinates) => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates },
});

test("boundaryAreaSqMiles measures drawn outlines", () => {
  const area = boundaryAreaSqMiles({ type: "Polygon", coordinates: SQUARE });
  assert.ok(Math.abs(area - 1.627) < 0.01, `got ${area}`);

  const twice = boundaryAreaSqMiles({
    type: "MultiPolygon",
    coordinates: [SQUARE, SQUARE],
  });
  assert.ok(Math.abs(twice - 2 * area) < 1e-9);
  assert.equal(boundaryAreaSqMiles(null), 0);
});

test("boundaryFromFeatures joins finished shapes and skips unfinished ones", () => {
  assert.equal(boundaryFromFeatures([]), null);
  // A shape still being drawn has too few points to close a ring.
  const unfinished = polygonFeature([
    [
      [-97.2, 31.5],
      [-97.18, 31.5],
      [-97.2, 31.5],
    ],
  ]);
  assert.equal(boundaryFromFeatures([unfinished]), null);

  assert.deepEqual(boundaryFromFeatures([polygonFeature(SQUARE), unfinished]), {
    type: "Polygon",
    coordinates: SQUARE,
  });
  assert.deepEqual(
    boundaryFromFeatures([polygonFeature(SQUARE), polygonFeature(SQUARE)]),
    { type: "MultiPolygon", coordinates: [SQUARE, SQUARE] }
  );
});

test("formatSquareMiles reads well for neighborhoods and towns", () => {
  assert.equal(formatSquareMiles(0.05), "32 acres");
  assert.equal(formatSquareMiles(1.627), "1.63 sq mi");
  assert.equal(formatSquareMiles(42.4), "42 sq mi");
});

test("areaSubtitle labels drawn areas", () => {
  assert.equal(
    areaSubtitle({ display_name: "Castle Heights", area_type: "custom" }),
    "Drawn area"
  );
  assert.equal(
    areaSubtitle({
      display_name: "Waco, McLennan County, Texas, United States",
      area_type: "city",
    }),
    "McLennan County, TX"
  );
});

test("boundaryBounds frames polygons and multipolygons for the preview", () => {
  assert.deepEqual(boundaryBounds({ type: "Polygon", coordinates: SQUARE }), [
    [-97.2, 31.5],
    [-97.18, 31.52],
  ]);
  const shifted = SQUARE.map((ring) => ring.map(([lon, lat]) => [lon + 1, lat - 1]));
  assert.deepEqual(
    boundaryBounds({ type: "MultiPolygon", coordinates: [SQUARE, shifted] }),
    [
      [-97.2, 30.5],
      [-96.18, 31.52],
    ]
  );
  assert.equal(boundaryBounds(null), null);
});
