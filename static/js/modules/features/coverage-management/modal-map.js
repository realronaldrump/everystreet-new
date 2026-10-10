/**
 * Small maps inside the Add Area dialog: the outline drawn by hand, and the
 * boundary of the place picked from the search.
 */

import { ensureLibraries } from "../../core/library-loader.js";
import { getCurrentTheme, resolveMapStyle } from "../../core/map-style-resolver.js";
import { createMap, isMapboxStyleUrl, waitForMapboxToken } from "../../map-core.js";

const US_CENTER = [-98.57, 39.82];

/**
 * Create a map in ``containerId`` once ``libraries`` load. Returns null when
 * ``isCurrent`` says the dialog was torn down while loading.
 */
export async function createModalMap(
  containerId,
  { libraries = ["map"], isCurrent = () => true } = {}
) {
  await ensureLibraries(libraries);
  const { styleUrl } = resolveMapStyle({ theme: getCurrentTheme() });
  const accessToken = isMapboxStyleUrl(styleUrl)
    ? await waitForMapboxToken({ timeoutMs: 5000 })
    : undefined;
  if (!isCurrent()) {
    return null;
  }
  const map = createMap(containerId, {
    style: styleUrl,
    accessToken,
    center: US_CENTER,
    zoom: 3,
    dragRotate: false,
    pitchWithRotate: false,
    navigationControl: { showCompass: false, position: "bottom-right" },
  });
  map.touchZoomRotate?.disableRotation?.();
  return map;
}

/** [[west, south], [east, north]] around a GeoJSON Polygon or MultiPolygon. */
export function boundaryBounds(geometry) {
  const rings =
    geometry?.type === "Polygon"
      ? geometry.coordinates
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates.flat()
        : [];
  const points = rings.flat().filter((point) => Array.isArray(point));
  if (!points.length) {
    return null;
  }
  const lons = points.map(([lon]) => lon);
  const lats = points.map(([, lat]) => lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}
