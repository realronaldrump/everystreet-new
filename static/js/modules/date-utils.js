/**
 * Consolidated Date Utilities Module
 *
 * Provides timezone-safe date handling, formatting, and parsing utilities.
 * All date-related operations should use these functions to ensure consistency.
 *
 * Key Principles:
 * - Use YYYY-MM-DD format for storage and date-only values
 * - Use ISO strings for API communication with timestamps
 * - Parse dates using local timezone to avoid midnight shift issues
 * - Provide consistent formatting across the application
 *
 * @module date-utils
 */

import { CONFIG } from "./config.js";
import utils from "./utils.js";

const dateUtils = {
  /**
   * Standard date format used throughout the application
   */
  DEFAULT_FORMAT: "YYYY-MM-DD",

  /**
   * User's timezone
   */
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

  /**
   * Parse a date string (YYYY-MM-DD) into local midnight Date object.
   * This avoids timezone issues by explicitly setting to local midnight.
   *
   * @param {string} dateStr - Date string in YYYY-MM-DD format
   * @returns {Date|null} Date object set to local midnight, or null if invalid
   *
   * @example
   * parseDateString("2024-03-15") // Returns Date object for March 15, 2024 at 00:00:00 local time
   */
  parseDateString(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = dateStr.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  },

  /**
   * Format a Date object to YYYY-MM-DD string in local timezone.
   *
   * @param {Date} date - Date object to format
   * @returns {string|null} Formatted date string or null if invalid
   *
   * @example
   * formatDateToString(new Date(2024, 2, 15)) // Returns "2024-03-15"
   */
  formatDateToString(date) {
    if (!date || !(date instanceof Date) || Number.isNaN(date.getTime()))
      return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },

  /**
   * Parse various date formats into a Date object.
   * Handles YYYY-MM-DD strings, ISO strings, timestamps, and Date objects.
   *
   * @param {string|Date|number} dateValue - Date value to parse
   * @param {boolean} endOfDay - If true, set time to 23:59:59.999
   * @returns {Date|null} Parsed Date object or null if invalid
   *
   * @example
   * parseDate("2024-03-15") // Returns Date at 00:00:00 local time
   * parseDate("2024-03-15", true) // Returns Date at 23:59:59.999 local time
   * parseDate("2024-03-15T10:30:00Z") // Returns Date from ISO string
   */
  parseDate(dateValue, endOfDay = false) {
    if (!dateValue) return null;
    if (dateValue instanceof Date) return new Date(dateValue);

    // Try parsing as YYYY-MM-DD string first (timezone-safe)
    if (
      typeof dateValue === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateValue)
    ) {
      const parsed = this.parseDateString(dateValue);
      if (parsed && endOfDay) parsed.setHours(23, 59, 59, 999);
      return parsed;
    }

    try {
      const date = new Date(dateValue);
      if (Number.isNaN(date.getTime())) {
        console.warn(`Invalid date value: ${dateValue}`);
        return null;
      }

      if (endOfDay) date.setHours(23, 59, 59, 999);
      return date;
    } catch (error) {
      console.warn("Error parsing date:", error);
      return null;
    }
  },

  /**
   * Format a date value to a specific format.
   *
   * @param {Date|string|number} date - Date to format
   * @param {string} format - Format string (default: YYYY-MM-DD)
   * @returns {string|null} Formatted date string or null if invalid
   *
   * @example
   * formatDate(new Date(), "YYYY-MM-DD") // Returns "2024-03-15"
   * formatDate("2024-03-15") // Returns "2024-03-15"
   */
  formatDate(date, format = this.DEFAULT_FORMAT) {
    if (!date) return null;

    if (format === this.DEFAULT_FORMAT) {
      // Use timezone-safe formatting for YYYY-MM-DD
      if (date instanceof Date) {
        return this.formatDateToString(date);
      }
      // If it's already a string in correct format, return as-is
      if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return date;
      }
    }

    const parsedDate = this.parseDate(date);
    if (!parsedDate) return null;

    return format === this.DEFAULT_FORMAT
      ? this.formatDateToString(parsedDate)
      : parsedDate.toISOString();
  },

  /**
   * Get current date as YYYY-MM-DD string.
   *
   * @returns {string} Current date in YYYY-MM-DD format
   *
   * @example
   * getCurrentDate() // Returns "2024-03-15"
   */
  getCurrentDate() {
    return this.formatDateToString(new Date());
  },

  /**
   * Get yesterday's date as YYYY-MM-DD string.
   *
   * @returns {string} Yesterday's date in YYYY-MM-DD format
   */
  getYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.formatDateToString(yesterday);
  },

  /**
   * Get start date from storage or current date.
   *
   * @returns {string} Start date in YYYY-MM-DD format
   */
  getStartDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || this.getCurrentDate()
    );
  },

  /**
   * Get end date from storage or current date.
   *
   * @returns {string} End date in YYYY-MM-DD format
   */
  getEndDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || this.getCurrentDate()
    );
  },

  /**
   * Get a date range based on a preset.
   *
   * @param {string} range - Preset name (today, yesterday, last-week, last-month, last-quarter, last-year, all-time)
   * @returns {Promise<{startDate: string, endDate: string}>} Date range object
   *
   * @example
   * await getDateRangePreset("last-week") // Returns { startDate: "2024-03-08", endDate: "2024-03-15" }
   */
  async getDateRangePreset(range) {
    const today = new Date();
    let startDate, endDate;

    switch (range) {
      case "today":
        startDate = new Date(today);
        endDate = new Date(today);
        break;
      case "yesterday":
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 1);
        endDate = new Date(startDate);
        break;
      case "7days":
      case "last-week":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 6);
        break;
      case "30days":
      case "last-month":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 29);
        break;
      case "90days":
      case "last-quarter":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 89);
        break;
      case "180days":
      case "last-6-months":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setMonth(startDate.getMonth() - 6);
        break;
      case "365days":
      case "last-year":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      case "all-time":
        try {
          const res = await fetch("/api/first_trip_date");
          if (res.ok) {
            const data = await res.json();
            if (data.first_trip_date) {
              // API returns ISO datetime (e.g., "2024-01-15T12:30:45Z")
              // Extract just the date part (YYYY-MM-DD) for parseDateString
              const dateOnly = data.first_trip_date.split("T")[0];
              startDate = this.parseDateString(dateOnly);
            }
          } else {
            console.warn(`API error fetching first trip date: ${res.status}`);
          }
        } catch (error) {
          console.warn("Error fetching first trip date:", error);
        }
        if (!startDate) {
          // Fallback to 1 year ago if we can't fetch the first trip date
          console.warn(
            "Could not determine first trip date, using 1 year ago as fallback",
          );
          startDate = new Date(today);
          startDate.setFullYear(startDate.getFullYear() - 1);
        }
        endDate = new Date(today);
        break;
      default:
        console.warn(`Unknown date range preset: ${range}`);
        return {};
    }

    return {
      startDate: this.formatDateToString(startDate),
      endDate: this.formatDateToString(endDate),
    };
  },

  /**
   * Format a date for display using Intl.DateTimeFormat.
   *
   * @param {Date|string} dateString - Date to format
   * @param {Object} options - Intl.DateTimeFormat options
   * @returns {string} Formatted date string
   *
   * @example
   * formatForDisplay("2024-03-15", { dateStyle: "medium" }) // Returns "Mar 15, 2024"
   * formatForDisplay("2024-03-15T10:30:00Z", { dateStyle: "medium", timeStyle: "short" }) // Returns "Mar 15, 2024, 10:30 AM"
   */
  formatForDisplay(dateString, options = { dateStyle: "medium" }) {
    const date = this.parseDate(dateString);
    if (!date) return dateString || "";

    const formatterOptions = {};

    if (options.dateStyle !== null) {
      formatterOptions.dateStyle = options.dateStyle || "medium";
    }

    if (options.timeStyle !== null && options.timeStyle !== undefined) {
      formatterOptions.timeStyle = options.timeStyle;
    }

    // Include additional options
    Object.entries(options).forEach(([key, value]) => {
      if (
        value !== null &&
        value !== undefined &&
        !["dateStyle", "timeStyle"].includes(key)
      ) {
        formatterOptions[key] = value;
      }
    });

    return new Intl.DateTimeFormat("en-US", formatterOptions).format(date);
  },

  /**
   * Format duration from hours to human-readable string.
   *
   * @param {number} hours - Duration in hours
   * @returns {string} Formatted duration (e.g., "2h 30m")
   */
  formatTimeFromHours(hours) {
    if (hours === null || typeof hours === "undefined") return "0h 0m";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${m}m`;
  },

  /**
   * Format duration from seconds to H:MM:SS format.
   *
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted duration (e.g., "2:30:45")
   */
  formatSecondsToHMS(seconds) {
    if (typeof seconds !== "number" || Number.isNaN(seconds)) return "00:00:00";

    const validSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(validSeconds / 3600);
    const minutes = Math.floor((validSeconds % 3600) / 60);
    const remainingSeconds = validSeconds % 60;

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  },

  /**
   * Format duration from milliseconds or seconds to human-readable string.
   *
   * @param {number} durationMsOrSec - Duration in milliseconds or seconds
   * @returns {string} Formatted duration (e.g., "2h 30m 45s")
   */
  formatDuration(durationMsOrSec = 0) {
    if (!durationMsOrSec || Number.isNaN(durationMsOrSec)) return "N/A";

    // Auto-detect if value is in milliseconds (> 1000000 likely means ms)
    let totalSeconds = durationMsOrSec;
    if (durationMsOrSec > 1000000) {
      totalSeconds = Math.floor(durationMsOrSec / 1000);
    }

    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(" ");
  },

  /**
   * Calculate duration between two dates and format as H:MM:SS.
   *
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date (defaults to now)
   * @returns {string} Formatted duration
   */
  formatDurationHMS(startDate, endDate = new Date()) {
    const start = this.parseDate(startDate);
    if (!start) return "00:00:00";

    const diffMs = Math.max(0, this.parseDate(endDate) - start);
    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  },

  /**
   * Convert duration string to seconds.
   *
   * @param {string} duration - Duration string (e.g., "2h 30m 45s" or "2d 5h 30m")
   * @returns {number} Duration in seconds
   */
  convertDurationToSeconds(duration = "") {
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
  },

  /**
   * Format relative time (e.g., "2 hours ago").
   *
   * @param {Date|string} timestamp - Timestamp to format
   * @param {boolean} abbreviated - If true, use abbreviated format (e.g., "2h ago")
   * @returns {string} Formatted relative time
   */
  formatTimeAgo(timestamp, abbreviated = false) {
    const date = this.parseDate(timestamp);
    if (!date) return "";

    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 5) return "just now";
    if (seconds < 60) {
      return abbreviated
        ? `${seconds}s ago`
        : `${seconds} second${seconds !== 1 ? "s" : ""} ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return abbreviated
        ? `${minutes}m ago`
        : `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return abbreviated
        ? `${hours}h ago`
        : `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    }

    const days = Math.floor(hours / 24);
    if (days < 7 || !abbreviated) {
      return abbreviated
        ? `${days}d ago`
        : `${days} day${days !== 1 ? "s" : ""} ago`;
    }

    return this.formatForDisplay(date, { dateStyle: "short" });
  },

  /**
   * Format relative time with "Never" fallback.
   *
   * @param {string|null} dateString - Date string to format
   * @returns {string} Formatted relative time or "Never"
   */
  formatRelativeTime(dateString) {
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
  },

  /**
   * Validate a date range.
   *
   * @param {string|Date} start - Start date
   * @param {string|Date} end - End date
   * @returns {boolean} True if valid range (start <= end)
   */
  isValidDateRange(start, end) {
    if (!start || !end) return false;
    // String comparison works for YYYY-MM-DD format
    if (typeof start === "string" && typeof end === "string") {
      return start <= end;
    }
    const startDate = this.parseDate(start);
    const endDate = this.parseDate(end);
    return startDate && endDate && startDate <= endDate;
  },

  /**
   * Check if a date is within a range.
   *
   * @param {Date|string} date - Date to check
   * @param {Date|string} startDate - Range start
   * @param {Date|string} endDate - Range end
   * @returns {boolean} True if date is within range
   */
  isDateInRange(date, startDate, endDate) {
    const dateObj = this.parseDate(date);
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate, true);

    return dateObj && start && end && dateObj >= start && dateObj <= end;
  },

  /**
   * Get duration between two dates as human-readable string.
   *
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @returns {string} Formatted duration
   */
  getDuration(startDate, endDate) {
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);
    if (!start || !end) return "Unknown";

    const diffMs = Math.abs(end - start);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays} day${diffDays !== 1 ? "s" : ""}`;
    if (diffHours > 0) return `${diffHours} hour${diffHours !== 1 ? "s" : ""}`;
    if (diffMin > 0) return `${diffMin} minute${diffMin !== 1 ? "s" : ""}`;
    return `${diffSec} second${diffSec !== 1 ? "s" : ""}`;
  },

  /**
   * Get cached date range from storage.
   *
   * @returns {Object} Cached date range with calculated days
   */
  getCachedDateRange() {
    const cacheKey = "cached_date_range";
    const cached = utils.getStorage(cacheKey);
    const currentStart = this.getStartDate();
    const currentEnd = this.getEndDate();

    if (cached && cached.start === currentStart && cached.end === currentEnd) {
      return {
        ...cached,
        startDate: this.parseDateString(cached.start),
        endDate: this.parseDateString(cached.end),
      };
    }

    const startDate = this.parseDateString(currentStart);
    const endDate = this.parseDateString(currentEnd);
    const range = {
      start: currentStart,
      end: currentEnd,
      startDate,
      endDate,
      days:
        startDate && endDate
          ? Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1
          : 0,
    };

    utils.setStorage(cacheKey, range);
    return range;
  },

  /**
   * Convert week key (YYYY-Www) to date range string.
   *
   * @param {string} weekKey - Week key in ISO week format
   * @returns {string} Formatted date range
   */
  weekKeyToDateRange(weekKey) {
    const match = weekKey.match(/(\d{4})-W(\d{2})/);
    if (!match) return weekKey;
    const year = parseInt(match[1], 10);
    const week = parseInt(match[2], 10);

    // Get Monday of the week
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const monday = new Date(simple);
    if (dow <= 4) {
      // Mon-Thu: go back to Monday
      monday.setDate(simple.getDate() - simple.getDay() + 1);
    } else {
      // Fri-Sun: go forward to next Monday
      monday.setDate(simple.getDate() + 8 - simple.getDay());
    }
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return `${this.formatDateToString(monday)} to ${this.formatDateToString(sunday)}`;
  },

  /**
   * Format distance in user units (miles/feet).
   *
   * @param {number} meters - Distance in meters
   * @param {number} fixed - Decimal places for miles
   * @returns {string} Formatted distance
   */
  distanceInUserUnits(meters, fixed = 2) {
    let validMeters = meters;
    if (typeof meters !== "number" || Number.isNaN(meters)) {
      validMeters = 0;
    }
    const miles = validMeters * 0.000621371;
    return miles < 0.1
      ? `${(validMeters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  },

  /**
   * Format vehicle speed with status.
   *
   * @param {number|string} speed - Speed in mph
   * @returns {Object} Speed information with formatting
   */
  formatVehicleSpeed(speed) {
    let validSpeed = speed;
    if (typeof speed !== "number") {
      validSpeed = parseFloat(speed) || 0;
    }

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
  },

  /**
   * Initialize a Flatpickr date picker.
   *
   * @param {string|HTMLElement} element - Element selector or DOM element
   * @param {Object} config - Flatpickr configuration
   * @returns {Object|null} Flatpickr instance or null if unavailable
   */
  initDatePicker(element, config) {
    if (window.flatpickr) {
      return window.flatpickr(element, config);
    }
    return null;
  },
};

export default dateUtils;
