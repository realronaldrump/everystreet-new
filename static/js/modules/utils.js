/**
 * Consolidated Utilities Module
 * Core utility functions used across the application
 */
import { CONFIG } from "./config.js";
import state from "./state.js";

/**
 * XSS Sanitization - escapes HTML special characters
 * @param {string} str - String to sanitize
 * @returns {string} - Sanitized string safe for HTML insertion
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  if (typeof str !== "string") str = String(str);
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
    "`": "&#x60;",
    "=": "&#x3D;",
  };
  return str.replace(/[&<>"'`=/]/g, (char) => map[char]);
}

/**
 * Create a text node safely (no XSS risk)
 * @param {string} text - Text content
 * @returns {Text} - Text node
 */
export function createTextNode(text) {
  return document.createTextNode(text ?? "");
}

/**
 * Safely set text content on an element
 * @param {Element} element - Target element
 * @param {string} text - Text to set
 */
export function setTextContent(element, text) {
  if (element) {
    element.textContent = text ?? "";
  }
}

/**
 * Create an element with safe text content
 * @param {string} tag - HTML tag name
 * @param {string} text - Text content (will be escaped)
 * @param {string} className - Optional CSS class
 * @returns {Element}
 */
export function createElement(tag, text = "", className = "") {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

// Core utils object for backward compatibility
const utils = {
  // Re-export sanitization functions
  escapeHtml,
  createTextNode,
  setTextContent,
  createElement,

  // Element caching - delegates to state
  getElement(selector) {
    return state.getElement(selector);
  },

  // Debounce function
  debounce(func, wait) {
    let timeout;
    let lastCallTime = 0;

    return function executedFunction(...args) {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTime;

      const later = () => {
        clearTimeout(timeout);
        lastCallTime = Date.now();
        func(...args);
      };

      clearTimeout(timeout);

      if (timeSinceLastCall >= wait) {
        lastCallTime = now;
        func(...args);
      } else {
        timeout = setTimeout(later, wait);
      }
    };
  },

  // Throttle function
  throttle(func, limit) {
    let inThrottle;
    let lastResult;

    return function (...args) {
      if (!inThrottle) {
        lastResult = func.apply(this, args);
        inThrottle = true;
        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
      return lastResult;
    };
  },

  // Fetch with retry, caching, and abort support
  async fetchWithRetry(url, options = {}, retries = 3, cacheTime = 30000, abortKey = null) {
    const cacheKey = `${url}_${JSON.stringify(options)}`;

    // Check cache first
    const cached = state.apiCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < cacheTime) {
      return cached.data;
    }

    // Create abort controller
    const controller = abortKey ? state.createAbortController(abortKey) : new AbortController();
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

      // Cache successful response
      state.apiCache.set(cacheKey, { data, timestamp: Date.now() });

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Request aborted:", url);
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

  // Cached fetch (convenience wrapper)
  cachedFetch(url, options = {}, cacheTime = 10000) {
    return this.fetchWithRetry(url, options, 0, cacheTime);
  },

  // Storage utilities
  getStorage(key, defaultValue = null) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return defaultValue;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    } catch (error) {
      console.warn(`Error accessing localStorage for key ${key}:`, error);
      return defaultValue;
    }
  },

  setStorage(key, value) {
    try {
      const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      localStorage.setItem(key, stringValue);
      return true;
    } catch (e) {
      console.warn("Storage quota exceeded:", e);
      this.clearOldCache();
      try {
        const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
        localStorage.setItem(key, stringValue);
        return true;
      } catch {
        return false;
      }
    }
  },

  removeStorage(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`Error removing localStorage for key ${key}:`, error);
      return false;
    }
  },

  clearOldCache() {
    const cacheKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("cache_")) {
        cacheKeys.push(key);
      }
    }
    cacheKeys.slice(0, Math.floor(cacheKeys.length / 2)).forEach((key) => {
      localStorage.removeItem(key);
    });
  },

  // Performance measurement
  async measurePerformance(name, fn) {
    const startTime = performance.now();
    try {
      const result = await fn();
      const duration = performance.now() - startTime;
      console.log(`Performance: ${name} took ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      console.error(`Performance: ${name} failed after ${duration.toFixed(2)}ms`, error);
      throw error;
    }
  },

  // Batch DOM updates
  batchDOMUpdates(updates) {
    requestAnimationFrame(() => {
      updates.forEach((update) => update());
    });
  },

  // Yield to browser
  async yieldToBrowser(delay = 0) {
    return new Promise((resolve) => {
      if (delay > 0) {
        setTimeout(() => requestAnimationFrame(resolve), delay);
      } else {
        requestAnimationFrame(resolve);
      }
    });
  },

  // Device profile detection
  _deviceProfile: null,
  getDeviceProfile() {
    if (this._deviceProfile) return this._deviceProfile;

    const hasTouch =
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 1);
    const smallViewport =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 820px)").matches;
    const deviceMemory =
      typeof navigator !== "undefined" && "deviceMemory" in navigator
        ? navigator.deviceMemory
        : null;
    const lowMemory = Number.isFinite(deviceMemory) && deviceMemory <= 4;
    const saveData =
      typeof navigator !== "undefined" &&
      navigator.connection?.saveData === true;

    this._deviceProfile = {
      isMobile: Boolean(hasTouch || smallViewport),
      lowMemory,
      deviceMemory: deviceMemory || null,
      saveData,
      isConstrained: Boolean(hasTouch || smallViewport || lowMemory || saveData),
    };

    return this._deviceProfile;
  },

  // Accessibility announcements
  announce(message, priority = "polite") {
    const announcer =
      document.getElementById("map-announcements") ||
      document.querySelector('[aria-live="polite"]');

    if (!announcer) {
      console.warn("No aria-live region found for announcements");
      return;
    }

    announcer.setAttribute("aria-live", priority);
    announcer.textContent = "";

    requestAnimationFrame(() => {
      announcer.textContent = message;
      setTimeout(() => {
        announcer.textContent = "";
      }, 3000);
    });
  },

  // Format helpers
  formatNumber(num, decimals = 0) {
    if (num === null || num === undefined || Number.isNaN(num)) return "--";
    return Number(num).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  },

  formatDistance(miles) {
    if (miles === null || miles === undefined) return "--";
    return `${parseFloat(miles).toFixed(1)} mi`;
  },

  formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "--";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
  },

  formatDateTime(isoString) {
    if (!isoString) return "--";
    return new Date(isoString).toLocaleString("en-US", { hour12: true });
  },
};

// Error handler
export function handleError(error, context = "", level = "error", onComplete = null) {
  const errorObj = typeof error === "string" ? new Error(error) : error;

  if (level === "error") {
    console.error(`Error in ${context}:`, errorObj);
  } else if (level === "warn") {
    console.warn(`Warning in ${context}:`, errorObj);
  }

  if (level === "error" || level === "warn") {
    let userMessage = `Error in ${context}: ${errorObj.message}`;

    if (
      errorObj.name === "NetworkError" ||
      errorObj.message.includes("fetch") ||
      errorObj.message.includes("network")
    ) {
      userMessage = "Network error: Please check your connection and try again.";
    } else if (errorObj.message.includes("timeout")) {
      userMessage = "The operation timed out. Please try again.";
    } else if (errorObj.message.includes("permission")) {
      userMessage = "Permission denied: You don't have access to this resource.";
    } else if (errorObj.message.includes("not found") || errorObj.status === 404) {
      userMessage = "Resource not found: The requested item doesn't exist.";
    } else if (errorObj.status >= 500) {
      userMessage = "Server error: Please try again later.";
    }

    if (window.notificationManager) {
      const notificationType = level === "error" ? "danger" : "warning";
      window.notificationManager.show(userMessage, notificationType);
    }
  }

  if (typeof onComplete === "function") {
    onComplete();
  }

  return errorObj;
}

// Export both as default and named
export { utils };
export default utils;
