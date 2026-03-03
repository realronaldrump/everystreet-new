/**
 * Shared helpers for coverage-area bounding boxes.
 *
 * Bounding boxes are represented as [west, south, east, north].
 */

export const COVERAGE_BBOX_LINE_COLOR = "rgba(245, 242, 236, 0.35)";

/**
 * Normalize bbox input to [west, south, east, north] with finite numbers.
 * Returns null when input is invalid.
 */
export function normalizeCoverageBoundingBox(rawBbox) {
  if (!Array.isArray(rawBbox) || rawBbox.length !== 4) {
    return null;
  }

  const [rawWest, rawSouth, rawEast, rawNorth] = rawBbox;
  const west = Number(rawWest);
  const south = Number(rawSouth);
  const east = Number(rawEast);
  const north = Number(rawNorth);

  if (![west, south, east, north].every(Number.isFinite)) {
    return null;
  }

  return [
    Math.min(west, east),
    Math.min(south, north),
    Math.max(west, east),
    Math.max(south, north),
  ];
}

/**
 * Convert [west, south, east, north] bbox to map fitBounds tuple.
 */
export function coverageBoundingBoxToMapBounds(rawBbox) {
  const bbox = normalizeCoverageBoundingBox(rawBbox);
  if (!bbox) {
    return null;
  }

  const [west, south, east, north] = bbox;
  return [
    [west, south],
    [east, north],
  ];
}

/**
 * Convert bbox into a rectangle polygon feature collection.
 */
export function coverageBoundingBoxToFeatureCollection(rawBbox, properties = {}) {
  const bbox = normalizeCoverageBoundingBox(rawBbox);
  if (!bbox) {
    return null;
  }

  const [west, south, east, north] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}
