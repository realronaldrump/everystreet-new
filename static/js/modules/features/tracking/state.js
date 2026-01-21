const LIVE_TRACKING_DEFAULTS = {
  pollingInterval: 3000, // 3 seconds
  followStorageKey: "autoFollowVehicle",
};

const LIVE_TRACKING_LAYER_IDS = {
  source: "live-trip-source",
  lineGlow: "live-trip-line-glow",
  lineCasing: "live-trip-line-casing",
  line: "live-trip-line",
  trailSource: "live-trip-trail-source",
  trail: "live-trip-trail",
  marker: "live-trip-marker",
  pulse: "live-trip-pulse",
  arrow: "live-trip-arrow",
  arrowImage: "live-trip-arrow-icon",
};

const COVERAGE_LAYER_IDS = [
  "drivenStreets-layer",
  "undrivenStreets-layer",
  "allStreets-layer",
];

export { COVERAGE_LAYER_IDS, LIVE_TRACKING_DEFAULTS, LIVE_TRACKING_LAYER_IDS };
