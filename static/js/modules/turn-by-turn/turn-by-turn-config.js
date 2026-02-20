/**
 * Turn-by-Turn Navigation Configuration
 * Constants, defaults, and lookup tables
 */

/**
 * Navigation States - manages UX flow through the navigation experience
 */
export const NAV_STATES = {
  SETUP: "setup", // Initial state, area selection
  GENERATING: "generating", // Route generation in progress (SSE)
  ROUTE_PREVIEW: "preview", // Route loaded, showing preview with ETA
  NAVIGATING_TO_START: "nav_to_start", // Guiding user to route start point
  ARRIVED_AT_START: "at_start", // User within threshold of start
  ACTIVE_NAVIGATION: "navigating", // Actively driving the route
  OFF_ROUTE: "off_route", // User off route, showing return guidance
  RESUME_AHEAD: "resume", // Offering to resume from nearest point
  ARRIVED: "arrived", // At destination
};

/**
 * Default configuration for the navigator
 */
export const TURN_BY_TURN_DEFAULTS = {
  mapContainerId: "turn-by-turn-map",
  areaSelectId: "nav-area-select",
  loadRouteBtnId: "nav-load-route-btn",
  startBtnId: "nav-start-btn",
  endBtnId: "nav-end-btn",
  overviewBtnId: "nav-overview-btn",
  recenterBtnId: "nav-recenter-btn",
  routeBtnId: "nav-route-btn",
  // Smart start detection
  startThresholdMeters: 50,
  // Off-route detection
  offRouteThresholdMeters: 60,
  // Resume ahead search radius
  resumeSearchRadiusMeters: 500,
  // Progress smoothing
  maxProgressHistoryLength: 5,
  maxReverseJumpMeters: 50,
  maxSpeedMps: 50, // ~112 mph
};

/**
 * Map style URLs
 */
export const MAP_STYLES = {
  light: "mapbox://styles/mapbox/light-v11",
  dark: "mapbox://styles/mapbox/dark-v11",
};

/**
 * Distance thresholds for various calculations
 */
export const DISTANCE_THRESHOLDS = {
  shortDistance: 160, // Used for distance formatting (feet vs miles)
  segmentMatch: 25, // How close to count as "on" a segment
  minTurnDistance: 40, // Minimum distance between maneuvers
  minTurnAngle: 28, // Minimum angle to count as a turn
};

/**
 * Turn angle thresholds for classification
 */
export const TURN_ANGLE_THRESHOLDS = {
  uturn: 150,
  sharp: 100,
  turn: 50,
  slight: 25,
};

/**
 * Speed-based zoom adjustments
 */
export const ZOOM_THRESHOLDS = {
  highway: 55, // mph
  arterial: 35,
  city: 20,
};

export const ZOOM_LEVELS = {
  highway: 14.5,
  arterial: 15.2,
  city: 15.8,
  default: 16.5,
};

/**
 * Instruction labels for turn types
 */
export const INSTRUCTION_LABELS = {
  depart: "Head out on route",
  arrive: "Arrive at destination",
  "sharp-left": "Sharp left",
  "sharp-right": "Sharp right",
  left: "Turn left",
  right: "Turn right",
  "slight-left": "Bear left",
  "slight-right": "Bear right",
  uturn: "Make a U-turn",
  straight: "Continue straight",
};

/**
 * Turn icon rotation values for each turn type
 */
export const TURN_ROTATIONS = {
  depart: 0,
  straight: 0,
  "slight-left": -45,
  "slight-right": 45,
  left: -90,
  right: 90,
  "sharp-left": -135,
  "sharp-right": 135,
  uturn: 180,
  arrive: 180,
};

/**
 * Duration label format
 */
export const DURATION_LABELS = {
  hour: "h",
  minute: "min",
};
