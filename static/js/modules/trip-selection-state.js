import store from "./core/store.js";

export function clearTripInteractionState(map = store.map) {
  store.selectedTripId = null;
  store.selectedTripLayer = null;

  if (map?.getLayer?.("selected-trip-layer")) {
    map.removeLayer?.("selected-trip-layer");
  }
  if (map?.getSource?.("selected-trip-source")) {
    map.removeSource?.("selected-trip-source");
  }

  if (typeof document?.querySelectorAll !== "function") {
    return;
  }

  document.querySelectorAll(".trip-popup-content").forEach((content) => {
    content.closest?.(".mapboxgl-popup")?.remove?.();
    content.closest?.(".maplibregl-popup")?.remove?.();
  });
}
