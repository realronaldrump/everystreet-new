import { CONFIG } from "../../core/config.js";
import mapCore from "../../map-core.js";
import { resolveMapTypeHint } from "./map-type-hint.js";

export const MAP_TERRAIN_RELIEF_SETTING_EVENT = "es:map-terrain-relief-setting-changed";

// Fires whenever Mapbox 3D terrain is actually applied or removed (as opposed
// to the user *preference* changing). Overlay renderers listen to this so they
// can adapt their rendering mode to the presence of terrain.
export const MAP_TERRAIN_RELIEF_APPLIED_EVENT = "es:map-terrain-relief-applied";

const noopController = Object.freeze({
  refresh() {
    return false;
  },
  destroy() {},
  isEnabled() {
    return false;
  },
});

let googleBaseStyleBeforeTerrain = null;
let terrainReliefApplied = false;

export function isTerrainReliefApplied() {
  return terrainReliefApplied;
}

function setTerrainReliefApplied(active) {
  const next = Boolean(active);
  if (next === terrainReliefApplied) {
    return;
  }
  terrainReliefApplied = next;

  if (
    typeof document !== "undefined" &&
    typeof document.dispatchEvent === "function"
  ) {
    document.dispatchEvent(
      new CustomEvent(MAP_TERRAIN_RELIEF_APPLIED_EVENT, {
        detail: { active: next },
      })
    );
  }
}

function normalizeStyleType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isGoogleProvider() {
  return normalizeStyleType(globalThis?.window?.MAP_PROVIDER) === "google";
}

