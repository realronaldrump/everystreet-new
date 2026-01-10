/**
 * Insights Formatters Module
 * Utility functions for formatting dates, times, durations, etc.
 */
(() => {
  /**
   * Format a Date object to YYYY-MM-DD string
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   */
  function formatDate(date) {
    return window.DateUtils.formatDateToString(date);
  }

  /**
   * Format week range from ISO week string
   * Convert "2024-W10" to "Mar 4-10, 2024"
   * @param {string} weekStr - ISO week string
   * @returns {string} Formatted week range
   */
  function formatWeekRange(weekStr) {
    if (!weekStr) return "N/A";

    const [year, week] = weekStr.split("-W");
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
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
  function formatMonth(monthStr) {
    if (!monthStr) return "N/A";

    const [year, month] = monthStr.split("-");
    const date = new Date(year, month - 1);
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  /**
   * Format seconds to human-readable duration
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted duration (e.g., "2h 30m" or "45m")
   */
  function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  /**
   * Format hour number to 12-hour format with AM/PM
   * @param {number} hour - Hour in 24-hour format (0-23)
   * @returns {string} Formatted hour (e.g., "2 PM")
   */
  function formatHourLabel(hour) {
    if (hour === 0) return "12 AM";
    if (hour === 12) return "12 PM";
    if (hour < 12) return `${hour} AM`;
    return `${hour - 12} PM`;
  }

  /**
   * Get the date range from the universal filters (utils storage)
   * @returns {Object} Object with start and end date strings
   */
  function getDateRange() {
    const utilsObj = window.utils || {};
    const today = formatDate(new Date());
    return {
      start: utilsObj.getStorage ? utilsObj.getStorage("startDate", today) : today,
      end: utilsObj.getStorage ? utilsObj.getStorage("endDate", today) : today,
    };
  }

  /**
   * Calculate number of days in a date range
   * @param {string} startDate - Start date string
   * @param {string} endDate - End date string
   * @returns {number} Number of days in range
   */
  function calculateDaysDiff(startDate, endDate) {
    try {
      const startDateObj = window.DateUtils.parseDateString(startDate);
      const endDateObj = window.DateUtils.parseDateString(endDate);
      if (startDateObj && endDateObj) {
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
  function calculatePreviousRange(startDate, periodDays) {
    const prevEndDateObj = window.DateUtils.parseDateString(startDate);
    if (!prevEndDateObj) {
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

  // Expose to window for module access
  window.InsightsFormatters = {
    formatDate,
    formatWeekRange,
    formatMonth,
    formatDuration,
    formatHourLabel,
    getDateRange,
    calculateDaysDiff,
    calculatePreviousRange,
  };
})();
