/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

const CAN_READ_DOCUMENT =
  typeof document !== "undefined" && typeof getComputedStyle === "function";

const DEFAULT_MAP_LAYER_COLORS = Object.freeze({
  trips: {
    default: "#3b8a7f",
    selected: "#d09868",
    recentLight: "#d09868",
    recentDark: "#a87449",
  },
  matchedTrips: {
    default: "#c45454",
    highlight: "#5fa0c4",
  },
  streets: {
    undriven: "#c47050",
    driven: "#4d9a6a",
    all: "#6a9fc0",
  },
  routes: {
    default: "#d09868",
    active: "#3b8a7f",
    completed: "#4d9a6a",
  },
  clusters: {
    small: "#d4a24a",
    medium: "#d09868",
    large: "#c45454",
  },
  coverage: {
    driven: "#4d9a6a",
    undriven: "#c47050",
    undriveable: "#727a84",
  },
  customPlaces: {
    fill: "#3b8a7f",
    outline: "#2a6b63",
    highlight: "#d09868",
  },
  optimalRoute: {
    driven: "#4d9a6a",
    undriven: "#c47050",
    route: "#b87a4a",
    arrow: "#b87a4a",
  },
  googleDefaults: {
    line: "#d4943c",
    circle: "#b87a4a",
    circleStroke: "#ffffff",
    fill: "#b87a4a",
    fillOutline: "#b87a4a",
  },
  county: {
    visitedFill: "#4d9a6a",
    visitedBorder: "#3b7a53",
    stoppedFill: "#5b9bd5",
    stoppedBorder: "#4a80b4",
    hoverFill: "#faf9f7",
    borderCounty: "rgba(245, 242, 236, 0.15)",
    borderCity: "rgba(245, 242, 236, 0.25)",
    stateLow: "rgba(245, 242, 236, 0.08)",
    stateMedium: "rgba(111, 179, 136, 0.45)",
    stateHigh: "rgba(62, 132, 91, 0.75)",
    cityUnvisited: "rgba(245, 242, 236, 0.08)",
  },
});

const getCSSVariable = (varName, fallback = "") => {
  if (!CAN_READ_DOCUMENT) {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value || fallback;
};

const buildMapLayerColors = () => ({
  trips: {
    default: getCSSVariable("--primary", DEFAULT_MAP_LAYER_COLORS.trips.default),
    selected: getCSSVariable("--accent", DEFAULT_MAP_LAYER_COLORS.trips.selected),
    recent: {
      light: getCSSVariable(
        "--accent-light",
        DEFAULT_MAP_LAYER_COLORS.trips.recentLight
      ),
      dark: getCSSVariable("--accent", DEFAULT_MAP_LAYER_COLORS.trips.recentDark),
    },
  },
  matchedTrips: {
    default: getCSSVariable("--danger", DEFAULT_MAP_LAYER_COLORS.matchedTrips.default),
    highlight: getCSSVariable(
      "--primary-light",
      DEFAULT_MAP_LAYER_COLORS.matchedTrips.highlight
    ),
  },
  streets: {
    undriven: getCSSVariable(
      "--color-undriven",
      DEFAULT_MAP_LAYER_COLORS.streets.undriven
    ),
    driven: getCSSVariable("--success", DEFAULT_MAP_LAYER_COLORS.streets.driven),
    all: getCSSVariable("--primary-light", DEFAULT_MAP_LAYER_COLORS.streets.all),
  },
  routes: {
    default: getCSSVariable("--accent", DEFAULT_MAP_LAYER_COLORS.routes.default),
    active: getCSSVariable("--info", DEFAULT_MAP_LAYER_COLORS.routes.active),
    completed: getCSSVariable("--success", DEFAULT_MAP_LAYER_COLORS.routes.completed),
  },
  clusters: {
    small: getCSSVariable("--warning", DEFAULT_MAP_LAYER_COLORS.clusters.small),
    medium: getCSSVariable("--accent", DEFAULT_MAP_LAYER_COLORS.clusters.medium),
    large: getCSSVariable("--danger", DEFAULT_MAP_LAYER_COLORS.clusters.large),
  },
  coverage: {
    driven: getCSSVariable("--success", DEFAULT_MAP_LAYER_COLORS.coverage.driven),
    undriven: getCSSVariable(
      "--color-undriven",
      DEFAULT_MAP_LAYER_COLORS.coverage.undriven
    ),
    undriveable: getCSSVariable(
      "--secondary",
      DEFAULT_MAP_LAYER_COLORS.coverage.undriveable
    ),
  },
  customPlaces: {
    fill: getCSSVariable("--primary", DEFAULT_MAP_LAYER_COLORS.customPlaces.fill),
    outline: getCSSVariable(
      "--primary-dark",
      DEFAULT_MAP_LAYER_COLORS.customPlaces.outline
    ),
    highlight: getCSSVariable(
      "--accent",
      DEFAULT_MAP_LAYER_COLORS.customPlaces.highlight
    ),
  },
  optimalRoute: {
    driven: getCSSVariable("--success", DEFAULT_MAP_LAYER_COLORS.optimalRoute.driven),
    undriven: getCSSVariable(
      "--color-undriven",
      DEFAULT_MAP_LAYER_COLORS.optimalRoute.undriven
    ),
    route: getCSSVariable("--accent-dark", DEFAULT_MAP_LAYER_COLORS.optimalRoute.route),
    arrow: getCSSVariable("--accent-dark", DEFAULT_MAP_LAYER_COLORS.optimalRoute.arrow),
  },
  googleDefaults: {
    line: getCSSVariable("--accent", DEFAULT_MAP_LAYER_COLORS.googleDefaults.line),
    circle: getCSSVariable(
      "--accent-dark",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.circle
    ),
    circleStroke: getCSSVariable(
      "--surface-1",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.circleStroke
    ),
    fill: getCSSVariable("--accent-dark", DEFAULT_MAP_LAYER_COLORS.googleDefaults.fill),
    fillOutline: getCSSVariable(
      "--accent-dark",
      DEFAULT_MAP_LAYER_COLORS.googleDefaults.fillOutline
    ),
  },
  county: {
    visitedFill: getCSSVariable(
      "--success",
      DEFAULT_MAP_LAYER_COLORS.county.visitedFill
    ),
    visitedBorder: getCSSVariable(
      "--success-dark",
      DEFAULT_MAP_LAYER_COLORS.county.visitedBorder
    ),
    stoppedFill: getCSSVariable(
      "--danger",
      DEFAULT_MAP_LAYER_COLORS.county.stoppedFill
    ),
    stoppedBorder: getCSSVariable(
      "--danger-dark",
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

export {
  MAP_LAYER_COLORS,
  MAP_LAYER_STYLES,
  refreshMapStyles,
  getClusterColor,
  getTripStyle,
};
export default MapStyles;
