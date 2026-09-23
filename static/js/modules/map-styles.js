/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

import { readToken } from "./core/theme-tokens.js";

const CAN_READ_DOCUMENT = typeof document !== "undefined";

// Fallbacks for environments without computed styles (tests, workers).
// The live values come from the --map-* inks in core/variables.css.
const DEFAULT_MAP_LAYER_COLORS = Object.freeze({
  trips: {
    default: "#7fb0cf",
    selected: "#e9dfc6",
    recentLight: "#2f6f95",
    recentDark: "#7fb0cf",
  },
  matchedTrips: {
    default: "#b5523f",
    highlight: "#93acbf",
  },
  streets: {
    undriven: "#d27b58",
    driven: "#8fb1c8",
    all: "#93acbf",
  },
  routes: {
    default: "#dcb35a",
    active: "#8fb1c8",
    completed: "#8fb1c8",
  },
  clusters: {
    small: "#c49d4c",
    medium: "#b5824a",
    large: "#b5523f",
  },
  coverage: {
    driven: "#8fb1c8",
    undriven: "#d27b58",
    undriveable: "#7d7568",
  },
  customPlaces: {
    fill: "#8fb1c8",
    outline: "#6e93ad",
    highlight: "#dcb35a",
  },
  optimalRoute: {
    driven: "#8fb1c8",
    undriven: "#d27b58",
    route: "#dcb35a",
    arrow: "#dcb35a",
  },
  googleDefaults: {
    line: "#dcb35a",
    circle: "#9c7a33",
    circleStroke: "#22201b",
    fill: "#9c7a33",
    fillOutline: "#9c7a33",
  },
  county: {
    visitedFill: "#8fb1c8",
    visitedBorder: "#6e93ad",
    stoppedFill: "#7893a6",
    stoppedBorder: "#4f6b80",
    hoverFill: "#f1e8d5",
    borderCounty: "rgba(236, 226, 203, 0.15)",
    borderCity: "rgba(236, 226, 203, 0.25)",
    stateLow: "rgba(236, 226, 203, 0.08)",
    stateMedium: "rgba(143, 177, 200, 0.45)",
    stateHigh: "rgba(79, 107, 128, 0.75)",
    cityUnvisited: "rgba(236, 226, 203, 0.08)",
  },
});

const getCSSVariable = readToken;

