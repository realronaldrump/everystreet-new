/**
 * Map page basemap treatment, applied after every style load: hide POI and
 * transit label chatter, and fade the horizon of a pitched map into the
 * paper. The basemap inks themselves come from maps/manual-basemap.js; this
 * module paints no colours and never touches the app's own layers.
 */

import store from "../../core/store.js";
import { readToken } from "../../core/theme-tokens.js";
import { basemapLayers } from "../../maps/manual-basemap.js";

const HIDDEN_LABELS = /(poi-label|transit-label|airport-label|golf-hole-label)/;

/** Light, dark, and streets styles get the treatment; satellite does not. */
function isTreatable(style) {
  const name = String(style?.name || "").toLowerCase();
  return /dark|light|streets/.test(name) && !name.includes("satellite");
}

function trySet(fn) {
  try {
    fn();
  } catch {
    /* style variations differ between versions — soft-fail per layer */
  }
}

export function applyBasemapTreatment(map) {
  if (!map?.isStyleLoaded || !map.getStyle) {
    return;
  }

  const style = map.getStyle();
  if (!isTreatable(style)) {
    return;
  }

  for (const layer of basemapLayers(style)) {
    if (layer.type === "symbol" && HIDDEN_LABELS.test(layer.id)) {
      trySet(() => map.setLayoutProperty(layer.id, "visibility", "none"));
    }
  }

  // The Streets style keeps its own sky; only the printed styles take fog.
  if (String(style.name).toLowerCase().includes("streets")) {
    return;
  }

  const paper = readToken("--basemap-paper");
  if (paper) {
    trySet(() =>
      map.setFog({
        color: paper,
        "high-color": paper,
        "space-color": paper,
        "horizon-blend": 0.04,
        "star-intensity": 0,
      })
    );
  }
}

export default function initBasemapTreatment({ registerCleanup }) {
  const map = store.map || window.map;
  if (!map) {
    return;
  }

  const handleStyleLoaded = () => {
    // Give the style a beat to settle before painting over it.
    requestAnimationFrame(() =>
      applyBasemapTreatment(store.map || window.map)
    );
  };

  document.addEventListener("mapStyleLoaded", handleStyleLoaded);
  registerCleanup(() =>
    document.removeEventListener("mapStyleLoaded", handleStyleLoaded)
  );

  if (map.isStyleLoaded?.()) {
    applyBasemapTreatment(map);
  } else {
    map.once?.("style.load", () => applyBasemapTreatment(map));
  }
}
