import { CONFIG } from "./config.js";
import utils from "./utils.js";

/**
 * Helper functions that wrap the legacy global `DateUtils` module and localStorage caching.
 * This lets the rest of the codebase stay agnostic to the underlying implementation
 * (and makes testing a lot easier).
 */
const dateUtils = {
  getStartDate: () =>
    utils.getStorage(CONFIG.STORAGE_KEYS.startDate) ||
    window.DateUtils.getCurrentDate(),

  getEndDate: () =>
    utils.getStorage(CONFIG.STORAGE_KEYS.endDate) ||
    window.DateUtils.getCurrentDate(),

  formatTimeFromHours(hours) {
    return window.DateUtils.formatTimeFromHours(hours);
  },

  /**
   * Returns an object describing the current cached date range. If the cached
   * range is stale it re-computes it and writes it back to storage.
   */
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
};

export default dateUtils;

/**
 * Utility: converts a human-readable duration string (e.g. "2h 5m 7s") to seconds.
 * Supports days, hours, minutes, seconds in any combination.
 */
export function convertDurationToSeconds(duration = "") {
  if (!duration || duration === "N/A" || duration === "Unknown") return 0;

  let seconds = 0;
  const dayMatch = duration.match(/(\d+)\s*d/);
  const hourMatch = duration.match(/(\d+)\s*h/);
  const minuteMatch = duration.match(/(\d+)\s*m/);
  const secondMatch = duration.match(/(\d+)\s*s/);

  if (dayMatch) seconds += parseInt(dayMatch[1]) * 86400;
  if (hourMatch) seconds += parseInt(hourMatch[1]) * 3600;
  if (minuteMatch) seconds += parseInt(minuteMatch[1]) * 60;
  if (secondMatch) seconds += parseInt(secondMatch[1]);

  return seconds;
}

// Expose on the existing global DateUtils (for legacy scripts)
if (window.DateUtils && !window.DateUtils.convertDurationToSeconds) {
  window.DateUtils.convertDurationToSeconds = convertDurationToSeconds;
}
