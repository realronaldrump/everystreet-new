const EXPLICIT_MAP_VIEW_PARAM = "map_view";
const EXPLICIT_MAP_VIEW_VALUE = "1";

export function getExplicitMapViewFromUrl(href = window.location.href) {
  try {
    const url = new URL(href, window.location.origin);
    if (url.searchParams.get(EXPLICIT_MAP_VIEW_PARAM) !== EXPLICIT_MAP_VIEW_VALUE) {
      return null;
    }

    const lat = Number.parseFloat(url.searchParams.get("lat"));
    const lng = Number.parseFloat(url.searchParams.get("lng"));
    const zoom = Number.parseFloat(url.searchParams.get("zoom"));
    const isValid =
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      Number.isFinite(lng) &&
      lng >= -180 &&
      lng <= 180 &&
      Number.isFinite(zoom) &&
      zoom >= 0 &&
      zoom <= 22;

    return isValid ? { center: [lng, lat], zoom } : null;
  } catch {
    return null;
  }
}

export function hasExplicitMapViewFromUrl(href = window.location.href) {
  return getExplicitMapViewFromUrl(href) !== null;
}

export function getPreloadTripIdFromUrl(href = window.location.href) {
  try {
    const url = new URL(href, window.location.origin);

    const path = url.pathname || "";
    const tripPathMatch = path.match(/^\/trips\/([^/]+)$/);
    if (tripPathMatch) {
      return tripPathMatch[1] || null;
    }

    return url.searchParams.get("highlight");
  } catch {
    return null;
  }
}
