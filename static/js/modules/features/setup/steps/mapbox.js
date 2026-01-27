import { isValidMapboxToken as isValidMapboxTokenShared } from "../../../settings/credentials.js";

export function isValidMapboxToken(token) {
  return isValidMapboxTokenShared(token);
}

export function renderMapPreview({ token, onError, containerId = "mapbox-preview" }) {
  if (typeof mapboxgl === "undefined") {
    return null;
  }
  const container = document.getElementById(containerId);
  if (!container) {
    return null;
  }
  const placeholder = container.querySelector(".mapbox-preview-placeholder");
  if (placeholder) {
    placeholder.style.display = "none";
  }

  mapboxgl.accessToken = token;
  const preview = new mapboxgl.Map({
    container,
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-96, 37.8],
    zoom: 3,
    interactive: false,
    attributionControl: false,
  });
  preview.on("error", () => {
    if (typeof onError === "function") {
      onError();
    }
  });

  return preview;
}

export function destroyMapPreview(mapPreview, containerId = "mapbox-preview") {
  const container = document.getElementById(containerId);
  const placeholder = container?.querySelector(".mapbox-preview-placeholder");
  if (mapPreview) {
    try {
      mapPreview.remove();
    } catch {
      // Ignore cleanup errors.
    }
  }
  if (placeholder) {
    placeholder.style.display = "grid";
  }
  return null;
}
