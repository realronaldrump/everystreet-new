/**
 * Heatmap Worker - Offloads trip heatmap calculation to a separate thread
 * Prevents main thread blocking when processing 6000+ trips
 */

const DEFAULT_PRECISION = 5;

/**
 * Create a unique key for a line segment (order-independent)
 */
function makeSegmentKey(a, b, precision) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  if (a.length < 2 || b.length < 2) return null;

  const factor = 10 ** precision;
  const ax = Math.round(Number(a[0]) * factor) / factor;
  const ay = Math.round(Number(a[1]) * factor) / factor;
  const bx = Math.round(Number(b[0]) * factor) / factor;
  const by = Math.round(Number(b[1]) * factor) / factor;

  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
  if (!Number.isFinite(bx) || !Number.isFinite(by)) return null;

  const keyA = `${ax.toFixed(precision)}:${ay.toFixed(precision)}`;
  const keyB = `${bx.toFixed(precision)}:${by.toFixed(precision)}`;
  return keyA <= keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
}

/**
 * Extract coordinate arrays from geometry
 */
function getGeometryCoordinateSets(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") {
    return [Array.isArray(geometry.coordinates) ? geometry.coordinates : []];
  }
  if (geometry.type === "MultiLineString") {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }
  return [];
}

/**
 * Normalize heat value using logarithmic scale
 */
function normalizeHeatValue(value, maxValue) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 0;
  if (maxValue === 1) return Math.min(1, value);

  const numerator = Math.log(value + 1);
  const denominator = Math.log(maxValue + 1);

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return Math.min(1, value / maxValue);
  }
  return Math.min(1, numerator / denominator);
}

/**
 * Main heatmap calculation
 */
function calculateHeatmap(features, precision = DEFAULT_PRECISION) {
  if (!features || features.length === 0) {
    return { features: [], stats: null };
  }

  // Phase 1: Count segment overlaps
  const segmentCounts = new Map();

  for (const feature of features) {
    const coordinateSets = getGeometryCoordinateSets(feature.geometry);
    for (const coords of coordinateSets) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const key = makeSegmentKey(coords[i], coords[i + 1], precision);
        if (key) {
          segmentCounts.set(key, (segmentCounts.get(key) || 0) + 1);
        }
      }
    }
  }

  // Early exit if no segments found
  if (segmentCounts.size === 0) {
    for (const feature of features) {
      if (!feature.properties) feature.properties = {};
      feature.properties.heatIntensity = 0;
      feature.properties.heatWeight = 0;
    }
    return { features, stats: null };
  }

  // Phase 2: Find min/max counts
  let maxCount = 0;
  let minCount = Infinity;

  for (const count of segmentCounts.values()) {
    if (Number.isFinite(count)) {
      if (count > maxCount) maxCount = count;
      if (count < minCount) minCount = count;
    }
  }

  if (!Number.isFinite(maxCount) || maxCount <= 0) {
    for (const feature of features) {
      if (!feature.properties) feature.properties = {};
      feature.properties.heatIntensity = 0;
      feature.properties.heatWeight = 0;
    }
    return { features, stats: null };
  }

  // Phase 3: Assign heat values to features
  for (const feature of features) {
    const coordinateSets = getGeometryCoordinateSets(feature.geometry);
    let featureMax = 0;
    let featureSum = 0;
    let segmentCounter = 0;

    for (const coords of coordinateSets) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const key = makeSegmentKey(coords[i], coords[i + 1], precision);
        if (key) {
          const value = segmentCounts.get(key) || 0;
          featureMax = Math.max(featureMax, value);
          featureSum += value;
          segmentCounter++;
        }
      }
    }

    const average = segmentCounter > 0 ? featureSum / segmentCounter : 0;
    const intensitySource = featureMax || average;
    const normalized = normalizeHeatValue(intensitySource, maxCount);

    if (!feature.properties) feature.properties = {};
    feature.properties.heatIntensity = Number.isFinite(normalized)
      ? Number(normalized.toFixed(4))
      : 0;
    feature.properties.heatWeight = intensitySource;
  }

  const stats = {
    maxCount,
    minCount: Number.isFinite(minCount) ? minCount : 0,
    totalSegments: segmentCounts.size,
    precision,
  };

  return { features, stats };
}

// Handle messages from main thread
self.onmessage = (e) => {
  const { type, features, precision, id } = e.data;

  if (type === "calculate") {
    try {
      const result = calculateHeatmap(features, precision);
      self.postMessage({
        type: "result",
        id,
        features: result.features,
        stats: result.stats,
      });
    } catch (error) {
      self.postMessage({
        type: "error",
        id,
        error: error.message,
      });
    }
  }
};
