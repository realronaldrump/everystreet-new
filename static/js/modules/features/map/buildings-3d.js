import { CONFIG } from "../../core/config.js";
import mapCore from "../../map-core.js";
import { resolveMapTypeHint } from "./map-type-hint.js";

const PRIMARY_FILTER = ["==", ["get", "extrude"], "true"];
const FALLBACK_FILTER = ["has", "height"];
const MAP_3D_SETTING_EVENT = "es:map-3d-buildings-setting-changed";

const noopController = Object.freeze({
  refresh() {
    return false;
  },
  destroy() {},
  isEnabled() {
    return false;
  },
});

function normalizeStyleType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getBuildingsConfig() {
  return CONFIG?.MAP?.buildings3d || {};
}

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

function getUserBuildingsPreference() {
  const key = CONFIG?.STORAGE_KEYS?.map3dBuildingsEnabled;
  const stored = readStoredBoolean(key);
  if (typeof stored === "boolean") {
    return stored;
  }
  return true;
}

function persistUserBuildingsPreference(enabled) {
  if (typeof enabled !== "boolean" || typeof localStorage === "undefined") {
    return;
  }

  const key = CONFIG?.STORAGE_KEYS?.map3dBuildingsEnabled;
  if (!key) {
    return;
  }

  try {
    localStorage.setItem(key, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures.
  }
}

function isGoogleProvider() {
  return normalizeStyleType(globalThis?.window?.MAP_PROVIDER) === "google";
}

function readMapStyle(map) {
  if (!map || typeof map.getStyle !== "function") {
    return null;
  }

  try {
    const style = map.getStyle();
    if (style && typeof style === "object") {
      return style;
    }
  } catch {
    // Style might not be ready yet.
  }

  return null;
}

function getCurrentMapTypeHint() {
  return resolveMapTypeHint({
    storageKey: CONFIG.STORAGE_KEYS.mapType,
    normalizeStyleType,
  });
}

function isSatelliteStyle(styleType) {
  return normalizeStyleType(styleType) === "satellite";
}

function hasCompositeSource(style) {
  return Boolean(style?.sources?.composite);
}

function getFirstSymbolLayerId(style) {
  const layers = Array.isArray(style?.layers) ? style.layers : [];
  const firstSymbolWithText = layers.find(
    (layer) => layer?.type === "symbol" && layer?.layout?.["text-field"]
  );
  return firstSymbolWithText?.id;
}

function createLayerDefinition(config, filterExpression) {
  const opacity = Number(config.opacity);
  const fillOpacity = Number.isFinite(opacity) ? opacity : 0.7;
  const minZoom = Number(config.minZoom);

  return {
    id: config.layerId,
    type: "fill-extrusion",
    source: "composite",
    "source-layer": "building",
    filter: filterExpression,
    minzoom: Number.isFinite(minZoom) ? minZoom : 14.5,
    paint: {
      "fill-extrusion-color": [
        "interpolate",
        ["linear"],
        ["coalesce", ["get", "height"], 0],
        0,
        "#575f6f",
        60,
        "#7b8597",
        180,
        "#a2adbf",
      ],
      "fill-extrusion-height": ["coalesce", ["get", "height"], 0],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": fillOpacity,
      "fill-extrusion-vertical-gradient": true,
    },
  };
}

function applyLayerFilter(map, layerId) {
  if (!map || typeof map.setFilter !== "function") {
    return false;
  }

  try {
    map.setFilter(layerId, PRIMARY_FILTER);
    return true;
  } catch {
    // Fallback handles styles where the primary expression is unsupported.
  }

  try {
    map.setFilter(layerId, FALLBACK_FILTER);
    return true;
  } catch {
    return false;
  }
}

function updateExistingLayer(map, layerId, beforeLayerId, config) {
  const { paint } = createLayerDefinition(config, PRIMARY_FILTER);

  applyLayerFilter(map, layerId);

  if (typeof map.setPaintProperty === "function") {
    Object.entries(paint).forEach(([key, value]) => {
      try {
        map.setPaintProperty(layerId, key, value);
      } catch {
        // Ignore per-property errors to keep existing layer usable.
      }
    });
  }

  if (typeof map.setLayerZoomRange === "function") {
    const minZoom = Number(config.minZoom);
    const min = Number.isFinite(minZoom) ? minZoom : 14.5;
    try {
      map.setLayerZoomRange(layerId, min, 24);
    } catch {
      // Ignore zoom-range update errors.
    }
  }

  if (beforeLayerId && typeof map.moveLayer === "function") {
    try {
      map.moveLayer(layerId, beforeLayerId);
    } catch {
      // Ignore move errors when target layer is not available.
    }
  }
}

export function removeBuildingsLayer(map) {
  const layerId = getBuildingsConfig().layerId || "es-3d-buildings";
  if (
    !map ||
    typeof map.getLayer !== "function" ||
    typeof map.removeLayer !== "function"
  ) {
    return false;
  }

  if (!map.getLayer(layerId)) {
    return false;
  }

  try {
    map.removeLayer(layerId);
    return true;
  } catch {
    return false;
  }
}

export function isSupportedMapbox3D(map, { styleType } = {}) {
  const config = getBuildingsConfig();
  if (!config.enabled) {
    return false;
  }
  if (!getUserBuildingsPreference()) {
    return false;
  }

  if (isGoogleProvider()) {
    return false;
  }

  if (
    !map ||
    typeof map.addLayer !== "function" ||
    typeof map.getLayer !== "function" ||
    typeof map.getStyle !== "function"
  ) {
    return false;
  }

  const styleTypeHint = normalizeStyleType(styleType) || getCurrentMapTypeHint();
  if (isSatelliteStyle(styleTypeHint)) {
    return false;
  }

  const style = readMapStyle(map);
  if (!style || !hasCompositeSource(style)) {
    return false;
  }

  return true;
}

export function ensureBuildingsLayer(map, { styleType } = {}) {
  const config = {
    layerId: "es-3d-buildings",
    minZoom: 14.5,
    opacity: 0.7,
    ...getBuildingsConfig(),
  };

  if (!isSupportedMapbox3D(map, { styleType })) {
    removeBuildingsLayer(map);
    return false;
  }

  const style = readMapStyle(map);
  const beforeLayerId = getFirstSymbolLayerId(style);
  const { layerId } = config;

  if (map.getLayer(layerId)) {
    updateExistingLayer(map, layerId, beforeLayerId, config);
    return true;
  }

  const primaryDefinition = createLayerDefinition(config, PRIMARY_FILTER);
  try {
    map.addLayer(primaryDefinition, beforeLayerId);
    return true;
  } catch {
    const fallbackDefinition = createLayerDefinition(config, FALLBACK_FILTER);
    try {
      map.addLayer(fallbackDefinition, beforeLayerId);
      return true;
    } catch (error) {
      console.warn("Unable to add 3D buildings layer:", error);
      return false;
    }
  }
}

export default function initBuildings3D({ map = null } = {}) {
  const activeMap = map || globalThis?.window?.map || null;
  if (!activeMap) {
    return noopController;
  }

  ensureBuildingsLayer(activeMap, { styleType: getCurrentMapTypeHint() });

  let styleChangeHandlerRef = null;
  if (typeof mapCore.registerStyleChangeHandler === "function") {
    styleChangeHandlerRef = mapCore.registerStyleChangeHandler(3, (styleType) => {
      ensureBuildingsLayer(activeMap, { styleType });
    });
  }

  const handlePreferenceEvent = (event) => {
    const enabled = event?.detail?.enabled;
    if (typeof enabled === "boolean") {
      persistUserBuildingsPreference(enabled);
    }
    ensureBuildingsLayer(activeMap, { styleType: getCurrentMapTypeHint() });
  };

  if (
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    document.addEventListener(MAP_3D_SETTING_EVENT, handlePreferenceEvent);
  }

  return {
    refresh(styleType) {
      return ensureBuildingsLayer(activeMap, { styleType });
    },
    destroy() {
      if (
        styleChangeHandlerRef &&
        typeof mapCore.unregisterStyleChangeHandler === "function"
      ) {
        mapCore.unregisterStyleChangeHandler(styleChangeHandlerRef);
      }
      styleChangeHandlerRef = null;
      if (
        typeof document !== "undefined" &&
        typeof document.removeEventListener === "function"
      ) {
        document.removeEventListener(MAP_3D_SETTING_EVENT, handlePreferenceEvent);
      }
    },
    isEnabled() {
      return isSupportedMapbox3D(activeMap);
    },
  };
}
