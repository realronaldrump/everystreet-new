/**
 * Insights Formatters Module (ES6)
 * Utility functions for formatting dates, times, durations, etc.
 *
 * Common formatters are imported from the central formatters module.
 */
import {
  formatDuration as baseDuration,
  formatDateToString,
  formatHourLabel,
  formatMonth,
  formatWeekRange,
} from "../formatters.js";
import { getStorage } from "../utils.js";

// Re-export common formatters
export { formatWeekRange, formatMonth, formatHourLabel };

/**
 * Format a Date object to YYYY-MM-DD string
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  return formatDateToString(date);
}

/**
 * Format seconds to human-readable duration
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (e.g., "2h 30m" or "45m")
 */
export function formatDuration(seconds) {
  return baseDuration(seconds);
}

/**
 * Get the date range from the universal filters (utils storage)
 * @returns {Object} Object with start and end date strings
 */
export function getDateRange() {
  const today = formatDate(new Date());
  return {
    start: getStorage("startDate", today),
    end: getStorage("endDate", today),
  };
}

/**
 * Calculate number of days in a date range
 * @param {string} startDate - Start date string
 * @param {string} endDate - End date string
 * @returns {number} Number of days in range
 */
export function calculateDaysDiff(startDate, endDate) {
  try {
    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);
    if (
      !Number.isNaN(startDateObj.getTime()) &&
      !Number.isNaN(endDateObj.getTime())
    ) {
      const diffTime = endDateObj - startDateObj;
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
      return Math.max(diffDays, 1);
    }
  } catch {
    // Ignore invalid dates
  }
  return 1;
}

/**
 * Calculate previous period date range
 * @param {string} startDate - Current period start date
 * @param {number} periodDays - Number of days in current period
 * @returns {Object} Previous period date range
 */
export function calculatePreviousRange(startDate, periodDays) {
  const prevEndDateObj = new Date(startDate);
  if (Number.isNaN(prevEndDateObj.getTime())) {
    throw new Error("Invalid date range");
  }
  prevEndDateObj.setDate(prevEndDateObj.getDate() - 1);

  const prevStartDateObj = new Date(prevEndDateObj);
  prevStartDateObj.setDate(prevStartDateObj.getDate() - (periodDays - 1));

  return {
    start: formatDate(prevStartDateObj),
    end: formatDate(prevEndDateObj),
  };
}
