import { CONFIG } from "./config.js";
import utils from "./utils.js";

const dateUtils = {
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
    const now = new Date();
    return now.toISOString().split("T")[0];
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
        startDate: new Date(cached.start),
        endDate: new Date(cached.end),
      };
    }

    const range = {
      start: currentStart,
      end: currentEnd,
      startDate: new Date(currentStart),
      endDate: new Date(currentEnd),
      days:
        Math.ceil(
          (new Date(currentEnd) - new Date(currentStart)) /
            (1000 * 60 * 60 * 24),
        ) + 1,
    };

    utils.setStorage(cacheKey, range);
    return range;
  },

  formatForDisplay(dateString, options = { dateStyle: "medium" }) {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, options);
  },

  isValidDateRange(start, end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return startDate <= endDate;
  },

  async getDateRangePreset(range) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
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
            startDate = new Date(data.first_trip_date || "2000-01-01");
            endDate = new Date(today);
          } else {
            startDate = new Date("2000-01-01");
            endDate = new Date(today);
          }
        } catch (error) {
          void error;
          startDate = new Date("2000-01-01");
          endDate = new Date(today);
        }
        break;
      default:
        return {};
    }

    return {
      startDate: startDate.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
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
