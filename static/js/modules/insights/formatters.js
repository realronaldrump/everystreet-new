/**
 * Insights Formatters Module (ES6)
 * Utility functions for formatting dates, times, durations, etc.
 *
 * Common formatters are imported from the central formatters module.
 */
import store from "../core/store.js";
import { formatDateToString, formatDuration, formatHourLabel } from "../utils.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function formatCalendarDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

// Re-export common formatters
export { formatDuration, formatHourLabel };

/**
 * Format a Date object to YYYY-MM-DD string
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  return formatDateToString(date);
}

/**
 * Get the date range from the universal filters (store state)
 * @returns {Object} Object with start and end date strings
 */
export function getDateRange() {
  const today = formatDate(new Date());
  const filters = store.get("filters") || {};
  return {
    start: filters.startDate || today,
    end: filters.endDate || today,
  };
}

/**
 * Calculate number of days in a date range
 * @param {string} startDate - Start date string
 * @param {string} endDate - End date string
 * @returns {number} Number of days in range
 */
export function calculateDaysDiff(startDate, endDate) {
  const startDateObj = parseCalendarDate(startDate);
  const endDateObj = parseCalendarDate(endDate);
  if (startDateObj && endDateObj) {
    const diffDays = Math.floor((endDateObj - startDateObj) / MS_PER_DAY) + 1;
    return Math.max(diffDays, 1);
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
  const startDateObj = parseCalendarDate(startDate);
  if (!startDateObj || !Number.isFinite(periodDays) || periodDays < 1) {
    throw new Error("Invalid date range");
  }
  const prevEndDateObj = new Date(startDateObj.getTime() - MS_PER_DAY);
  const prevStartDateObj = new Date(
    prevEndDateObj.getTime() - (periodDays - 1) * MS_PER_DAY
  );

  return {
    start: formatCalendarDate(prevStartDateObj),
    end: formatCalendarDate(prevEndDateObj),
  };
}
