import apiClient from "../core/api-client.js";
import { getStorage, setStorage } from "./data.js";
import {
  formatDateToString,
  formatForDisplay,
  formatSecondsToHMS,
  formatTimeAgo,
  formatTimeFromHours,
  parseDurationToSeconds,
} from "./formatting.js";

const { dayjs } = globalThis;
const { flatpickr } = globalThis;

const DATE_STORAGE_KEYS = {
  startDate: "startDate",
  endDate: "endDate",
};

const DateUtils = {
  parseDateString(dateStr) {
    if (!dateStr) {
      return null;
    }
    const d = dayjs(dateStr);
    return d.isValid() ? d.startOf("day").toDate() : null;
  },

  // Delegate to formatting.js canonical implementations
  formatDateToString,
  formatForDisplay,
  formatSecondsToHMS,
  formatTimeFromHours,
  formatTimeAgo,
  convertDurationToSeconds: parseDurationToSeconds,

  getCurrentDate() {
    return dayjs().format("YYYY-MM-DD");
  },

  getYesterday() {
    return dayjs().subtract(1, "day").format("YYYY-MM-DD");
  },

  getStartDate() {
    return getStorage(DATE_STORAGE_KEYS.startDate) || this.getCurrentDate();
  },

  getEndDate() {
    return getStorage(DATE_STORAGE_KEYS.endDate) || this.getCurrentDate();
  },

  async getDateRangePreset(range) {
    const today = dayjs();
    let startDate = null;
    let endDate = null;

    switch (range) {
      case "today":
        startDate = endDate = today;
        break;
      case "yesterday":
        startDate = endDate = today.subtract(1, "day");
        break;
      case "7days":
      case "last-week":
        startDate = today.subtract(6, "day");
        endDate = today;
        break;
      case "30days":
      case "last-month":
        startDate = today.subtract(29, "day");
        endDate = today;
        break;
      case "90days":
      case "last-quarter":
        startDate = today.subtract(89, "day");
        endDate = today;
        break;
      case "180days":
      case "last-6-months":
        startDate = today.subtract(6, "month");
        endDate = today;
        break;
      case "365days":
      case "last-year":
        startDate = today.subtract(1, "year");
        endDate = today;
        break;
      case "all-time":
        try {
          const data = await apiClient.get("/api/first_trip_date");
          if (data?.first_trip_date) {
            const dateOnly = data.first_trip_date.split("T")[0];
            startDate = dayjs(dateOnly);
          }
        } catch (error) {
          console.warn("Error fetching first trip date:", error);
        }
        if (!startDate || !startDate.isValid()) {
          startDate = today.subtract(1, "year");
        }
        endDate = today;
        break;
      default:
        console.warn(`Unknown date range preset: ${range}`);
        return {};
    }

    return {
      startDate: startDate.format("YYYY-MM-DD"),
      endDate: endDate.format("YYYY-MM-DD"),
    };
  },

  formatDuration(durationMsOrSec = 0) {
    if (!durationMsOrSec || Number.isNaN(durationMsOrSec)) {
      return "N/A";
    }

    let totalSeconds = durationMsOrSec;
    if (durationMsOrSec > 1000000) {
      totalSeconds = Math.floor(durationMsOrSec / 1000);
    }

    const dur = dayjs.duration(totalSeconds, "seconds");
    const days = Math.floor(dur.asDays());
    const hours = dur.hours();
    const minutes = dur.minutes();
    const seconds = dur.seconds();

    const parts = [];
    if (days) {
      parts.push(`${days}d`);
    }
    if (hours) {
      parts.push(`${hours}h`);
    }
    if (minutes) {
      parts.push(`${minutes}m`);
    }
    if (seconds || parts.length === 0) {
      parts.push(`${seconds}s`);
    }

    return parts.join(" ");
  },

  formatDurationHMS(startDate, endDate = new Date()) {
    const start = dayjs(startDate);
    const end = dayjs(endDate);
    if (!start.isValid()) {
      return "00:00:00";
    }

    const diffMs = Math.max(0, end.diff(start));
    return formatSecondsToHMS(Math.floor(diffMs / 1000));
  },

  isValidDateRange(start, end) {
    if (!start || !end) {
      return false;
    }
    const s = dayjs(start);
    const e = dayjs(end);
    return s.isValid() && e.isValid() && (s.isBefore(e) || s.isSame(e));
  },

  getCachedDateRange() {
    const cacheKey = "cached_date_range";
    const cached = getStorage(cacheKey);
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
    const days =
      startDate && endDate ? dayjs(endDate).diff(dayjs(startDate), "day") + 1 : 0;

    const range = { start: currentStart, end: currentEnd, startDate, endDate, days };
    setStorage(cacheKey, range);
    return range;
  },

  initDatePicker(element, config) {
    if (flatpickr) {
      return flatpickr(element, config);
    }
    return null;
  },
};

export { DATE_STORAGE_KEYS, DateUtils };
