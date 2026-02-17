const LIVE_TRACKING_DEFAULTS = {
  pollingInterval: 3000, // 3 seconds
  staleRecoveryThresholdMs: 12000,
  staleClearThresholdMs: 6 * 60 * 60 * 1000,
  followStorageKey: "autoFollowVehicle",
};

const LIVE_TRACKING_LAYER_IDS = {
  lineSource: "live-trip-line-source",
  markerSource: "live-trip-marker-source",
  line: "live-trip-line",
  pulse: "live-trip-pulse",
  marker: "live-trip-marker",
  arrow: "live-trip-arrow",
  arrowImage: "live-trip-arrow-icon",
};

const COVERAGE_LAYER_IDS = [
  "drivenStreets-layer",
  "undrivenStreets-layer",
  "allStreets-layer",
];

export { COVERAGE_LAYER_IDS, LIVE_TRACKING_DEFAULTS, LIVE_TRACKING_LAYER_IDS };
