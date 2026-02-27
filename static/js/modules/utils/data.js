import apiClient from "../core/api-client.js";
import { CONFIG } from "../core/config.js";
import store from "../core/store.js";
import notificationManager from "../ui/notifications.js";

// ============================================================================
// Function Utilities
// ============================================================================

/**
 * Debounce a function call (trailing-edge only).
 * The function is invoked after `wait` ms of silence — never immediately.
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait) {
  let timeout = null;

  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      func.apply(this, args);
    }, wait);
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
    if (value === null) {
      return defaultValue;
    }
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
    const stringValue =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    localStorage.setItem(key, stringValue);
    return true;
  } catch (e) {
    console.warn("Storage error:", e);
    clearOldCache();
    try {
      const stringValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);
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

  const cached = store.apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cacheTime) {
    return cached.data;
  }

  const controller = abortKey
    ? store.createAbortController(abortKey)
    : new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.API.timeout);

  try {
    store.trackRequest(url);

    // Delegate retry logic to apiClient - avoid double-retry
    const data = await apiClient.request(url, {
      ...options,
      signal: controller.signal,
      retry: retries > 0,
    });
    clearTimeout(timeoutId);
    store.apiCache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    store.completeRequest(url);
    if (abortKey) {
      store.abortControllers.delete(abortKey);
    }
  }
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
  if (_deviceProfile) {
    return _deviceProfile;
  }

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

// ============================================================================
// Notification Utilities
// ============================================================================

/**
 * Show a notification (delegates to notificationManager)
 */
export function showNotification(...args) {
  return notificationManager.show(...args);
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

    const notificationType = level === "error" ? "danger" : "warning";
    notificationManager.show(userMessage, notificationType);
  }

  if (typeof onComplete === "function") {
    onComplete();
  }

  return errorObj;
}
