/**
 * Map Styles Configuration
 * Centralized color and style definitions for map layers and UI elements
 * Uses CSS variables for theme consistency
 */

((window) => {
  function getCSSVariable(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

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
      calculated: "#6b9d8a",
      target: "#d4a574",
    },
    clusters: [
      getCSSVariable("--primary"),
      getCSSVariable("--secondary"),
      getCSSVariable("--info"),
      getCSSVariable("--danger"),
      getCSSVariable("--warning"),
      getCSSVariable("--primary-light"),
      getCSSVariable("--success"),
      getCSSVariable("--info-light"),
      getCSSVariable("--secondary-light"),
      getCSSVariable("--success-light"),
    ],
    liveTracking: {
      slow: getCSSVariable("--success"),
      medium: getCSSVariable("--info"),
      fast: getCSSVariable("--primary"),
    },
    customPlaces: {
      fill: getCSSVariable("--primary-light"),
      outline: getCSSVariable("--primary"),
      highlight: getCSSVariable("--warning"),
    },
  };

  const MAP_LAYER_STYLES = {
    trip: {
      default: {
        color: getCSSVariable("--primary"),
        weight: 2.5,
        opacity: 0.7,
      },
      selected: {
        color: getCSSVariable("--warning"),
        weight: 4,
        opacity: 0.9,
      },
      reset: {
        color: getCSSVariable("--primary-light"),
        weight: 2.5,
        opacity: 0.5,
      },
    },
  };

  function getClusterColor(index) {
    return MAP_LAYER_COLORS.clusters[index % MAP_LAYER_COLORS.clusters.length];
  }

  function getTripStyle(state = "default") {
    return MAP_LAYER_STYLES.trip[state];
  }

  window.MapStyles = {
    MAP_LAYER_COLORS,
    MAP_LAYER_STYLES,
    getClusterColor,
    getTripStyle,
  };
})(window);
