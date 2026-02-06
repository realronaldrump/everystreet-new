export function getPreloadTripIdFromUrl(href = window.location.href) {
  try {
    const url = new URL(href, window.location.origin);

    const path = url.pathname || "";
    const tripPathMatch = path.match(/^\\/trips\\/([^/]+)$/);
    if (tripPathMatch) {
      return tripPathMatch[1] || null;
    }

    return url.searchParams.get("trip_id") || url.searchParams.get("highlight");
  } catch {
    return null;
  }
}

