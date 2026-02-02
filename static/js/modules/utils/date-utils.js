import apiClient from "../core/api-client.js";
import { getStorage, setStorage } from "./data.js";

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

  formatDateToString(date) {
    if (!date) {
      return null;
    }
    const d = dayjs(date);
    return d.isValid() ? d.format("YYYY-MM-DD") : null;
  },

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

  formatForDisplay(dateString, options = { dateStyle: "medium" }) {
    const d = dayjs(dateString);
    if (!d.isValid()) {
      return dateString || "";
    }

    const formatterOptions = {};
    if (options.dateStyle !== null) {
      formatterOptions.dateStyle = options.dateStyle || "medium";
    }
    if (options.timeStyle !== null && options.timeStyle !== undefined) {
      formatterOptions.timeStyle = options.timeStyle;
    }
    Object.entries(options).forEach(([key, value]) => {
      if (
        value !== null
        && value !== undefined
        && !["dateStyle", "timeStyle"].includes(key)
      ) {
        formatterOptions[key] = value;
      }
    });

    return new Intl.DateTimeFormat("en-US", formatterOptions).format(d.toDate());
  },

  formatTimeFromHours(hours) {
    if (hours === null || typeof hours === "undefined") {
      return "--:--";
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    const amPm = h < 12 ? "AM" : "PM";
    return `${displayHour}:${m.toString().padStart(2, "0")} ${amPm}`;
  },

  formatSecondsToHMS(seconds) {
    if (typeof seconds !== "number" || Number.isNaN(seconds)) {
      return "00:00:00";
    }
    const dur = dayjs.duration(Math.max(0, Math.floor(seconds)), "seconds");
    const h = Math.floor(dur.asHours());

    if (h >= 24) {
      return this.formatDuration(seconds);
    }

    const m = dur.minutes();
    const s = dur.seconds();
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
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
    return this.formatSecondsToHMS(Math.floor(diffMs / 1000));
  },

  convertDurationToSeconds(duration = "") {
    if (!duration || duration === "N/A" || duration === "Unknown") {
      return 0;
    }

    let seconds = 0;
    const dayMatch = duration.match(/(\d+)\s*d/);
    const hourMatch = duration.match(/(\d+)\s*h/);
    const minuteMatch = duration.match(/(\d+)\s*m/);
    const secondMatch = duration.match(/(\d+)\s*s/);

    if (dayMatch) {
      seconds += parseInt(dayMatch[1], 10) * 86400;
    }
    if (hourMatch) {
      seconds += parseInt(hourMatch[1], 10) * 3600;
    }
    if (minuteMatch) {
      seconds += parseInt(minuteMatch[1], 10) * 60;
    }
    if (secondMatch) {
      seconds += parseInt(secondMatch[1], 10);
    }

    return seconds;
  },

  formatTimeAgo(timestamp, abbreviated = false) {
    const d = dayjs(timestamp);
    if (!d.isValid()) {
      return "";
    }

    const now = dayjs();
    const seconds = now.diff(d, "second");

    if (seconds < 5) {
      return "just now";
    }

    if (abbreviated) {
      if (seconds < 60) {
        return `${seconds}s ago`;
      }
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) {
        return `${minutes}m ago`;
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return `${hours}h ago`;
      }
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }

    return d.fromNow();
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
    const days
      = startDate && endDate ? dayjs(endDate).diff(dayjs(startDate), "day") + 1 : 0;

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
