/**
 * Driving Navigation Module
 *
 * This module provides real-time driving navigation to undriven streets.
 * It allows users to find the nearest undriven street or efficient clusters
 * of streets to complete their coverage goals.
 *
 * @module driving-navigation
 */

export { DrivingNavigationAPI } from "./api.js";
export {
  DEFAULT_CLUSTER_COLORS,
  DEFAULT_ROUTE_COLORS,
  DEFAULT_STREET_COLORS,
  DRIVING_NAV_DEFAULTS,
  LOCATION_SOURCE_LABELS,
  PROCESSING_STEPS,
} from "./constants.js";
export { DrivingNavigation } from "./manager.js";
export { DrivingNavigationMap } from "./map.js";
export { DrivingNavigationUI } from "./ui.js";