function getTerrainConfig() {
  return CONFIG?.MAP?.terrainRelief || {};
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

function getFlagDefault() {
  return globalThis?.window?.APP_SETTINGS_FLAGS?.mapTerrainReliefEnabled === true;
}

export function getTerrainReliefPreference() {
  const key = CONFIG?.STORAGE_KEYS?.mapTerrainReliefEnabled;
  const stored = readStoredBoolean(key);
  if (typeof stored === "boolean") {
    return stored;
  }
  return getFlagDefault();
}

function persistTerrainReliefPreference(enabled) {
  if (typeof enabled !== "boolean" || typeof localStorage === "undefined") {
    return;
  }

  const key = CONFIG?.STORAGE_KEYS?.mapTerrainReliefEnabled;
  if (!key) {
    return;
  }

  try {
    localStorage.setItem(key, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures.
  }
}

function syncSettingsToggle(enabled) {
  if (typeof enabled !== "boolean" || typeof document === "undefined") {
    return;
  }

  const settingsToggle = document.getElementById("map-terrain-relief-toggle");
  if (settingsToggle) {
    settingsToggle.checked = enabled;
  }
}

function syncWindowFlags(enabled) {
  if (typeof enabled !== "boolean" || typeof window === "undefined") {
    return;
  }

  window.APP_SETTINGS_FLAGS = {
    ...(window.APP_SETTINGS_FLAGS || {}),
    mapTerrainReliefEnabled: enabled,
  };
}

export function setTerrainReliefPreference(
  enabled,
  { emit = true, syncControls = true } = {}
) {
  if (typeof enabled !== "boolean") {
    return false;
  }

  persistTerrainReliefPreference(enabled);
  syncWindowFlags(enabled);
  if (syncControls) {
    syncSettingsToggle(enabled);
  }

  if (
    emit &&
    typeof document !== "undefined" &&
    typeof document.dispatchEvent === "function"
  ) {
    document.dispatchEvent(
      new CustomEvent(MAP_TERRAIN_RELIEF_SETTING_EVENT, {
        detail: { enabled },
      })
    );
  }

  return true;
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

function getHillshadePaint(styleType) {
  const normalized = normalizeStyleType(styleType) || getCurrentMapTypeHint();

  if (normalized === "satellite") {
    return {
      "hillshade-exaggeration": 0.42,
      "hillshade-shadow-color": "rgba(0, 0, 0, 0.32)",
      "hillshade-highlight-color": "rgba(255, 255, 255, 0.10)",
      "hillshade-accent-color": "rgba(255, 255, 255, 0.04)",
    };
  }

  if (normalized === "dark") {
    return {
      "hillshade-exaggeration": 0.58,
      "hillshade-shadow-color": "rgba(7, 13, 18, 0.54)",
      "hillshade-highlight-color": "rgba(218, 232, 218, 0.16)",
      "hillshade-accent-color": "rgba(121, 145, 122, 0.13)",
    };
  }

  return {
    "hillshade-exaggeration": 0.52,
    "hillshade-shadow-color": "rgba(73, 63, 47, 0.26)",
    "hillshade-highlight-color": "rgba(255, 252, 239, 0.32)",
    "hillshade-accent-color": "rgba(113, 127, 91, 0.12)",
  };
}

function getTerrainExaggeration(styleType) {
  const configured = Number(getTerrainConfig().exaggeration);
  const base = Number.isFinite(configured) ? configured : 1.35;
  return normalizeStyleType(styleType) === "satellite" ? Math.min(base, 1.2) : base;
}

function getOverlayBeforeLayerId(style) {
  const layers = Array.isArray(style?.layers) ? style.layers : [];
  const firstLineOrSymbol = layers.find(
    (layer) => layer?.type === "line" || layer?.type === "symbol"
  );
  return firstLineOrSymbol?.id;
}

function ensureDemSource(map, config) {
  const sourceId = config.sourceId;
  if (!sourceId || typeof map.getSource !== "function") {
    return false;
  }

  if (map.getSource(sourceId)) {
    return true;
  }

  if (typeof map.addSource !== "function") {
    return false;
  }

  try {
    map.addSource(sourceId, {
      type: "raster-dem",
      url: config.demUrl || "mapbox://mapbox.mapbox-terrain-dem-v1",
      tileSize: Number(config.tileSize) || 512,
      maxzoom: Number(config.maxzoom) || 14,
    });
    return true;
  } catch (error) {
    console.warn("Unable to add terrain DEM source:", error);
    return false;
  }
}

function ensureHillshadeLayer(map, config, styleType) {
  const layerId = config.hillshadeLayerId;
  const sourceId = config.sourceId;
  if (!layerId || !sourceId || typeof map.getLayer !== "function") {
    return false;
  }

  const paint = getHillshadePaint(styleType);

  if (map.getLayer(layerId)) {
    if (typeof map.setPaintProperty === "function") {
      Object.entries(paint).forEach(([property, value]) => {
        try {
          map.setPaintProperty(layerId, property, value);
        } catch {
          // Keep the existing layer usable when a style rejects a paint property.
        }
      });
    }
    return true;
  }

  if (typeof map.addLayer !== "function") {
    return false;
  }

  const beforeLayerId = getOverlayBeforeLayerId(readMapStyle(map));
  try {
    map.addLayer(
      {
        id: layerId,
        type: "hillshade",
        source: sourceId,
        paint,
      },
      beforeLayerId
    );
    return true;
  } catch (error) {
    console.warn("Unable to add terrain hillshade layer:", error);
    return false;
  }
}

function removeHillshadeLayer(map, layerId) {
  if (
    !map ||
    !layerId ||
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

function removeDemSource(map, sourceId) {
  if (
    !map ||
    !sourceId ||
    typeof map.getSource !== "function" ||
    typeof map.removeSource !== "function"
  ) {
    return false;
  }

  if (!map.getSource(sourceId)) {
    return false;
  }

  try {
    map.removeSource(sourceId);
    return true;
  } catch {
    return false;
  }
}

export function removeTerrainRelief(map) {
  const config = {
    sourceId: "es-mapbox-dem",
    hillshadeLayerId: "es-terrain-hillshade",
    ...getTerrainConfig(),
  };

  if (typeof map?.setTerrain === "function") {
    try {
      map.setTerrain(null);
    } catch {
      // Ignore terrain removal failures; layer/source cleanup still helps.
    }
  }

  const removedLayer = removeHillshadeLayer(map, config.hillshadeLayerId);
  const removedSource = removeDemSource(map, config.sourceId);
  setTerrainReliefApplied(false);
  return removedLayer || removedSource;
}

export function isMapboxTerrainReliefSupported(map) {
  if (isGoogleProvider()) {
    return false;
  }

  return Boolean(
    map &&
      typeof map.addSource === "function" &&
      typeof map.getSource === "function" &&
      typeof map.addLayer === "function" &&
      typeof map.getLayer === "function" &&
      typeof map.setTerrain === "function" &&
      typeof map.getStyle === "function"
  );
}

export function isGoogleTerrainReliefSupported(map) {
  return Boolean(isGoogleProvider() && map && typeof map.setStyle === "function");
}

export function isTerrainReliefSupported(map) {
  return isGoogleTerrainReliefSupported(map) || isMapboxTerrainReliefSupported(map);
}

function getCurrentGoogleStyle(map) {
  const styleName = normalizeStyleType(readMapStyle(map)?.name);
  if (styleName && styleName !== "terrain") {
    return styleName;
  }

  const hinted = getCurrentMapTypeHint();
  return hinted && hinted !== "terrain" ? hinted : "dark";
}

function applyGoogleTerrainRelief(map) {
  if (!isGoogleTerrainReliefSupported(map)) {
    return false;
  }

  if (getTerrainReliefPreference()) {
    googleBaseStyleBeforeTerrain =
      googleBaseStyleBeforeTerrain || getCurrentGoogleStyle(map);
    map.setStyle("terrain");
    return true;
  }

  const styleToRestore = googleBaseStyleBeforeTerrain || getCurrentGoogleStyle(map);
  googleBaseStyleBeforeTerrain = null;
  map.setStyle(styleToRestore === "terrain" ? "dark" : styleToRestore);
  return false;
}

export function ensureTerrainRelief(map, { styleType } = {}) {
  if (isGoogleProvider()) {
    return applyGoogleTerrainRelief(map);
  }

  if (!getTerrainReliefPreference()) {
    removeTerrainRelief(map);
    return false;
  }

  if (!isMapboxTerrainReliefSupported(map)) {
    removeTerrainRelief(map);
    return false;
  }

  const config = {
    sourceId: "es-mapbox-dem",
    hillshadeLayerId: "es-terrain-hillshade",
    demUrl: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14,
    ...getTerrainConfig(),
  };

  if (!ensureDemSource(map, config)) {
    setTerrainReliefApplied(false);
    return false;
  }

  let terrainApplied = false;
  try {
    map.setTerrain({
      source: config.sourceId,
      exaggeration: getTerrainExaggeration(styleType),
    });
    terrainApplied = true;
  } catch (error) {
    console.warn("Unable to enable 3D terrain:", error);
  }

  setTerrainReliefApplied(terrainApplied);

  return ensureHillshadeLayer(map, config, styleType);
}

export default function initTerrainRelief({ map = null } = {}) {
  const activeMap = map || globalThis?.window?.map || null;
  if (!activeMap) {
    return noopController;
  }

  ensureTerrainRelief(activeMap, { styleType: getCurrentMapTypeHint() });

  let styleChangeHandlerRef = null;
  if (!isGoogleProvider() && typeof mapCore.registerStyleChangeHandler === "function") {
    styleChangeHandlerRef = mapCore.registerStyleChangeHandler(0, (styleType) => {
      ensureTerrainRelief(activeMap, { styleType });
    });
  }

  const handlePreferenceEvent = (event) => {
    const enabled = event?.detail?.enabled;
    if (typeof enabled === "boolean") {
      setTerrainReliefPreference(enabled, { emit: false });
    }
    ensureTerrainRelief(activeMap, { styleType: getCurrentMapTypeHint() });
  };

  if (
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    document.addEventListener(MAP_TERRAIN_RELIEF_SETTING_EVENT, handlePreferenceEvent);
  }

  return {
    refresh(styleType) {
      return ensureTerrainRelief(activeMap, { styleType });
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
        document.removeEventListener(
          MAP_TERRAIN_RELIEF_SETTING_EVENT,
          handlePreferenceEvent
        );
      }
    },
    isEnabled() {
      return getTerrainReliefPreference() && isTerrainReliefSupported(activeMap);
    },
  };
}
