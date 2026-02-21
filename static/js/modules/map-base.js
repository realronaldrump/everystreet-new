/* global mapboxgl */

import { getCurrentTheme, resolveMapStyle } from "./core/map-style-resolver.js";

const HARD_CODED_MAPBOX_TOKEN =
  "pk.eyJ1IjoicmVhbHJvbmFsZHJ1bXAiLCJhIjoiY204eXBvMzRhMDNubTJrb2NoaDIzN2dodyJ9.3Hnv3_ps0T7YS8cwSE3XKA";

// Factory for creating maps using Mapbox GL JS
function createMap(containerId, options = {}) {
  const { center = [0, 0], zoom = 2, accessToken, style, ...rest } = options;

  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`Map container '${containerId}' not found`);
  }

  if (container.firstChild) {
    container.replaceChildren();
  }

  if (!mapboxgl) {
    throw new Error("Mapbox GL JS is not loaded");
  }
  if (typeof mapboxgl.setTelemetryEnabled === "function") {
    mapboxgl.setTelemetryEnabled(false);
  }

  const { styleUrl: themeStyle } = resolveMapStyle({ theme: getCurrentTheme() });
  const defaultStyle = style || themeStyle;

  // Token is fixed for all map usages in this application.
  mapboxgl.accessToken = String(accessToken || HARD_CODED_MAPBOX_TOKEN).trim();

  const map = new mapboxgl.Map({
    container: containerId,
    style: defaultStyle,
    center,
    zoom,
    ...rest,
    attributionControl: false,
  });
  map.addControl(new mapboxgl.NavigationControl());
  map.on("error", () => {});
  return map;
}

const mapBase = { createMap };

export { createMap, mapBase };
export default mapBase;
