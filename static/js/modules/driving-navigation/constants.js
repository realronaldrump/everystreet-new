/**
 * Constants and configuration defaults for the Driving Navigation module.
 */

export const DRIVING_NAV_DEFAULTS = {
  areaSelectId: "area-select",
  mapContainerId: "driving-map",
  populateAreaSelect: true,
  sharedMap: null,
  loadCoverageAreas: true,
};

/**
 * Default cluster colors for efficient street clusters.
 * Used when MapStyles module is not yet loaded.
 */
export const DEFAULT_CLUSTER_COLORS = [
  "#5f82a0",
  "#857d6e",
  "#7893a6",
  "#b5523f",
  "#c49d4c",
  "#93acbf",
  "#b5824a",
  "#8b6f8a",
  "#c26a4a",
  "#5e6789",
];

/**
 * Default street colors with defaults.
 */
export const DEFAULT_STREET_COLORS = {
  undriven: "#d27b58",
  driven: "#8fb1c8",
};

/**
 * Default route colors with defaults.
 */
export const DEFAULT_ROUTE_COLORS = {
  calculated: "#8fb1c8",
  target: "#dcb35a",
};

/**
 * Location source labels for display.
 */
export const LOCATION_SOURCE_LABELS = {
  "client-provided": "your device",
  "live-tracking": "live tracking",
  "last-trip-end": "last trip",
  "last-trip-end-multi": "last trip",
  "last-trip-end-point": "last trip",
};

/**
 * Processing step definitions for progress UI.
 */
export const PROCESSING_STEPS = {
  clustering: {
    progress: 15,
    text: "Grouping segments...",
  },
  optimizing: {
    progress: 45,
    text: "Optimizing routes...",
  },
  rendering: {
    progress: 85,
    text: "Rendering route...",
  },
};
