/**
 * Unified Formatters Module
 * Consolidated formatting utilities for dates, times, durations, distances, etc.
 *
 * This module centralizes all formatting logic that was previously duplicated
 * across multiple files (utils.js, date-utils.js, insights/formatters.js,
 * coverage/coverage-utils.js, task-manager/formatters.js, etc.)
 *
 * @module formatters
 */

/* global dayjs */

// ============================================================================
// XSS Prevention
// ============================================================================

/**
 * Escape HTML special characters to prevent XSS attacks
 * @param {string} str - String to escape
 * @returns {string} Escaped string safe for HTML insertion
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  const input = typeof str === "string" ? str : String(str);
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
    "`": "&#x60;",
    "=": "&#x3D;",
  };
  return input.replace(/[&<>"'`=/]/g, (char) => map[char]);
}

// ============================================================================
// Number Formatting
// ============================================================================

/**
 * Format a number with locale-aware separators and fixed decimals
 * @param {number} num - Number to format
 * @param {number} decimals - Decimal places (default 0)
 * @returns {string} Formatted number or "--" if invalid
 */
export function formatNumber(num, decimals = 0) {
  if (num === null || num === undefined || Number.isNaN(num)) return "--";
  return Number(num).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a percentage value
 * @param {number} value - Value between 0-100
 * @param {number} decimals - Decimal places (default 1)
 * @returns {string} Formatted percentage string
 */
export function formatPercentage(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return `${Number(value).toFixed(decimals)}%`;
}

// ============================================================================
// Distance Formatting
// ============================================================================

/**
 * Format distance in miles with unit suffix
 * @param {number} miles - Distance in miles
 * @returns {string} Formatted distance or "--" if invalid
 */
export function formatDistance(miles) {
  if (miles === null || miles === undefined) return "--";
  return `${parseFloat(miles).toFixed(1)} mi`;
}

/**
 * Convert meters to user-friendly distance units (miles or feet)
 * @param {number} meters - Distance in meters
 * @param {number} fixed - Decimal places for miles (default 2)
 * @returns {string} Formatted distance (e.g., "1.5 mi" or "500 ft")
 */
export function distanceInUserUnits(meters, fixed = 2) {
  const safeMeters =
    typeof meters === "number" && !Number.isNaN(meters) ? meters : 0;
  const miles = safeMeters * 0.000621371;
  return miles < 0.1
    ? `${(safeMeters * 3.28084).toFixed(0)} ft`
    : `${miles.toFixed(fixed)} mi`;
}

/**
 * Format distance from kilometers to miles
 * @param {number} km - Distance in kilometers
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted distance in miles
 */
export function formatKmToMiles(km, decimals = 1) {
  if (km === null || km === undefined) return "--";
  const miles = km * 0.621371;
  return `${miles.toFixed(decimals)} mi`;
}

// ============================================================================
// Duration Formatting
// ============================================================================

/**
 * Format duration from seconds to human-readable string
 * Handles various output formats based on duration length
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (e.g., "2h 30m", "45m 30s", "30s")
 */
export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Format duration from milliseconds
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
export function formatDurationMs(ms) {
  return formatDuration(Math.floor(ms / 1000));
}

/**
 * Format seconds to HH:MM:SS format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Time in HH:MM:SS format
 */
export function formatSecondsToHMS(seconds) {
  if (typeof seconds !== "number" || Number.isNaN(seconds)) return "00:00:00";
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  // For durations over 24 hours, use day notation
  if (h >= 24) {
    return formatDuration(seconds);
  }

  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Format time from decimal hours to AM/PM format
 * @param {number} hours - Decimal hours (e.g., 14.5 for 2:30 PM)
 * @returns {string} Formatted time string
 */
export function formatTimeFromHours(hours) {
  if (hours === null || hours === undefined) return "--:--";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  const amPm = h < 12 ? "AM" : "PM";
  return `${displayHour}:${m.toString().padStart(2, "0")} ${amPm}`;
}

/**
 * Format hour number to 12-hour format with AM/PM
 * @param {number} hour - Hour in 24-hour format (0-23)
 * @returns {string} Formatted hour (e.g., "2 PM")
 */
export function formatHourLabel(hour) {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

/**
 * Convert duration string to seconds
 * Parses strings like "2d 3h 45m 30s"
 * @param {string} duration - Duration string
 * @returns {number} Duration in seconds
 */
export function parseDurationToSeconds(duration = "") {
  if (!duration || duration === "N/A" || duration === "Unknown") return 0;

  let seconds = 0;
  const dayMatch = duration.match(/(\d+)\s*d/);
  const hourMatch = duration.match(/(\d+)\s*h/);
  const minuteMatch = duration.match(/(\d+)\s*m/);
  const secondMatch = duration.match(/(\d+)\s*s/);

  if (dayMatch) seconds += parseInt(dayMatch[1], 10) * 86400;
  if (hourMatch) seconds += parseInt(hourMatch[1], 10) * 3600;
  if (minuteMatch) seconds += parseInt(minuteMatch[1], 10) * 60;
  if (secondMatch) seconds += parseInt(secondMatch[1], 10);

  return seconds;
}

// ============================================================================
// Date/Time Formatting
// ============================================================================

/**
 * Format an ISO date/time string for display
 * @param {string|Date} isoString - ISO date string or Date object
 * @returns {string} Locale-formatted date/time or "--" if invalid
 */
export function formatDateTime(isoString) {
  if (!isoString) return "--";
  return new Date(isoString).toLocaleString("en-US", { hour12: true });
}

/**
 * Format a Date object to YYYY-MM-DD string
 * @param {Date|string} date - Date to format
 * @returns {string|null} Formatted date string or null if invalid
 */
export function formatDateToString(date) {
  if (!date) return null;
  const d = typeof dayjs !== "undefined" ? dayjs(date) : null;
  if (d?.isValid()) return d.format("YYYY-MM-DD");

  // Fallback without dayjs
  const dateObj = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dateObj.getTime())) return null;
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a date for display using Intl.DateTimeFormat
 * @param {string|Date} dateString - Date to format
 * @param {Object} options - Intl.DateTimeFormat options
 * @returns {string} Formatted date string
 */
export function formatForDisplay(
  dateString,
  options = { dateStyle: "medium" },
) {
  const d = typeof dayjs !== "undefined" ? dayjs(dateString) : null;
  if (!d || !d.isValid()) return dateString || "";

  const formatterOptions = { ...options };
  return new Intl.DateTimeFormat("en-US", formatterOptions).format(d.toDate());
}

/**
 * Format week range from ISO week string
 * Convert "2024-W10" to "Mar 4-10, 2024"
 * @param {string} weekStr - ISO week string
 * @returns {string} Formatted week range
 */
export function formatWeekRange(weekStr) {
  if (!weekStr) return "N/A";

  const [year, week] = weekStr.split("-W");
  const simple = new Date(
    parseInt(year, 10),
    0,
    1 + (parseInt(week, 10) - 1) * 7,
  );
  const dow = simple.getDay();
  const ISOweekStart = simple;
  if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
  else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());

  const ISOweekEnd = new Date(ISOweekStart);
  ISOweekEnd.setDate(ISOweekEnd.getDate() + 6);

  const options = { month: "short", day: "numeric" };
  return `${ISOweekStart.toLocaleDateString("en-US", options)}-${ISOweekEnd.getDate()}, ${year}`;
}

/**
 * Format month string to readable format
 * Convert "2024-03" to "March 2024"
 * @param {string} monthStr - Month string in YYYY-MM format
 * @returns {string} Formatted month string
 */
export function formatMonth(monthStr) {
  if (!monthStr) return "N/A";

  const [year, month] = monthStr.split("-");
  const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1);
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ============================================================================
// Relative Time Formatting
// ============================================================================

/**
 * Format relative time from a date (e.g., "2 hours ago")
 * @param {string|Date} dateInput - Date to format
 * @param {boolean} abbreviated - Use abbreviated format (2h ago vs 2 hours ago)
 * @returns {string} Relative time string
 */
export function formatTimeAgo(dateInput, abbreviated = false) {
  if (!dateInput) return "Never";

  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return "Never";

  const now = new Date();
  const diffMs = now - date;
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 5) return "just now";

  if (abbreviated) {
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Full format
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
 * Alias for formatTimeAgo for backward compatibility
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted relative time
 */
export function formatRelativeTime(dateString) {
  return formatTimeAgo(dateString, false);
}

// ============================================================================
// Vehicle/Location Formatting
// ============================================================================

/**
 * Format vehicle name from vehicle object
 * @param {Object} vehicle - Vehicle object with name/make/model/vin/imei
 * @returns {string} Formatted vehicle name
 */
export function formatVehicleName(vehicle) {
  if (!vehicle) return "Unknown";
  if (vehicle.custom_name) return vehicle.custom_name;
  if (vehicle.year || vehicle.make || vehicle.model) {
    return `${vehicle.year || ""} ${vehicle.make || ""} ${vehicle.model || ""}`.trim();
  }
  return vehicle.vin ? `VIN: ${vehicle.vin}` : `IMEI: ${vehicle.imei}`;
}

/**
 * Sanitize and format a location for display
 * @param {string|Object} location - Location string or object
 * @returns {string} Sanitized location string
 */
export function sanitizeLocation(location) {
  if (!location) return "Unknown";
  if (typeof location === "string") return location;
  if (typeof location === "object") {
    return (
      location.formatted_address ||
      location.name ||
      [location.street, location.city, location.state]
        .filter(Boolean)
        .join(", ") ||
      "Unknown"
    );
  }
  return "Unknown";
}

/**
 * Format street type for display
 * Convert "residential_street" to "Residential Street"
 * @param {string} type - Street type
 * @returns {string} Formatted street type
 */
export function formatStreetType(type) {
  if (!type) return "Unknown";
  return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

// ============================================================================
// Speed Formatting
// ============================================================================

/**
 * Format vehicle speed with status indicator
 * @param {number|string} speed - Speed value
 * @returns {Object} Object with value, status, formatted string, and CSS class
 */
export function formatVehicleSpeed(speed) {
  const validSpeed = typeof speed === "number" ? speed : parseFloat(speed) || 0;

  let status = "stopped";
  if (validSpeed > 35) status = "fast";
  else if (validSpeed > 10) status = "medium";
  else if (validSpeed > 0) status = "slow";

  return {
    value: validSpeed.toFixed(1),
    status,
    formatted: `${validSpeed.toFixed(1)} mph`,
    cssClass: `vehicle-${status}`,
  };
}

// ============================================================================
// Default Export (all formatters as object)
// ============================================================================

const formatters = {
  // XSS Prevention
  escapeHtml,

  // Numbers
  formatNumber,
  formatPercentage,

  // Distance
  formatDistance,
  distanceInUserUnits,
  formatKmToMiles,

  // Duration
  formatDuration,
  formatDurationMs,
  formatSecondsToHMS,
  formatTimeFromHours,
  formatHourLabel,
  parseDurationToSeconds,

  // Date/Time
  formatDateTime,
  formatDateToString,
  formatForDisplay,
  formatWeekRange,
  formatMonth,

  // Relative Time
  formatTimeAgo,
  formatRelativeTime,

  // Vehicle/Location
  formatVehicleName,
  sanitizeLocation,
  formatStreetType,

  // Speed
  formatVehicleSpeed,
};

export default formatters;
