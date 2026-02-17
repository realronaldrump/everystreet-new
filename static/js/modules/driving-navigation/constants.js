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
  "#3b8a7f",
  "#727a84",
  "#5a86b0",
  "#c45454",
  "#d4a24a",
  "#4d9a6a",
  "#6a9fc0",
  "#7aaa58",
  "#c49050",
  "#8a7ab0",
];

/**
 * Default street colors with defaults.
 */
export const DEFAULT_STREET_COLORS = {
  undriven: "#c47050",
  driven: "#4d9a6a",
};

/**
 * Default route colors with defaults.
 */
export const DEFAULT_ROUTE_COLORS = {
  calculated: "#3b8a7f",
  target: "#b87a4a",
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
