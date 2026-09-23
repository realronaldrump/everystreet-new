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
