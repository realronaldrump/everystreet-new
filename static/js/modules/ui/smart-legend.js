import { swupReady } from "../core/navigation.js";
import store from "../core/store.js";
import { getTripLayerHeatmapPreference } from "../features/map/trip-layer-render-mode.js";
import heatmapUtils from "../heatmap-utils.js";
import MapStyles from "../map-styles.js";

const COLLAPSED_KEY = "everystreet:smart-legend-collapsed";
const MOBILE_QUERY = "(max-width: 768px)";
const UPDATE_EVENT = "es:smart-legend-update";
const HEATMAP_MODE_EVENT = "es:trip-layer-render-mode-setting-changed";

const LAYER_DEFINITIONS = [
  {
    key: "trips",
    label: "Trips",
    lineHint: "trip paths",
    heatmapHint: "trip heatmap",
    layerIds: ["trips-layer", "trips-layer-1", "trips-layer-0"],
  },
  {
    key: "matchedTrips",
    label: "Matched trips",
    lineHint: "matched paths",
    heatmapHint: "matched heatmap",
    layerIds: ["matchedTrips-layer", "matchedTrips-layer-1", "matchedTrips-layer-0"],
  },
  {
    key: "drivenStreets",
    label: "Driven streets",
    lineHint: "coverage",
    layerIds: ["drivenStreets-layer"],
  },
  {
    key: "undrivenStreets",
    label: "Undriven streets",
    lineHint: "dashed",
    layerIds: ["undrivenStreets-layer"],
    dashed: true,
  },
  {
    key: "allStreets",
    label: "All streets",
    lineHint: "reference",
    layerIds: ["allStreets-layer"],
  },
  {
    key: "coverageAreaBoundingBox",
    label: "Coverage area",
    lineHint: "boundary",
    layerIds: ["coverageAreaBoundingBox-layer", "coverageAreaBoundingBox-glow"],
  },
];

