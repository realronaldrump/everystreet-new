import { CONFIG } from "../../core/config.js";

export const TRIP_LAYER_RENDER_MODE_EVENT = "es:trip-layer-render-mode-setting-changed";

function readStoredBoolean(key) {
  if (!key || typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
    if (raw !== null) {
      return Boolean(JSON.parse(raw));
    }
  } catch {
    // Ignore storage parsing issues.
  }

  return null;
}

export function getTripLayerHeatmapPreference() {
  const key = CONFIG?.STORAGE_KEYS?.tripLayersUseHeatmap;
  const stored = readStoredBoolean(key);
  if (typeof stored === "boolean") {
    return stored;
  }

  return globalThis?.window?.APP_SETTINGS_FLAGS?.tripLayersUseHeatmap !== false;
}

function persistTripLayerHeatmapPreference(useHeatmap) {
  if (typeof useHeatmap !== "boolean" || typeof localStorage === "undefined") {
    return;
  }

  const key = CONFIG?.STORAGE_KEYS?.tripLayersUseHeatmap;
  if (!key) {
    return;
  }

  try {
    localStorage.setItem(key, useHeatmap ? "true" : "false");
  } catch {
    // Ignore storage failures.
  }
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
