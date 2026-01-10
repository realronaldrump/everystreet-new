/**
 * ES6 Module Utils
 * Core utility functions for the application
 *
 * This module provides direct implementations - no delegation to window.utils.
 * Formatters are imported from the consolidated formatters.js module.
 */
import { CONFIG } from "./config.js";
import {
  escapeHtml,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatNumber,
  formatVehicleName,
  sanitizeLocation,
} from "./formatters.js";
import state from "./state.js";

// Re-export formatters for convenience
export {
  escapeHtml,
  formatDateTime,
  formatDistance,
  formatDuration,
  formatNumber,
  formatVehicleName,
  sanitizeLocation,
} from "./formatters.js";

// ============================================================================
// DOM Utilities
// ============================================================================

/**
 * Create an element with safe text content
 * @param {string} tag - HTML tag name
 * @param {string} text - Text content (will be escaped)
 * @param {string} className - CSS class name
 * @returns {HTMLElement} Created element
 */
export function createElement(tag, text = "", className = "") {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/**
 * Get cached DOM element by selector
 * @param {string} selector - CSS selector or element ID
 * @returns {Element|null} Cached element or null
 */
export function getElement(selector) {
  return state.getElement(selector);
}

/**
 * Get all elements matching selector (cached)
 * @param {string} selector - CSS selector
 * @returns {NodeList} Matching elements
 */
export function getAllElements(selector) {
  return state.getAllElements(selector);
}

/**
 * Batch DOM updates using requestAnimationFrame
 * @param {Function[]} updates - Array of update functions
 */
export function batchDOMUpdates(updates) {
  requestAnimationFrame(() => {
    updates.forEach((update) => update());
  });
}

/**
 * Yield control back to the browser for responsive UI
 * @param {number} delay - Optional delay in milliseconds
 * @returns {Promise<void>}
 */
export function yieldToBrowser(delay = 0) {
  return new Promise((resolve) => {
    if (delay > 0) {
      setTimeout(() => requestAnimationFrame(resolve), delay);
    } else {
      requestAnimationFrame(resolve);
    }
  });
}

// ============================================================================
// Function Utilities
// ============================================================================

/**
 * Debounce a function call
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
  let timeout = null;
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
}

/**
 * Throttle a function call
 * @param {Function} func - Function to throttle
 * @param {number} limit - Minimum time between calls in milliseconds
 * @returns {Function} Throttled function
 */
export function throttle(func, limit) {
  let inThrottle = false;
  let lastResult = null;

  return function throttledFunction(...args) {
    if (!inThrottle) {
      lastResult = func.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
    return lastResult;
  };
}

// ============================================================================
// Storage Utilities
// ============================================================================

/**
 * Get value from localStorage with JSON parsing
 * @param {string} key - Storage key
 * @param {*} defaultValue - Default value if key not found
 * @returns {*} Stored value or default
 */
export function getStorage(key, defaultValue = null) {
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
}

/**
 * Set value in localStorage with JSON serialization
 * @param {string} key - Storage key
 * @param {*} value - Value to store
 * @returns {boolean} Success status
 */
export function setStorage(key, value) {
  try {
    const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
    localStorage.setItem(key, stringValue);
    return true;
  } catch (e) {
    console.warn("Storage error:", e);
    clearOldCache();
    try {
      const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      localStorage.setItem(key, stringValue);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Remove key from localStorage
 * @param {string} key - Storage key
 * @returns {boolean} Success status
 */
export function removeStorage(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`Error removing localStorage key ${key}:`, error);
    return false;
  }
}

/**
 * Clear old cache entries to free up storage space
 */
export function clearOldCache() {
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
}

// ============================================================================
// Fetch Utilities
// ============================================================================

/**
 * Fetch with retry logic and response caching
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} retries - Number of retry attempts
 * @param {number} cacheTime - Cache duration in milliseconds
 * @param {string|null} abortKey - Key for abort controller management
 * @returns {Promise<*>} Parsed JSON response
 */
export async function fetchWithRetry(
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
        return fetchWithRetry(url, options, retries - 1, cacheTime, abortKey);
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
}

/**
 * Cached fetch (no retries)
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} cacheTime - Cache duration in milliseconds
 * @returns {Promise<*>} Parsed JSON response
 */
export function cachedFetch(url, options = {}, cacheTime = 10000) {
  return fetchWithRetry(url, options, 0, cacheTime);
}

// ============================================================================
// Animation Utilities
// ============================================================================

/**
 * Fade in an element
 * @param {HTMLElement} el - Element to fade in
 * @param {number} duration - Animation duration in milliseconds
 * @returns {Promise<void>}
 */
export function fadeIn(el, duration = 200) {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }
    el.style.opacity = 0;
    el.style.display = el.style.display || "block";
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
      el.style.opacity = 1;
    });
    setTimeout(resolve, duration);
  });
}

