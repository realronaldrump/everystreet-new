import { CONFIG } from "../../core/config.js";
import { readStoredBoolean, writeStoredBoolean } from "./preference-storage.js";

export const TRIP_LAYER_RENDER_MODE_EVENT = "es:trip-layer-render-mode-setting-changed";

export function getTripLayerHeatmapPreference() {
  const key = CONFIG?.STORAGE_KEYS?.tripLayersUseHeatmap;
  const stored = readStoredBoolean(key);
  if (typeof stored === "boolean") {
    return stored;
  }

  return globalThis?.window?.APP_SETTINGS_FLAGS?.tripLayersUseHeatmap !== false;
}

function persistTripLayerHeatmapPreference(useHeatmap) {
  writeStoredBoolean(CONFIG?.STORAGE_KEYS?.tripLayersUseHeatmap, useHeatmap);
}

function syncSettingsToggle(useHeatmap) {
  if (typeof useHeatmap !== "boolean" || typeof document === "undefined") {
    return;
  }

  const settingsToggle = document.getElementById("trip-layers-use-heatmap");
  if (settingsToggle) {
    settingsToggle.checked = useHeatmap;
  }
}

function syncWindowFlags(useHeatmap) {
  if (typeof useHeatmap !== "boolean" || typeof window === "undefined") {
    return;
  }

  window.APP_SETTINGS_FLAGS = {
    ...(window.APP_SETTINGS_FLAGS || {}),
    tripLayersUseHeatmap: useHeatmap,
  };
}

export function setTripLayerHeatmapPreference(
  useHeatmap,
  { emit = true, syncControls = true } = {}
) {
  if (typeof useHeatmap !== "boolean") {
    return false;
  }

  persistTripLayerHeatmapPreference(useHeatmap);
  syncWindowFlags(useHeatmap);
  if (syncControls) {
    syncSettingsToggle(useHeatmap);
  }

  if (
    emit &&
    typeof document !== "undefined" &&
    typeof document.dispatchEvent === "function"
  ) {
    document.dispatchEvent(
      new CustomEvent(TRIP_LAYER_RENDER_MODE_EVENT, {
        detail: { useHeatmap },
      })
    );
  }

  return true;
}
