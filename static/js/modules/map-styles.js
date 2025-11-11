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
      default: "#331107",
      selected: "#FFD700",
      recent: {
        light: "#FFEFC1",
        dark: "#FFB703",
      },
    },
    matchedTrips: {
      default: "#CF6679",
      highlight: "#40E0D0",
    },
    streets: {
      undriven: "#00BFFF",
      driven: getCSSVariable("--success"),
      all: getCSSVariable("--primary-light"),
    },
    routes: {
      calculated: "#76ff03",
      target: "#ffab00",
    },
    clusters: [
      getCSSVariable("--primary"),
      getCSSVariable("--secondary"),
      "#3f8cff",
      "#ff5470",
      "#faae2b",
      getCSSVariable("--primary-light"),
      "#22c55e",
      "#d946ef",
      getCSSVariable("--secondary-light"),
      "#7dd3fc",
    ],
    liveTracking: {
      slow: "#10b981",
      medium: "#2196f3",
      fast: getCSSVariable("--primary-dark"),
    },
    customPlaces: {
      fill: getCSSVariable("--primary-light"),
      outline: getCSSVariable("--primary-light"),
      highlight: "#F59E0B",
    },
  };

  const MAP_LAYER_STYLES = {
    trip: {
      default: {
        color: getCSSVariable("--primary-light"),
        weight: 3,
        opacity: 0.8,
      },
      selected: {
        color: "#FFD700",
        weight: 5,
        opacity: 1,
      },
      reset: {
        color: getCSSVariable("--primary-light"),
        weight: 3,
        opacity: 0.6,
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
