/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

const getCSSVariable = (varName) =>
  getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

const MAP_LAYER_COLORS = {
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
};

const MAP_LAYER_STYLES = {
  trip: {
    default: {
      color: MAP_LAYER_COLORS.trips.default,
      width: 4,
    },
    selected: {
      color: MAP_LAYER_COLORS.trips.selected,
      width: 6,
    },
    recent: {
      color: MAP_LAYER_COLORS.trips.recent.light,
      width: 4,
    },
    matched: {
      color: MAP_LAYER_COLORS.matchedTrips.default,
      width: 4,
    },
  },
};

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
  getClusterColor,
  getTripStyle,
};

export { MAP_LAYER_COLORS, MAP_LAYER_STYLES, getClusterColor, getTripStyle };
export { MapStyles };
export default MapStyles;
