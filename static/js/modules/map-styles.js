/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

const getCSSVariable = (varName) =>
  getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

const buildMapLayerColors = () => ({
  trips: {
    default: getCSSVariable("--primary"),
    selected: getCSSVariable("--accent"),
    recent: {
      light: getCSSVariable("--accent-light"),
      dark: getCSSVariable("--accent"),
    },
  },
  matchedTrips: {
    default: getCSSVariable("--danger"),
    highlight: getCSSVariable("--primary-light"),
  },
  streets: {
    undriven: getCSSVariable("--color-undriven"),
    driven: getCSSVariable("--success"),
    all: getCSSVariable("--primary-light"),
  },
  routes: {
    default: getCSSVariable("--accent"),
    active: getCSSVariable("--info"),
    completed: getCSSVariable("--success"),
  },
  clusters: {
    small: getCSSVariable("--warning"),
    medium: getCSSVariable("--accent"),
    large: getCSSVariable("--danger"),
  },
  coverage: {
    driven: getCSSVariable("--success"),
    undriven: getCSSVariable("--color-undriven"),
    undriveable: getCSSVariable("--secondary"),
  },
  customPlaces: {
    fill: getCSSVariable("--primary"),
    outline: getCSSVariable("--primary-dark"),
    highlight: getCSSVariable("--accent"),
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

if (typeof document !== "undefined") {
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
export { MapStyles };
export default MapStyles;
