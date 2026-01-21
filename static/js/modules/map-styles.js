/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

const getCSSVariable = (varName) =>
  getComputedStyle(document.documentElement).getPropertyValue(varName).trim();

const MAP_LAYER_COLORS = {
  trips: {
    default: "#5f7d78",
    selected: "#d4a574",
    recent: {
      light: "#e3c09a",
      dark: "#d4a574",
    },
  },
  matchedTrips: {
    default: "#d48584",
    highlight: "#7c9d96",
  },
  streets: {
    undriven: "#8b9dc3",
    driven: getCSSVariable("--success"),
    all: getCSSVariable("--primary-light"),
  },
  routes: {
    default: "#f97316",
    active: "#60a5fa",
    completed: "#22c55e",
  },
  clusters: {
    small: "#f1c40f",
    medium: "#e67e22",
    large: "#e74c3c",
  },
  coverage: {
    driven: "#1d9bf0",
    undriven: "#cbd5f5",
    undriveable: "#7c7c7c",
  },
  customPlaces: {
    fill: "#22c55e",
    outline: "#15803d",
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
