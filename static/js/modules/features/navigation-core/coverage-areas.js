const WINDOW_CACHE_KEY = "coverageNavigatorAreas";

export function clearCoverageAreasCache() {
  if (typeof window === "undefined") {
    return;
  }
  if (window[WINDOW_CACHE_KEY]) {
    window[WINDOW_CACHE_KEY] = undefined;
  }
}

export function readCoverageAreasCache() {
  if (typeof window === "undefined") {
    return null;
  }
  const cached = window[WINDOW_CACHE_KEY];
  if (Array.isArray(cached) && cached.length > 0) {
    return cached;
  }
  return null;
}

export function writeCoverageAreasCache(areas) {
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
