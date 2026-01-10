/**
 * Coverage Utilities
 * Shared utility functions for coverage-specific operations
 *
 * Common formatters are now imported from the central formatters module.
 */
import {
  distanceInUserUnits,
  formatRelativeTime,
  formatStreetType,
} from "../formatters.js";

// Re-export formatters for backward compatibility
export { formatRelativeTime, distanceInUserUnits, formatStreetType };

/**
 * Compute a simple hash of areas data to detect changes
 * @param {Array} areas - Array of coverage area objects
 * @returns {string} Hash string for comparison
 */
export function computeAreasHash(areas) {
  return areas
    .map((a) => `${a._id}:${a.status}:${a.coverage_percentage}:${a.last_updated}`)
    .join("|");
}

/**
 * Create a context object with necessary formatters for coverage UI/Dashboards
 * @returns {Object} Object containing distanceFormatter, timeFormatter, etc.
 */
export function createFormatterContext() {
  return {
    distanceFormatter: distanceInUserUnits,
    timeFormatter: formatRelativeTime,
    streetTypeFormatter: formatStreetType,
  };
}
