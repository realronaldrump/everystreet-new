/**
 * ES6 Module Utils - Delegates to window.utils for shared functionality
 * Adds module-specific enhancements using state management
 */
import { CONFIG } from "./config.js";
import state from "./state.js";

// Re-export from global utils for convenience
export const escapeHtml = (str) => window.utils.escapeHtml(str);
export const createElement = (tag, text, className) =>
  window.utils.createElement(tag, text, className);

// Core utils object - delegates to window.utils with module enhancements
const utils = {
  // Delegate common functions to global utils
  escapeHtml: (str) => window.utils.escapeHtml(str),
  createElement: (tag, text, className) =>
    window.utils.createElement(tag, text, className),
  debounce: (func, wait) => window.utils.debounce(func, wait),
  throttle: (func, limit) => window.utils.throttle(func, limit),
  getStorage: (key, defaultValue) => window.utils.getStorage(key, defaultValue),
  setStorage: (key, value) => window.utils.setStorage(key, value),
  removeStorage: (key) => window.utils.removeStorage(key),
  fadeIn: (el, duration) => window.utils.fadeIn(el, duration),
  fadeOut: (el, duration) => window.utils.fadeOut(el, duration),
  showNotification: (...args) => window.utils.showNotification(...args),
  announce: (message, priority) => window.utils.announce(message, priority),
  formatNumber: (num, decimals) =>
    window.utils.formatNumber?.(num, decimals) ?? formatNumber(num, decimals),
  formatDistance: (miles) =>
    window.utils.formatDistance?.(miles) ?? formatDistance(miles),
  formatDuration: (seconds) =>
    window.utils.formatDuration?.(seconds) ?? formatDuration(seconds),
  formatDateTime: (isoString) =>
    window.utils.formatDateTime?.(isoString) ?? formatDateTime(isoString),
  getDeviceProfile: () => window.utils.getDeviceProfile(),
  measureScrollbarWidth: () => window.utils.measureScrollbarWidth(),
  batchDOMUpdates: (updates) => window.utils.batchDOMUpdates(updates),
  yieldToBrowser: (delay) => window.utils.yieldToBrowser(delay),

  // Module-specific: Element caching using state
  getElement(selector) {
    return state.getElement(selector);
  },

  // Module-specific: Fetch with state tracking and abort support
  async fetchWithRetry(
    url,
    options = {},
    retries = 3,
    cacheTime = 30000,
    abortKey = null
  ) {
    const cacheKey = `${url}_${JSON.stringify(options)}`;

    // Check cache first
    const cached = state.apiCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTime) {
      return cached.data;
    }

    // Create abort controller
    const controller = abortKey
      ? state.createAbortController(abortKey)
      : new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API.timeout);

    try {
      state.trackRequest(url);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (retries > 0 && response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (4 - retries)));
          return this.fetchWithRetry(url, options, retries - 1, cacheTime, abortKey);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      state.apiCache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      state.completeRequest(url);
      if (abortKey) {
        state.abortControllers.delete(abortKey);
      }
    }
  },

  cachedFetch(url, options = {}, cacheTime = 10000) {
    return this.fetchWithRetry(url, options, 0, cacheTime);
  },
};

// Fallback formatters if global utils doesn't have them
function formatNumber(num, decimals = 0) {
  if (num === null || num === undefined || Number.isNaN(num)) return "--";
  return Number(num).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDistance(miles) {
  if (miles === null || miles === undefined) return "--";
  return `${parseFloat(miles).toFixed(1)} mi`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatDateTime(isoString) {
  if (!isoString) return "--";
  return new Date(isoString).toLocaleString("en-US", { hour12: true });
}

// Error handler - delegates to global
export function handleError(error, context = "", level = "error", onComplete = null) {
  return window.handleError(error, context, level, onComplete);
}

export { utils };
export default utils;
