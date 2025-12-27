/**
 * Date Utilities Module - Day.js Implementation
 *
 * Provides timezone-safe date handling, formatting, and parsing utilities.
 * Uses Day.js library for date manipulation.
 *
 * @module date-utils
 */

import { CONFIG } from "./config.js";
import utils from "./utils.js";

// Day.js is loaded globally via CDN in base.html with plugins:
// - relativeTime (fromNow)
// - duration
// - weekOfYear
// - isoWeek
// - isBetween

const dateUtils = {
  DEFAULT_FORMAT: "YYYY-MM-DD",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

  /**
   * Parse a date string (YYYY-MM-DD) into local midnight Date object.
   */
  parseDateString(dateStr) {
    if (!dateStr) return null;
    const d = dayjs(dateStr);
    return d.isValid() ? d.startOf("day").toDate() : null;
  },

  /**
   * Format a Date object to YYYY-MM-DD string in local timezone.
   */
  formatDateToString(date) {
    if (!date) return null;
    const d = dayjs(date);
    return d.isValid() ? d.format("YYYY-MM-DD") : null;
  },

  /**
   * Parse various date formats into a Date object.
   */
  parseDate(dateValue, endOfDay = false) {
    if (!dateValue) return null;
    const d = dayjs(dateValue);
    if (!d.isValid()) return null;
    return endOfDay ? d.endOf("day").toDate() : d.toDate();
  },

  /**
   * Format a date value to a specific format.
   */
  formatDate(date, format = this.DEFAULT_FORMAT) {
    if (!date) return null;
    const d = dayjs(date);
    return d.isValid() ? d.format(format) : null;
  },

  /**
   * Get current date as YYYY-MM-DD string.
   */
  getCurrentDate() {
    return dayjs().format("YYYY-MM-DD");
  },

  /**
   * Get yesterday's date as YYYY-MM-DD string.
   */
  getYesterday() {
    return dayjs().subtract(1, "day").format("YYYY-MM-DD");
  },

  /**
   * Get start date from storage or current date.
   */
  getStartDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.startDate) || this.getCurrentDate()
    );
  },

  /**
   * Get end date from storage or current date.
   */
  getEndDate() {
    return (
      utils.getStorage(CONFIG.STORAGE_KEYS.endDate) || this.getCurrentDate()
    );
  },

  /**
   * Get a date range based on a preset.
   */
  async getDateRangePreset(range) {
    const today = dayjs();
    let startDate, endDate;

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
          const res = await fetch("/api/first_trip_date");
          if (res.ok) {
            const data = await res.json();
            if (data.first_trip_date) {
              const dateOnly = data.first_trip_date.split("T")[0];
              startDate = dayjs(dateOnly);
            }
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

  /**
   * Format a date for display using Intl.DateTimeFormat.
   */
  formatForDisplay(dateString, options = { dateStyle: "medium" }) {
    const d = dayjs(dateString);
    if (!d.isValid()) return dateString || "";

    const formatterOptions = {};
    if (options.dateStyle !== null) {
      formatterOptions.dateStyle = options.dateStyle || "medium";
    }
    if (options.timeStyle !== null && options.timeStyle !== undefined) {
      formatterOptions.timeStyle = options.timeStyle;
    }
    Object.entries(options).forEach(([key, value]) => {
      if (
        value !== null &&
        value !== undefined &&
        !["dateStyle", "timeStyle"].includes(key)
      ) {
        formatterOptions[key] = value;
      }
    });

    return new Intl.DateTimeFormat("en-US", formatterOptions).format(
      d.toDate(),
    );
  },

  /**
   * Format time from hours to AM/PM format.
   */
  formatTimeFromHours(hours) {
    if (hours === null || typeof hours === "undefined") return "--:--";
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    const amPm = h < 12 ? "AM" : "PM";
    return `${displayHour}:${m.toString().padStart(2, "0")} ${amPm}`;
  },

  /**
   * Format duration from seconds to H:MM:SS format.
   */
  formatSecondsToHMS(seconds) {
    if (typeof seconds !== "number" || Number.isNaN(seconds)) return "00:00:00";
    const dur = dayjs.duration(Math.max(0, Math.floor(seconds)), "seconds");
    const h = Math.floor(dur.asHours());

    if (h >= 24) {
      return this.formatDuration(seconds);
    }

    const m = dur.minutes();
    const s = dur.seconds();
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  },

  /**
   * Format duration from milliseconds or seconds to human-readable string.
   */
  formatDuration(durationMsOrSec = 0) {
    if (!durationMsOrSec || Number.isNaN(durationMsOrSec)) return "N/A";

    // Auto-detect ms vs seconds
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
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(" ");
  },

  /**
   * Calculate duration between two dates and format as H:MM:SS.
   */
  formatDurationHMS(startDate, endDate = new Date()) {
    const start = dayjs(startDate);
    const end = dayjs(endDate);
    if (!start.isValid()) return "00:00:00";

    const diffMs = Math.max(0, end.diff(start));
    return this.formatSecondsToHMS(Math.floor(diffMs / 1000));
  },

  /**
   * Convert duration string to seconds.
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
   */
  formatTimeAgo(timestamp, abbreviated = false) {
    const d = dayjs(timestamp);
    if (!d.isValid()) return "";

    const now = dayjs();
    const seconds = now.diff(d, "second");

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

    return d.fromNow();
  },

  /**
   * Format relative time with "Never" fallback.
   */
  formatRelativeTime(dateString) {
    if (!dateString) return "Never";
    const d = dayjs(dateString);
    if (!d.isValid()) return "Never";

    const days = dayjs().diff(d, "day");
    if (days > 7) {
      return d.toDate().toLocaleDateString();
    }
    return d.fromNow();
  },

  /**
   * Validate a date range.
   */
  isValidDateRange(start, end) {
    if (!start || !end) return false;
    const s = dayjs(start);
    const e = dayjs(end);
    return s.isValid() && e.isValid() && (s.isBefore(e) || s.isSame(e));
  },

  /**
   * Check if a date is within a range.
   */
  isDateInRange(date, startDate, endDate) {
    const d = dayjs(date);
    const s = dayjs(startDate).startOf("day");
    const e = dayjs(endDate).endOf("day");
    return (
      d.isValid() && s.isValid() && e.isValid() && d.isBetween(s, e, null, "[]")
    );
  },

  /**
   * Get duration between two dates as human-readable string.
   */
  getDuration(startDate, endDate) {
    const s = dayjs(startDate);
    const e = dayjs(endDate);
    if (!s.isValid() || !e.isValid()) return "Unknown";

    const diffMs = Math.abs(e.diff(s));
    const dur = dayjs.duration(diffMs);

    const days = Math.floor(dur.asDays());
    if (days > 0) return `${days} day${days !== 1 ? "s" : ""}`;

    const hours = Math.floor(dur.asHours());
    if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;

    const minutes = Math.floor(dur.asMinutes());
    if (minutes > 0) return `${minutes} minute${minutes !== 1 ? "s" : ""}`;

    const seconds = Math.floor(dur.asSeconds());
    return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  },

  /**
   * Get cached date range from storage.
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
    const days =
      startDate && endDate
        ? dayjs(endDate).diff(dayjs(startDate), "day") + 1
        : 0;

    const range = {
      start: currentStart,
      end: currentEnd,
      startDate,
      endDate,
      days,
    };
    utils.setStorage(cacheKey, range);
    return range;
  },

  /**
   * Convert week key (YYYY-Www) to date range string.
   */
  weekKeyToDateRange(weekKey) {
    const match = weekKey.match(/(\d{4})-W(\d{2})/);
    if (!match) return weekKey;

    const year = parseInt(match[1], 10);
    const week = parseInt(match[2], 10);

    const monday = dayjs().year(year).isoWeek(week).startOf("isoWeek");
    const sunday = monday.add(6, "day");

    return `${monday.format("YYYY-MM-DD")} to ${sunday.format("YYYY-MM-DD")}`;
  },

  /**
   * Format distance in user units (miles/feet).
   */
  distanceInUserUnits(meters, fixed = 2) {
    const validMeters =
      typeof meters === "number" && !Number.isNaN(meters) ? meters : 0;
    const miles = validMeters * 0.000621371;
    return miles < 0.1
      ? `${(validMeters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  },

  /**
   * Format vehicle speed with status.
   */
  formatVehicleSpeed(speed) {
    const validSpeed =
      typeof speed === "number" ? speed : parseFloat(speed) || 0;

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
   */
  initDatePicker(element, config) {
    if (window.flatpickr) {
      return window.flatpickr(element, config);
    }
    return null;
  },
};

export default dateUtils;
