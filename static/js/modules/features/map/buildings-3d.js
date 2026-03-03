import { CONFIG } from "../../core/config.js";
import { coverageBoundaryToFeatureCollection } from "../../core/coverage-bounds.js";
import mapCore from "../../map-core.js";
import { utils } from "../../utils.js";

const PRIMARY_FILTER = ["==", ["get", "extrude"], "true"];
const FALLBACK_FILTER = ["has", "height"];
const MAP_3D_SETTING_EVENT = "es:map-3d-buildings-setting-changed";
const COVERAGE_SELECTION_EVENT = "es:coverage-area-selection-changed";

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

function normalizeAreaId(value) {
  return typeof value === "string" ? value.trim() : "";
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

function readStoredMapType() {
  if (typeof localStorage === "undefined") {
    return "";
  }

  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.mapType);
    if (raw === null) {
      return "";
    }

    try {
      return normalizeStyleType(JSON.parse(raw));
    } catch {
      return normalizeStyleType(raw);
    }
  } catch {
    return "";
  }
}

function getCurrentMapTypeHint() {
  if (typeof document !== "undefined") {
    const select = document.getElementById("map-type-select");
    if (select?.value) {
      return normalizeStyleType(select.value);
    }
  }

  return readStoredMapType();
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

function readSelectedCoverageAreaId() {
  if (typeof document !== "undefined") {
    const select = document.getElementById("streets-location");
    if (typeof select?.value === "string") {
      return normalizeAreaId(select.value);
    }
  }

  if (typeof localStorage === "undefined") {
    return "";
  }

  try {
    const raw = localStorage.getItem(CONFIG?.STORAGE_KEYS?.selectedLocation);
    if (raw === null) {
      return "";
    }

    try {
      return normalizeAreaId(JSON.parse(raw));
    } catch {
      return normalizeAreaId(raw);
    }
  } catch {
    return "";
  }
}

function buildScopedFilter(baseFilter, coverageBoundary = null) {
  if (!coverageBoundary) {
    return baseFilter;
  }

  // Use a direct `within` filter here to avoid edge cases where combining
  // `within` with additional boolean wrappers can produce zero matches.
  return ["within", coverageBoundary];
}

function isCoordinatePair(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function normalizeRing(rawRing) {
  if (!Array.isArray(rawRing)) {
    return null;
  }

  const ring = rawRing.filter(isCoordinatePair).map(([lng, lat]) => [
    Number(lng),
    Number(lat),
  ]);

  if (ring.length < 3) {
    return null;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  if (ring.length < 4) {
    return null;
  }

  return ring;
}

function normalizePolygon(rawPolygon) {
  if (!Array.isArray(rawPolygon) || rawPolygon.length === 0) {
    return null;
  }

  const rings = rawPolygon.map(normalizeRing).filter(Boolean);
  if (rings.length === 0) {
    return null;
  }

  return rings;
}

function toWithinGeometry(coverageBoundaryFeatureCollection) {
  const features = Array.isArray(coverageBoundaryFeatureCollection?.features)
    ? coverageBoundaryFeatureCollection.features
    : [];

  const polygons = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    const geometryType = geometry?.type;

    if (geometryType === "Polygon") {
      const normalized = normalizePolygon(geometry.coordinates);
      if (normalized) {
        polygons.push(normalized);
      }
      continue;
    }

    if (geometryType === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
      for (const polygonCoordinates of geometry.coordinates) {
        const normalized = normalizePolygon(polygonCoordinates);
        if (normalized) {
          polygons.push(normalized);
        }
      }
    }
  }

  if (polygons.length === 0) {
    return null;
  }

  if (polygons.length === 1) {
    return {
      type: "Polygon",
      coordinates: polygons[0],
    };
  }

  return {
    type: "MultiPolygon",
    coordinates: polygons,
  };
}

function applyLayerFilter(map, layerId, coverageBoundary = null) {
  if (typeof map.setFilter !== "function") {
    return;
  }

  const scopedFilter = buildScopedFilter(PRIMARY_FILTER, coverageBoundary);
  const candidates = [scopedFilter];
  if (coverageBoundary) {
    candidates.push(PRIMARY_FILTER, FALLBACK_FILTER);
  } else {
    candidates.push(buildScopedFilter(FALLBACK_FILTER, coverageBoundary));
  }

  for (const candidate of candidates) {
    try {
      map.setFilter(layerId, candidate);
      return;
    } catch {
      // Try the next filter candidate.
    }
  }
}

async function fetchCoverageBoundaryGeojson(areaId) {
  const normalizedAreaId = normalizeAreaId(areaId);
  if (!normalizedAreaId) {
    return null;
  }

  try {
    const areaDetail = await utils.fetchWithRetry(
      CONFIG.API.coverageAreaById(normalizedAreaId),
      {},
      CONFIG.API.retryAttempts,
      CONFIG.API.cacheTime,
      `coverage-area-boundary:buildings3d:${normalizedAreaId}`
    );
    const coverageFeatureCollection = coverageBoundaryToFeatureCollection(areaDetail?.boundary, {
      coverageAreaId: normalizedAreaId,
    });
    return toWithinGeometry(coverageFeatureCollection);
  } catch (error) {
    console.warn(
      `Unable to apply 3D building boundary for coverage area ${normalizedAreaId}:`,
      error
    );
    return null;
  }
}

function updateExistingLayer(map, layerId, beforeLayerId, config, coverageBoundary = null) {
  const paint = createLayerDefinition(config, PRIMARY_FILTER).paint;

  applyLayerFilter(map, layerId, coverageBoundary);

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
  if (!map || typeof map.getLayer !== "function" || typeof map.removeLayer !== "function") {
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

export function ensureBuildingsLayer(map, { styleType, coverageBoundary = null } = {}) {
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
  const layerId = config.layerId;

  if (map.getLayer(layerId)) {
    updateExistingLayer(map, layerId, beforeLayerId, config, coverageBoundary);
    return true;
  }

  const primaryDefinition = createLayerDefinition(
    config,
    buildScopedFilter(PRIMARY_FILTER, coverageBoundary)
  );
  try {
    map.addLayer(primaryDefinition, beforeLayerId);
    return true;
  } catch {
    const fallbackDefinition = createLayerDefinition(
      config,
      buildScopedFilter(FALLBACK_FILTER, coverageBoundary)
    );
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

  let selectedCoverageAreaId = readSelectedCoverageAreaId();
  const coverageBoundaryCache = new Map();
  let activeCoverageBoundary = null;
  let coverageSyncCounter = 0;

  const loadCoverageBoundary = async (areaId) => {
    const normalizedAreaId = normalizeAreaId(areaId);
    if (!normalizedAreaId) {
      return null;
    }
    if (coverageBoundaryCache.has(normalizedAreaId)) {
      return coverageBoundaryCache.get(normalizedAreaId);
    }

    const boundary = await fetchCoverageBoundaryGeojson(normalizedAreaId);
    coverageBoundaryCache.set(normalizedAreaId, boundary);
    return boundary;
  };

  const syncCoverageBoundaryFilter = async (styleType = getCurrentMapTypeHint()) => {
    const syncToken = ++coverageSyncCounter;
    const normalizedAreaId = normalizeAreaId(selectedCoverageAreaId);

    if (!normalizedAreaId) {
      activeCoverageBoundary = null;
      ensureBuildingsLayer(activeMap, { styleType, coverageBoundary: null });
      return;
    }

    const nextBoundary = await loadCoverageBoundary(normalizedAreaId);
    if (syncToken !== coverageSyncCounter) {
      return;
    }

    activeCoverageBoundary = nextBoundary;
    ensureBuildingsLayer(activeMap, {
      styleType,
      coverageBoundary: activeCoverageBoundary,
    });
  };

  ensureBuildingsLayer(activeMap, {
    styleType: getCurrentMapTypeHint(),
    coverageBoundary: null,
  });
  void syncCoverageBoundaryFilter(getCurrentMapTypeHint());

  let styleChangeHandlerRef = null;
  if (typeof mapCore.registerStyleChangeHandler === "function") {
    styleChangeHandlerRef = mapCore.registerStyleChangeHandler(3, async (styleType) => {
      await syncCoverageBoundaryFilter(styleType);
    });
  }

  const handlePreferenceEvent = (event) => {
    const enabled = event?.detail?.enabled;
    if (typeof enabled === "boolean") {
      persistUserBuildingsPreference(enabled);
    }
    ensureBuildingsLayer(activeMap, {
      styleType: getCurrentMapTypeHint(),
      coverageBoundary: activeCoverageBoundary,
    });
  };

  const handleCoverageSelectionEvent = (event) => {
    selectedCoverageAreaId =
      normalizeAreaId(event?.detail?.areaId) || readSelectedCoverageAreaId();
    activeCoverageBoundary = null;
    void syncCoverageBoundaryFilter(getCurrentMapTypeHint());
  };

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener(MAP_3D_SETTING_EVENT, handlePreferenceEvent);
    document.addEventListener(COVERAGE_SELECTION_EVENT, handleCoverageSelectionEvent);
  }

  return {
    refresh(styleType) {
      return ensureBuildingsLayer(activeMap, {
        styleType,
        coverageBoundary: activeCoverageBoundary,
      });
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
        document.removeEventListener(COVERAGE_SELECTION_EVENT, handleCoverageSelectionEvent);
      }
    },
    isEnabled() {
      return isSupportedMapbox3D(activeMap);
    },
  };
}
