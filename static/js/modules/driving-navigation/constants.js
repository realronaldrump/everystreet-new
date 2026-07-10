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
  "#6f8fce",
  "#727a84",
  "#6290ad",
  "#c45454",
  "#d4a24a",
  "#72a6c4",
  "#c49050",
  "#8a7ab0",
  "#c47050",
  "#6a72a0",
];

/**
 * Default street colors with defaults.
 */
export const DEFAULT_STREET_COLORS = {
  undriven: "#c47050",
  driven: "#6f8fce",
};

/**
 * Default route colors with defaults.
 */
export const DEFAULT_ROUTE_COLORS = {
  calculated: "#6f8fce",
  target: "#d4a24a",
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
