/**
 * Map layer inks, read from the --map-* and related tokens in
 * core/variables.css and re-read when the theme changes.
 */

import { readMapColor, readMapColorAlpha } from "./core/theme-tokens.js";

const CAN_READ_DOCUMENT = typeof document !== "undefined";

const getCSSVariable = readMapColor;

const buildMapLayerColors = () => ({
  trips: {
    default: getCSSVariable("--map-trip-path"),
    selected: getCSSVariable("--map-trip-path-selected"),
    recent: {
      light: getCSSVariable("--map-trip-path"),
      dark: getCSSVariable("--map-trip-path"),
    },
  },
  matchedTrips: {
    default: getCSSVariable("--danger"),
    highlight: getCSSVariable("--cat-sky"),
  },
  streets: {
    undriven: getCSSVariable("--map-undriven"),
    driven: getCSSVariable("--map-driven"),
    all: getCSSVariable("--cat-sky"),
  },
  routes: {
    default: getCSSVariable("--map-route"),
    active: getCSSVariable("--map-driven"),
    completed: getCSSVariable("--map-driven"),
  },
  clusters: {
    small: getCSSVariable("--warning"),
    medium: getCSSVariable("--cat-amber"),
    large: getCSSVariable("--danger"),
  },
  coverage: {
    driven: getCSSVariable("--map-driven"),
    undriven: getCSSVariable("--map-undriven"),
    undriveable: getCSSVariable("--map-undriveable"),
  },
  customPlaces: {
    fill: getCSSVariable("--map-place"),
    outline: getCSSVariable("--map-place-outline"),
    highlight: getCSSVariable("--map-route"),
  },
  optimalRoute: {
    driven: getCSSVariable("--map-driven"),
    undriven: getCSSVariable("--map-undriven"),
    route: getCSSVariable("--map-route"),
    arrow: getCSSVariable("--map-route"),
  },
  googleDefaults: {
    line: getCSSVariable("--map-route"),
    circle: getCSSVariable("--warning-dark"),
    circleStroke: getCSSVariable("--surface-1"),
    fill: getCSSVariable("--warning-dark"),
    fillOutline: getCSSVariable("--warning-dark"),
  },
  county: {
    visitedFill: getCSSVariable("--map-driven"),
    visitedBorder: getCSSVariable("--map-place-outline"),
    stoppedFill: getCSSVariable("--info"),
    stoppedBorder: getCSSVariable("--info-dark"),
    hoverFill: getCSSVariable("--surface-1"),
    borderCounty: readMapColorAlpha("--manual-ink-rgb", 0.15),
    borderCity: readMapColorAlpha("--manual-ink-rgb", 0.25),
    stateLow: readMapColorAlpha("--manual-ink-rgb", 0.08),
    stateMedium: readMapColorAlpha("--manual-navy-rgb", 0.45),
    stateHigh: readMapColorAlpha("--manual-navy-rgb", 0.8),
    cityUnvisited: readMapColorAlpha("--manual-ink-rgb", 0.08),
  },
});

const buildMapLayerStyles = (colors) => ({
  trip: {
    default: {
      color: colors.trips.default,
      width: 4,
    },
    selected: {
      color: colors.trips.selected,
      width: 6,
    },
    recent: {
      color: colors.trips.recent.light,
      width: 4,
    },
    matched: {
      color: colors.matchedTrips.default,
      width: 4,
    },
  },
});

const updateNestedValues = (target, source) => {
  Object.entries(source).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }
      updateNestedValues(target[key], value);
      return;
    }
    target[key] = value;
  });
  return target;
};

/**
 * The ink a Map page layer draws in: a colour set on the layer, else its
 * token read now, so a layer re-added after a theme switch takes the new
 * edition's ink. `key` picks color, highlightColor, or glowColor.
 */
export function layerColor(layerInfo, key = "color") {
  const set = layerInfo?.[key];
  if (set) {
    return set;
  }
  const token = layerInfo?.[`${key}Token`];
  return token ? readMapColor(token) : "";
}

const MAP_LAYER_COLORS = buildMapLayerColors();
const MAP_LAYER_STYLES = buildMapLayerStyles(MAP_LAYER_COLORS);

const refreshMapStyles = () => {
  const nextColors = buildMapLayerColors();
  updateNestedValues(MAP_LAYER_COLORS, nextColors);
  const nextStyles = buildMapLayerStyles(MAP_LAYER_COLORS);
  updateNestedValues(MAP_LAYER_STYLES, nextStyles);
  return { MAP_LAYER_COLORS, MAP_LAYER_STYLES };
};

if (CAN_READ_DOCUMENT) {
  document.addEventListener("themeChanged", refreshMapStyles);
  document.addEventListener("mapThemeChanged", refreshMapStyles);
}

function getClusterColor(count) {
  if (count < 10) {
    return MAP_LAYER_COLORS.clusters.small;
  }
  if (count < 50) {
    return MAP_LAYER_COLORS.clusters.medium;
  }
  return MAP_LAYER_COLORS.clusters.large;
}

function getTripStyle(state = "default") {
  return MAP_LAYER_STYLES.trip[state];
}

const MapStyles = {
  MAP_LAYER_COLORS,
  layerColor,
  MAP_LAYER_STYLES,
  refreshMapStyles,
  getClusterColor,
  getTripStyle,
};

export default MapStyles;
