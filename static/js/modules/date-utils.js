import { CONFIG } from "./config.js";
import utils from "./utils.js";

const dateUtils = {
  /**
   * Parse a date string (YYYY-MM-DD) into local midnight Date object
   * This avoids timezone issues by explicitly setting to local midnight
   */
  parseDateString(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = dateStr.split("-").map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  },

  /**
   * Format a Date object to YYYY-MM-DD string in local timezone
   */
  formatDateToString(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },

  getStartDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || this.getCurrentDate()
    );
  },

  getEndDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || this.getCurrentDate()
    );
  },

  getCurrentDate() {
    return this.formatDateToString(new Date());
  },

  getYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return this.formatDateToString(yesterday);
  },

  formatTimeFromHours(hours) {
    if (hours === null || typeof hours === "undefined") return "0h 0m";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}h ${m}m`;
  },

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

  formatForDisplay(dateString, options = { dateStyle: "medium" }) {
    const date = this.parseDateString(dateString);
    if (!date) return dateString;
    return date.toLocaleDateString(undefined, options);
  },

  isValidDateRange(start, end) {
    if (!start || !end) return false;
    return start <= end; // String comparison works for YYYY-MM-DD format
  },

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
      case "last-week":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 6);
        break;
      case "last-month":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - 29);
        break;
      case "last-quarter":
        endDate = new Date(today);
        startDate = new Date(today);
        startDate.setMonth(startDate.getMonth() - 3);
        break;
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
        return {};
    }

    return {
      startDate: this.formatDateToString(startDate),
      endDate: this.formatDateToString(endDate),
    };
  },

  initDatePicker(element, config) {
    if (window.flatpickr) {
      return window.flatpickr(element, config);
    }
    return null;
  },
};

export default dateUtils;
