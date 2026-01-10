/**
 * Constants and configuration defaults for the Driving Navigation module.
 */

export const DRIVING_NAV_DEFAULTS = {
  areaSelectId: "area-select",
  mapContainerId: "driving-map",
  populateAreaSelect: true,
  useSharedMap: false,
};

/**
 * Default cluster colors for efficient street clusters.
 * Used when MapStyles module is not yet loaded.
 */
export const DEFAULT_CLUSTER_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#3b82f6",
  "#ef4444",
  "#f59e0b",
  "#a78bfa",
  "#10b981",
  "#06b6d4",
  "#d946ef",
  "#84cc16",
];

/**
 * Default street colors with fallbacks.
 */
export const DEFAULT_STREET_COLORS = {
  undriven: "#8b9dc3",
  driven: "#10b981",
};

/**
 * Default route colors with fallbacks.
 */
export const DEFAULT_ROUTE_COLORS = {
  calculated: "#3b82f6",
  target: "#d4a574",
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