const buildMapLayerColors = () => ({
  trips: {
    default: getCSSVariable("--map-trip-path", DEFAULT_MAP_LAYER_COLORS.trips.default),
    selected: getCSSVariable(
      "--map-trip-path-selected",
      DEFAULT_MAP_LAYER_COLORS.trips.selected
    ),
    recent: {
      light: getCSSVariable(
        "--map-trip-path",
        DEFAULT_MAP_LAYER_COLORS.trips.recentLight
      ),
      dark: getCSSVariable(
        "--map-trip-path",
        DEFAULT_MAP_LAYER_COLORS.trips.recentDark
      ),
    },
  },
  matchedTrips: {
    default: getCSSVariable("--danger", DEFAULT_MAP_LAYER_COLORS.matchedTrips.default),
    highlight: getCSSVariable(
      "--cat-sky",
      DEFAULT_MAP_LAYER_COLORS.matchedTrips.highlight
    ),
  },
  streets: {
    undriven: getCSSVariable(
      "--map-undriven",
      DEFAULT_MAP_LAYER_COLORS.streets.undriven
    ),
    driven: getCSSVariable("--map-driven", DEFAULT_MAP_LAYER_COLORS.streets.driven),
    all: getCSSVariable("--cat-sky", DEFAULT_MAP_LAYER_COLORS.streets.all),
  },
  routes: {
    default: getCSSVariable("--map-route", DEFAULT_MAP_LAYER_COLORS.routes.default),
    active: getCSSVariable("--map-driven", DEFAULT_MAP_LAYER_COLORS.routes.active),
    completed: getCSSVariable(
      "--map-driven",
      DEFAULT_MAP_LAYER_COLORS.routes.completed
    ),
  },
  clusters: {
    small: getCSSVariable("--warning", DEFAULT_MAP_LAYER_COLORS.clusters.small),
    medium: getCSSVariable("--cat-amber", DEFAULT_MAP_LAYER_COLORS.clusters.medium),
    large: getCSSVariable("--danger", DEFAULT_MAP_LAYER_COLORS.clusters.large),
  },
  coverage: {
    driven: getCSSVariable("--map-driven", DEFAULT_MAP_LAYER_COLORS.coverage.driven),
    undriven: getCSSVariable(
      "--map-undriven",
      DEFAULT_MAP_LAYER_COLORS.coverage.undriven
    ),
    undriveable: getCSSVariable(
      "--map-undriveable",
      DEFAULT_MAP_LAYER_COLORS.coverage.undriveable
    ),
  },
  customPlaces: {
    fill: getCSSVariable("--map-place", DEFAULT_MAP_LAYER_COLORS.customPlaces.fill),
    outline: getCSSVariable(
      "--map-place-outline",
      DEFAULT_MAP_LAYER_COLORS.customPlaces.outline
    ),
    highlight: getCSSVariable(
      "--map-route",
      DEFAULT_MAP_LAYER_COLORS.customPlaces.highlight
    ),
  },
  optimalRoute: {
    driven: getCSSVariable(
      "--map-driven",
      DEFAULT_MAP_LAYER_COLORS.optimalRoute.driven
    ),
    undriven: getCSSVariable(
      "--map-undriven",
      DEFAULT_MAP_LAYER_COLORS.optimalRoute.undriven
    ),
    route: getCSSVariable("--map-route", DEFAULT_MAP_LAYER_COLORS.optimalRoute.route),
    arrow: getCSSVariable("--map-route", DEFAULT_MAP_LAYER_COLORS.optimalRoute.arrow),
  },
  googleDefaults: {
    line: getCSSVariable("--map-route", DEFAULT_MAP_LAYER_COLORS.googleDefaults.line),
    circle: getCSSVariable(
      "--warning-dark",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.circle
    ),
    circleStroke: getCSSVariable(
      "--surface-1",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.circleStroke
    ),
    fill: getCSSVariable(
      "--warning-dark",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.fill
    ),
    fillOutline: getCSSVariable(
      "--warning-dark",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.fillOutline
    ),
  },
  county: {
    visitedFill: getCSSVariable(
      "--map-driven",
      DEFAULT_MAP_LAYER_COLORS.county.visitedFill
    ),
    visitedBorder: getCSSVariable(
      "--map-place-outline",
      DEFAULT_MAP_LAYER_COLORS.county.visitedBorder
    ),
    stoppedFill: getCSSVariable("--info", DEFAULT_MAP_LAYER_COLORS.county.stoppedFill),
    stoppedBorder: getCSSVariable(
      "--info-dark",
      DEFAULT_MAP_LAYER_COLORS.county.stoppedBorder
    ),
    hoverFill: getCSSVariable("--surface-1", DEFAULT_MAP_LAYER_COLORS.county.hoverFill),
    borderCounty: DEFAULT_MAP_LAYER_COLORS.county.borderCounty,
    borderCity: DEFAULT_MAP_LAYER_COLORS.county.borderCity,
    stateLow: DEFAULT_MAP_LAYER_COLORS.county.stateLow,
    stateMedium: DEFAULT_MAP_LAYER_COLORS.county.stateMedium,
    stateHigh: DEFAULT_MAP_LAYER_COLORS.county.stateHigh,
    cityUnvisited: DEFAULT_MAP_LAYER_COLORS.county.cityUnvisited,
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
  MAP_LAYER_STYLES,
  refreshMapStyles,
  getClusterColor,
  getTripStyle,
};

export default MapStyles;
