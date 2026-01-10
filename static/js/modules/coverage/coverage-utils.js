/**
 * Coverage Utilities
 * Shared utility functions for formatting and data manipulation
 */

/**
 * Format relative time from a date string
 * @param {string} dateString - ISO date string to format
 * @returns {string} Formatted relative time (e.g., "2 hours ago", "Just now")
 */
export function formatRelativeTime(dateString) {
  if (!dateString) return "Never";

  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString();
  } else if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""} ago`;
  } else if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  } else if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  }
  return "Just now";
}

/**
 * Convert meters to user-friendly distance units
 * @param {number} meters - Distance in meters
 * @param {number} fixed - Decimal places for formatting
 * @returns {string} Formatted distance string (e.g., "1.5 mi", "500 ft")
 */
export function distanceInUserUnits(meters, fixed = 2) {
  let safeMeters = meters;
  if (typeof safeMeters !== "number" || Number.isNaN(safeMeters)) {
    safeMeters = 0;
  }
  const miles = safeMeters * 0.000621371;
  return miles < 0.1
    ? `${(safeMeters * 3.28084).toFixed(0)} ft`
    : `${miles.toFixed(fixed)} mi`;
}

/**
 * Format street type for display
 * @param {string} type - Street type (e.g., "residential_street")
 * @returns {string} Formatted street type (e.g., "Residential Street")
 */
export function formatStreetType(type) {
  if (!type) return "Unknown";
  return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Compute a simple hash of areas data to detect changes
 * @param {Array} areas - Array of coverage area objects
 * @returns {string} Hash string for comparison
 */
export function computeAreasHash(areas) {
  return areas
    .map(
      (a) => `${a._id}:${a.status}:${a.coverage_percentage}:${a.last_updated}`,
    )
    .join("|");
}

/**
 * Create formatter context object for use in dashboard operations
 * @returns {Object} Object with bound formatter functions
 */
export function createFormatterContext() {
  return {
    distanceFormatter: distanceInUserUnits,
    timeFormatter: formatRelativeTime,
    streetTypeFormatter: formatStreetType,
  };
}
