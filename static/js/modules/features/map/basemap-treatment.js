/**
 * Basemap treatment — quiet, proprietary-feeling paint overrides
 * applied to stock Mapbox styles after every style load.
 *
 * The intent is restraint: mute POI/transit noise, pull label and
 * water tones toward the app's surface palette, and add a whisper of
 * fog so trip ink and coverage strokes carry the plate.
 */

import store from "../../core/store.js";

const HIDDEN_LABELS = /(poi-label|transit-label|airport-label|golf-hole-label)/;

const TONES = {
  dark: {
    background: "#0c0c0f",
    water: "#10161d",
    park: "#101510",
    labelText: "#8f8b83",
    labelHalo: "#0c0c0f",
    fog: {
      color: "#0c0c0f",
      "high-color": "#101318",
      "horizon-blend": 0.04,
      "space-color": "#08080a",
      "star-intensity": 0,
    },
  },
  light: {
    background: "#faf9f7",
    water: "#d8e1e6",
    park: "#e8ede3",
    labelText: "#8b8375",
    labelHalo: "#faf9f7",
    fog: {
      color: "#faf9f7",
      "high-color": "#eef0f2",
      "horizon-blend": 0.04,
      "star-intensity": 0,
    },
  },
};

function detectTone(map) {
  const name = String(map.getStyle()?.name || "").toLowerCase();
  if (name.includes("dark")) {
    return "dark";
  }
  if (name.includes("light")) {
    return "light";
  }
  if (name.includes("streets")) {
    return "streets";
  }
  return null; // satellite and unknown styles are left untouched
}

function trySet(fn) {
  try {
    fn();
  } catch {
    /* style variations differ between versions — soft-fail per layer */
  }
}

function applyTreatment(map) {
  if (!map?.isStyleLoaded || !map.getStyle) {
    return;
  }

  const tone = detectTone(map);
  if (!tone) {
    return;
  }

  const layers = map.getStyle()?.layers || [];

  // POI and transit chatter off — on every non-satellite style
  for (const layer of layers) {
    if (layer.type === "symbol" && HIDDEN_LABELS.test(layer.id)) {
      trySet(() => map.setLayoutProperty(layer.id, "visibility", "none"));
    }
  }

  if (tone === "streets") {
    return;
  }

  const tones = TONES[tone];

  for (const layer of layers) {
    if (layer.type === "symbol" && !HIDDEN_LABELS.test(layer.id)) {
      trySet(() => map.setPaintProperty(layer.id, "text-color", tones.labelText));
      trySet(() =>
        map.setPaintProperty(layer.id, "text-halo-color", tones.labelHalo)
      );
    } else if (layer.type === "background") {
      trySet(() =>
        map.setPaintProperty(layer.id, "background-color", tones.background)
      );
    } else if (layer.type === "fill" && /water/.test(layer.id)) {
      trySet(() => map.setPaintProperty(layer.id, "fill-color", tones.water));
    } else if (
      layer.type === "fill" &&
      /(national-park|landuse|pitch|park)/.test(layer.id)
    ) {
      trySet(() => map.setPaintProperty(layer.id, "fill-color", tones.park));
    }
  }

  trySet(() => map.setFog(tones.fog));
}

export default function initBasemapTreatment({ registerCleanup }) {
  const map = store.map || window.map;
  if (!map) {
    return;
  }

  const handleStyleLoaded = () => {
    // Give the style a beat to settle before painting over it.
    requestAnimationFrame(() => applyTreatment(store.map || window.map));
  };

  document.addEventListener("mapStyleLoaded", handleStyleLoaded);
  registerCleanup(() =>
    document.removeEventListener("mapStyleLoaded", handleStyleLoaded)
  );

  if (map.isStyleLoaded?.()) {
    applyTreatment(map);
  } else {
    map.once?.("style.load", () => applyTreatment(map));
  }
}