const getStoredCollapsed = () => {
  try {
    const value = localStorage.getItem(COLLAPSED_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
};

const getMobileDefaultCollapsed = () =>
  typeof window !== "undefined" && window.matchMedia?.(MOBILE_QUERY).matches;

const getTheme = () =>
  document.documentElement?.getAttribute("data-bs-theme") === "light"
    ? "light"
    : "dark";

const hasRenderableData = (layerInfo) => {
  const layer = layerInfo?.layer;
  if (!layer) {
    return false;
  }
  if (layer.type === "TripMapBundle") {
    const tripCount = Number(layer.bundle?.trip_count ?? layer.bundle?.trips?.length);
    return Number.isFinite(tripCount) && tripCount > 0;
  }
  if (Array.isArray(layer.features)) {
    return layer.features.length > 0;
  }
  return true;
};

const getLayerRecord = (layerId) => {
  try {
    return store.map?.getLayer?.(layerId) || null;
  } catch {
    return null;
  }
};

const getLayerVisibility = (layerId, layerRecord = getLayerRecord(layerId)) => {
  try {
    return (
      store.map?.getLayoutProperty?.(layerId, "visibility") ||
      layerRecord?.layout?.visibility ||
      "visible"
    );
  } catch {
    return layerRecord?.layout?.visibility || "visible";
  }
};

const getPaintProperty = (layerId, property) => {
  const layerRecord = getLayerRecord(layerId);
  if (!layerRecord) {
    return null;
  }
  try {
    return (
      store.map?.getPaintProperty?.(layerId, property) || layerRecord.paint?.[property]
    );
  } catch {
    return layerRecord.paint?.[property] || null;
  }
};

const firstStringColor = (value) => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .find((item) => {
        if (typeof item !== "string") {
          return false;
        }
        return /^(#|rgb|hsl)/i.test(item.trim());
      })
      ?.trim();
  }
  return null;
};

const getHeatmapPalette = (layerName) => {
  if (layerName === "matchedTrips") {
    const colors = MapStyles.MAP_LAYER_COLORS?.matchedTrips || {};
    return {
      glow: colors.default || "#c45454",
      core: colors.highlight || "#5fa0c4",
    };
  }
  return heatmapUtils.COLORS[getTheme()] || heatmapUtils.COLORS.dark;
};

const isVisibleLayer = (definition, layerInfo) => {
  if (!layerInfo?.visible || !hasRenderableData(layerInfo)) {
    return false;
  }

  if (layerInfo.layer?.type === "TripMapBundle") {
    return true;
  }

  return definition.layerIds.some((layerId) => {
    const layerRecord = getLayerRecord(layerId);
    return layerRecord && getLayerVisibility(layerId, layerRecord) !== "none";
  });
};

const getLineColor = (definition, layerInfo) => {
  for (const layerId of definition.layerIds) {
    const color = firstStringColor(getPaintProperty(layerId, "line-color"));
    if (color) {
      return color;
    }
  }
  return firstStringColor(layerInfo?.color) || "#727a84";
};

const buildLegendItems = () =>
  LAYER_DEFINITIONS.map((definition) => {
    const layerInfo = store.mapLayers?.[definition.key];
    if (!isVisibleLayer(definition, layerInfo)) {
      return null;
    }

    const usesHeatmap =
      ["trips", "matchedTrips"].includes(definition.key) &&
      layerInfo.isHeatmap &&
      getTripLayerHeatmapPreference();

    if (usesHeatmap) {
      return {
        ...definition,
        hint: definition.heatmapHint,
        type: "heatmap",
        palette: getHeatmapPalette(definition.key),
      };
    }

    return {
      ...definition,
      hint: definition.lineHint,
      type: "line",
      color: getLineColor(definition, layerInfo),
    };
  }).filter(Boolean);

const createLegendRow = (item) => {
  const row = document.createElement("div");
  row.className = "map-smart-legend__row";

  const swatch = document.createElement("span");
  swatch.className = `map-smart-legend__swatch map-smart-legend__swatch--${item.type}`;
  if (item.dashed) {
    swatch.classList.add("map-smart-legend__swatch--dashed");
  }
  swatch.setAttribute("aria-hidden", "true");

  if (item.type === "heatmap") {
    swatch.style.setProperty("--legend-glow-color", item.palette.glow);
    swatch.style.setProperty("--legend-core-color", item.palette.core);
  } else {
    swatch.style.setProperty("--legend-line-color", item.color);
  }

  const label = document.createElement("span");
  label.className = "map-smart-legend__label";
  label.textContent = item.label;

  const hint = document.createElement("span");
  hint.className = "map-smart-legend__hint";
  hint.textContent = item.hint;

  row.append(swatch, label, hint);
  return row;
};

function render(legend) {
  const body = legend?.querySelector(".map-smart-legend__body");
  if (!body) {
    return;
  }

  const items = buildLegendItems();
  legend.hidden = items.length === 0;
  body.replaceChildren(...items.map(createLegendRow));
}

function wire(legend) {
  if (!legend || legend.dataset.wired === "true") {
    return;
  }
  const toggle = legend.querySelector(".map-smart-legend__toggle");
  if (!toggle) {
    return;
  }

  const storedCollapsed = getStoredCollapsed();

  const apply = (collapsed) => {
    legend.dataset.collapsed = collapsed ? "true" : "false";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  apply(storedCollapsed ?? getMobileDefaultCollapsed());

  toggle.addEventListener("click", () => {
    const next = legend.dataset.collapsed !== "true";
    apply(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "true" : "false");
    } catch {
      /* storage unavailable — non-fatal */
    }
  });

  render(legend);
  legend.dataset.wired = "true";
}

function init() {
  document.querySelectorAll("#map-smart-legend").forEach(wire);
}

function updateAll() {
  document.querySelectorAll("#map-smart-legend").forEach(render);
}

function scheduleUpdate() {
  requestAnimationFrame(updateAll);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

[
  "appReady",
  "mapDataLoaded",
  "tripsDataLoaded",
  "matchedTripsDataLoaded",
  "mapStyleLoaded",
  "themeChanged",
  "mapThemeChanged",
  "es:layers-change",
  "es:streetModeChange",
  UPDATE_EVENT,
  HEATMAP_MODE_EVENT,
].forEach((eventName) => {
  document.addEventListener(eventName, scheduleUpdate);
});

swupReady
  .then((swup) => {
    swup.hooks.on("page:view", () => {
      requestAnimationFrame(init);
      requestAnimationFrame(updateAll);
    });
  })
  .catch(() => {});

export default { init, update: scheduleUpdate };
