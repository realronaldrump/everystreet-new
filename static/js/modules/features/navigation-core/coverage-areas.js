const WINDOW_CACHE_KEY = "coverageNavigatorAreas";

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * Return the mileage that participates in coverage calculations.
 * `total_length_miles` includes streets marked undriveable and is intentionally
 * not used as a fallback.
 */
export function getDriveableMiles(area) {
  return finiteNonNegative(area?.driveable_length_miles);
}

export function getRemainingDriveableMiles(area) {
  const driveableMiles = getDriveableMiles(area);
  const drivenMiles = finiteNonNegative(area?.driven_length_miles);
  if (driveableMiles === null || drivenMiles === null) {
    return null;
  }
  return Math.max(0, driveableMiles - drivenMiles);
}

export function getDriveableSegments(area) {
  const totalSegments = finiteNonNegative(area?.total_segments);
  const undriveableSegments = finiteNonNegative(area?.undriveable_segments);
  if (totalSegments === null || undriveableSegments === null) {
    return null;
  }
  return Math.max(0, totalSegments - undriveableSegments);
}

export function clearCoverageAreasCache() {
  if (typeof window === "undefined") {
    return;
  }
  if (window[WINDOW_CACHE_KEY]) {
    window[WINDOW_CACHE_KEY] = undefined;
  }
}

function readCoverageAreasCache() {
  if (typeof window === "undefined") {
    return null;
  }
  const cached = window[WINDOW_CACHE_KEY];
  if (Array.isArray(cached) && cached.length > 0) {
    return cached;
  }
  return null;
}

function writeCoverageAreasCache(areas) {
  if (typeof window === "undefined") {
    return;
  }
  if (Array.isArray(areas) && areas.length > 0) {
    window[WINDOW_CACHE_KEY] = areas;
  }
}

export async function loadCoverageAreasWithCache(
  fetchCoverageAreas,
  { force = false } = {}
) {
  if (!force) {
    const cached = readCoverageAreasCache();
    if (cached) {
      return cached;
    }
  }

  const response = await fetchCoverageAreas();
  const areas = Array.isArray(response)
    ? response
    : Array.isArray(response?.areas)
      ? response.areas
      : null;

  if (!Array.isArray(areas)) {
    throw new Error("Invalid coverage areas response.");
  }

  writeCoverageAreasCache(areas);
  return areas;
}
