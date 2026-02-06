/* global mapboxgl */

import { CONFIG } from "./core/config.js";
import { getMapboxToken } from "./mapbox-token.js";

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
  const token = (accessToken || getMapboxToken() || "").trim();
  if (!token) {
    throw new Error("Mapbox access token not configured");
  }
  mapboxgl.accessToken = token;

  const theme = document.documentElement.getAttribute("data-bs-theme") || "dark";
  const themeStyle = CONFIG?.MAP?.styles?.[theme] || CONFIG?.MAP?.styles?.dark;
  const defaultStyle = style || themeStyle;

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