/**
 * Fade out an element
 * @param {HTMLElement} el - Element to fade out
 * @param {number} duration - Animation duration in milliseconds
 * @returns {Promise<void>}
 */
export function fadeOut(el, duration = 200) {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }
    el.style.opacity = 1;
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
      el.style.opacity = 0;
    });
    setTimeout(() => {
      el.style.display = "none";
      resolve();
    }, duration);
  });
}

// ============================================================================
// Device/Browser Utilities
// ============================================================================

let _deviceProfile = null;

/**
 * Get device profile for performance optimizations
 * @returns {Object} Device profile with capabilities info
 */
export function getDeviceProfile() {
  if (_deviceProfile) return _deviceProfile;

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
    navigator.connection &&
    navigator.connection.saveData === true;

  _deviceProfile = {
    isMobile: Boolean(hasTouch || smallViewport),
    lowMemory,
    deviceMemory: deviceMemory || null,
    saveData,
    isConstrained: Boolean(hasTouch || smallViewport || lowMemory || saveData),
  };

  return _deviceProfile;
}

/**
 * Measure scrollbar width
 * @returns {number} Scrollbar width in pixels
 */
export function measureScrollbarWidth() {
  return window.innerWidth - document.documentElement.clientWidth;
}

// ============================================================================
// Notification Utilities
// ============================================================================

/**
 * Show a notification (delegates to notificationManager)
 * @param {...*} args - Arguments to pass to notificationManager.show
 * @returns {*} Notification result
 */
export function showNotification(...args) {
  return window.notificationManager?.show?.(...args);
}

/**
 * Accessibility announcements for screen readers
 * @param {string} message - Message to announce
 * @param {string} priority - Priority ("polite" or "assertive")
 */
export function announce(message, priority = "polite") {
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
}

// ============================================================================
// Performance Utilities
// ============================================================================

/**
 * Measure performance of an async function
 * @param {string} name - Operation name for logging
 * @param {Function} fn - Async function to measure
 * @returns {Promise<*>} Function result
 */
export async function measurePerformance(name, fn) {
  const startTime = performance.now();
  try {
    return await fn();
  } catch (error) {
    const duration = performance.now() - startTime;
    console.error(`Performance: ${name} failed after ${duration.toFixed(2)}ms`, error);
    throw error;
  }
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Handle errors with logging and user notification
 * @param {Error|string} error - Error to handle
 * @param {string} context - Context where error occurred
 * @param {string} level - Error level ("error" or "warn")
 * @param {Function|null} onComplete - Callback after handling
 * @returns {Error} The error object
 */
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

// ============================================================================
// Default Export (utils object for backward compatibility)
// ============================================================================

const utils = {
  // Formatters (re-exported)
  escapeHtml,
  formatNumber,
  formatDistance,
  formatDuration,
  formatDateTime,
  formatVehicleName,
  sanitizeLocation,

  // DOM
  createElement,
  getElement,
  getAllElements,
  batchDOMUpdates,
  yieldToBrowser,

  // Functions
  debounce,
  throttle,

  // Storage
  getStorage,
  setStorage,
  removeStorage,
  clearOldCache,

  // Fetch
  fetchWithRetry,
  cachedFetch,

  // Animation
  fadeIn,
  fadeOut,

  // Device/Browser
  getDeviceProfile,
  measureScrollbarWidth,

  // Notifications
  showNotification,
  announce,

  // Performance
  measurePerformance,

  // Error Handling
  handleError,
};

export { utils };
export default utils;

export { utils };
export default utils;
