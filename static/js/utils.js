/* global bootstrap, dayjs */

// Consolidated utility functions that will be used across the application
const utils = {
  // Element management with caching
  _elementCache: new Map(),
  _sessionKeys: new Set([
    "startDate",
    "endDate",
    "selectedLocation",
    "mapView",
    "mapType",
    "layerVisibility",
    "layerSettings",
    "streetViewMode",
    "selectedVehicleImei",
    "selectedVehicle",
  ]),

  // XSS Sanitization - escapes HTML special characters
  escapeHtml(str) {
    if (str === null || str === undefined) {
      return "";
    }
    let inputStr = str;
    if (typeof inputStr !== "string") {
      inputStr = String(inputStr);
    }
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
    return inputStr.replace(/[&<>"'`=/]/g, (char) => map[char]);
  },

  // Create an element with safe text content
  createElement(tag, text = "", className = "") {
    const el = document.createElement(tag);
    if (text) {
      el.textContent = text;
    }
    if (className) {
      el.className = className;
    }
    return el;
  },

  getElement(selector) {
    if (this._elementCache.has(selector)) {
      return this._elementCache.get(selector);
    }

    const element = document.querySelector(
      selector.startsWith("#") || selector.includes(" ") || selector.startsWith(".")
        ? selector
        : `#${selector}`
    );

    if (element) {
      this._elementCache.set(selector, element);
    }
    return element;
  },

  // Debounce function
  debounce(func, wait) {
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
  },

  // Throttle function
  throttle(func, limit) {
    let inThrottle = false;
    let lastResult = null;

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

  // Fetch with retry and caching
  async fetchWithRetry(url, options = {}, retries = 3, cacheTime = 30000) {
    const key = `${url}_${JSON.stringify(options)}`;

    // Check cache first
    const cached = this._apiCache.get(key);
    if (cached && Date.now() - cached.timestamp < cacheTime) {
      return cached.data;
    }

    // Create abort controller
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 120000); // 2 minute timeout

    try {
      const response = await fetch(url, {
        ...options,
        signal: abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (retries > 0 && response.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (4 - retries)));
          return this.fetchWithRetry(url, options, retries - 1, cacheTime);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Cache successful response
      if (!this._apiCache) {
        this._apiCache = new Map();
      }
      this._apiCache.set(key, { data, timestamp: Date.now() });

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Request aborted or timed out:", url);
        throw new Error("Request timeout");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  },

  // Performance measurement
  async measurePerformance(name, fn) {
    const startTime = performance.now();
    try {
      const result = await fn();

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      console.error(
        `Performance: ${name} failed after ${duration.toFixed(2)}ms`,
        error
      );
      throw error;
    }
  },

  // Batch DOM updates
  batchDOMUpdates(updates) {
    requestAnimationFrame(() => {
      updates.forEach((update) => {
        update();
      });
    });
  },

  /**
   * Yield control back to the browser to keep the UI responsive.
   * @param {number} delay - Optional delay in milliseconds before yielding.
   */
  yieldToBrowser(delay = 0) {
    return new Promise((resolve) => {
      if (delay > 0) {
        setTimeout(() => requestAnimationFrame(resolve), delay);
      } else {
        requestAnimationFrame(resolve);
      }
    });
  },

  getDeviceProfile() {
    if (this._deviceProfile) {
      return this._deviceProfile;
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

    this._deviceProfile = {
      isMobile: Boolean(hasTouch || smallViewport),
      lowMemory,
      deviceMemory: deviceMemory || null,
      saveData,
      isConstrained: Boolean(hasTouch || smallViewport || lowMemory || saveData),
    };

    return this._deviceProfile;
  },

  // Storage utilities (moved from app.js)
  getStorage(key, defaultValue = null) {
    try {
      if (this._sessionKeys.has(key)) {
        const store = window.ESStore;
        if (store?.getLegacy) {
          const value = store.getLegacy(key);
          return value ?? defaultValue;
        }

        const value = sessionStorage.getItem(key);
        if (value === null) {
          return defaultValue;
        }
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }

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
  },

  setStorage(key, value) {
    let stringValue = null;
    try {
      if (this._sessionKeys.has(key)) {
        const store = window.ESStore;
        if (store?.setLegacy) {
          store.setLegacy(key, value, { source: "utils" });
          return true;
        }
        stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
        sessionStorage.setItem(key, stringValue);
        return true;
      }

      stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);

      localStorage.setItem(key, stringValue);
      return true;
    } catch (e) {
      console.warn("Storage quota exceeded:", e);
      this.clearOldCache();
      try {
        // Reuse the computed value if available, otherwise recompute
        const toStore =
          stringValue !== undefined
            ? stringValue
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
        localStorage.setItem(key, toStore);
        return true;
      } catch {
        // Ignore localStorage errors
        return false;
      }
    }
  },

  removeStorage(key) {
    try {
      if (this._sessionKeys.has(key)) {
        const store = window.ESStore;
        if (store?.removeLegacy) {
          store.removeLegacy(key);
        } else {
          sessionStorage.removeItem(key);
        }
        return true;
      }
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`Error removing localStorage for key ${key}:`, error);
      return false;
    }
  },

  onPageLoad(callback, options = {}) {
    let cleanup = null;
    let controller = null;
    let activeRoute = null;

    const run = () => {
      if (options.route && document.body?.dataset?.route !== options.route) {
        return;
      }

      if (cleanup) {
        cleanup();
        cleanup = null;
      }

      if (controller) {
        controller.abort();
      }
      controller = new AbortController();
      activeRoute = options.route || document.body?.dataset?.route || null;

      const registerCleanup = (fn) => {
        if (typeof fn === "function") {
          cleanup = fn;
        }
      };

      const result = callback({ signal: controller.signal, cleanup: registerCleanup });
      if (typeof result === "function") {
        cleanup = result;
      }
    };

    const handleUnload = (event) => {
      if (options.route && event?.detail?.path && event.detail.path !== options.route) {
        return;
      }
      if (!activeRoute) {
        return;
      }
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      if (controller) {
        controller.abort();
        controller = null;
      }
      activeRoute = null;
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }

    document.addEventListener("es:page-load", run);
    document.addEventListener("es:page-unload", handleUnload);

    return () => {
      document.removeEventListener("es:page-load", run);
      document.removeEventListener("es:page-unload", handleUnload);
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      if (controller) {
        controller.abort();
        controller = null;
      }
    };
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

  // Cached fetch (existing implementation)
  _apiCache: new Map(),

  // Connection monitoring (moved from coverage-management.js)
  setupConnectionMonitoring() {
    let offlineTimer = null;
    let wasOffline = false; // Track if we were actually offline

    const handleConnectionChange = (isInitialCheck = false) => {
      const isOnline = navigator.onLine;
      const alertsContainer = document.querySelector("#alerts-container");
      if (!alertsContainer) {
        return;
      }

      // Clear existing connection status alerts
      alertsContainer.querySelectorAll(".connection-status").forEach((el) => {
        el.remove();
      });

      if (!isOnline) {
        wasOffline = true;
        // Show persistent offline warning
        const statusBar = document.createElement("div");
        statusBar.className = "connection-status alert alert-danger fade show";
        statusBar.innerHTML = `
          <i class="fas fa-wifi-slash me-2"></i>
          <strong>Offline</strong> - Changes cannot be saved while offline.
          <div class="mt-2">
            <small>Your work will be saved locally and synced when connection is restored.</small>
          </div>
        `;
        alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);

        // Start monitoring for reconnection
        offlineTimer = setInterval(() => {
          if (navigator.onLine) {
            clearInterval(offlineTimer);
            handleConnectionChange(false);
          }
        }, 5000);
      } else if (wasOffline && !isInitialCheck) {
        // Only show "Connected" notification when recovering from offline state
        if (offlineTimer) {
          clearInterval(offlineTimer);
          offlineTimer = null;
        }

        const statusBar = document.createElement("div");
        statusBar.className =
          "connection-status alert alert-success alert-dismissible fade show";
        statusBar.innerHTML = `
          <i class="fas fa-wifi me-2"></i>
          <strong>Connected</strong> - Connection restored.
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);

        // Auto-dismiss after animation
        setTimeout(() => {
          const bsAlert = bootstrap.Alert.getOrCreateInstance(statusBar);
          if (bsAlert) {
            bsAlert.close();
          }
        }, 5000);

        wasOffline = false;
      }
      // If online and was never offline (initial check), do nothing - no notification needed
    };

    window.addEventListener("online", () => handleConnectionChange(false));
    window.addEventListener("offline", () => handleConnectionChange(false));

    // Initial check - don't show notification if already online
    handleConnectionChange(true);
  },

  // Fade in animation
  fadeIn(el, duration = 200) {
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
  },

  // Fade out animation
  fadeOut(el, duration = 200) {
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
  },

  // Measure scrollbar width
  measureScrollbarWidth() {
    return window.innerWidth - document.documentElement.clientWidth;
  },

  // Shorthand for notifications
  showNotification(...args) {
    return window.notificationManager?.show?.(...args);
  },

  // Accessibility announcements for screen readers
  announce(message, priority = "polite") {
    const announcer =
      document.getElementById("map-announcements") ||
      document.querySelector('[aria-live="polite"]');

    if (!announcer) {
      console.warn("No aria-live region found for announcements");
      return;
    }

    // Clear previous announcement and set priority
    announcer.setAttribute("aria-live", priority);
    announcer.textContent = "";

    // Brief delay to ensure screen readers pick up the change
    requestAnimationFrame(() => {
      announcer.textContent = message;

      // Auto-clear after announcement
      setTimeout(() => {
        announcer.textContent = "";
      }, 3000);
    });
  },
  // Helper to format vehicle name
  formatVehicleName(vehicle) {
    if (!vehicle) {
      return "Unknown Vehicle";
    }
    return vehicle.custom_name || `Vehicle ${vehicle.vin || vehicle.imei}`;
  },
};

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
    return utils.getStorage(DATE_STORAGE_KEYS.startDate) || this.getCurrentDate();
  },

  getEndDate() {
    return utils.getStorage(DATE_STORAGE_KEYS.endDate) || this.getCurrentDate();
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
        value !== null &&
        value !== undefined &&
        !["dateStyle", "timeStyle"].includes(key)
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
    const dayMatch = duration.match(/(\\d+)\\s*d/);
    const hourMatch = duration.match(/(\\d+)\\s*h/);
    const minuteMatch = duration.match(/(\\d+)\\s*m/);
    const secondMatch = duration.match(/(\\d+)\\s*s/);

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
      startDate && endDate ? dayjs(endDate).diff(dayjs(startDate), "day") + 1 : 0;

    const range = { start: currentStart, end: currentEnd, startDate, endDate, days };
    utils.setStorage(cacheKey, range);
    return range;
  },

  initDatePicker(element, config) {
    if (window.flatpickr) {
      return window.flatpickr(element, config);
    }
    return null;
  },
};

function handleError(error, context = "", level = "error", onComplete = null) {
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

class NotificationManager {
  constructor(config = {}) {
    this.config = {
      position: config.position || "top-end",
      containerClass: config.containerClass || "notification-container",
      defaultDuration: config.defaultDuration || 5000,
      maxNotifications: config.maxNotifications || 5,
      animations: config.animations !== false,
    };

    this.notifications = [];
    this.container = this._getOrCreateContainer();
  }

  _getOrCreateContainer() {
    let container = document.querySelector(`.${this.config.containerClass}`);

    if (!container) {
      container = document.createElement("div");
      container.className = `${this.config.containerClass} position-fixed top-0 end-0 p-3`;
      container.setAttribute("aria-live", "polite");
      document.body.appendChild(container);
    }

    return container;
  }

  show(message, type = "info", duration = this.config.defaultDuration) {
    const typeClass = type === "danger" ? "error" : type;
    const iconMap = {
      success: "fa-check-circle",
      error: "fa-exclamation-triangle",
      warning: "fa-exclamation-circle",
      info: "fa-info-circle",
    };
    const iconName = iconMap[typeClass] || iconMap.info;
    const iconMarkup =
      typeClass === "success"
        ? '<span class="notification-check" aria-hidden="true"></span>'
        : `<i class="fas ${iconName}" aria-hidden="true"></i>`;

    const notification = document.createElement("div");
    notification.className = `notification notification-${typeClass} alert alert-${type} alert-dismissible fade show bg-dark text-white`;
    notification.role = "alert";
    notification.innerHTML = `
      <div class="notification-icon">${iconMarkup}</div>
      <div class="notification-content">
        <div class="notification-message">${message}</div>
      </div>
      <button type="button" class="btn-close btn-close-white notification-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    this.container.appendChild(notification);

    this.notifications.push(notification);
    this._trimNotifications();

    const timeout = setTimeout(() => {
      this._removeNotification(notification);
    }, duration);

    const closeButton = notification.querySelector(".btn-close");
    if (closeButton) {
      closeButton.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
          return;
        }
        clearTimeout(timeout);
        this._removeNotification(notification);
      });
    }

    return notification;
  }

  _removeNotification(notification) {
    if (!notification || !notification.parentNode) {
      return;
    }

    if (this.config.animations) {
      notification.classList.remove("show");
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
        this.notifications = this.notifications.filter((n) => n !== notification);
      }, 150);
    } else {
      notification.parentNode.removeChild(notification);
      this.notifications = this.notifications.filter((n) => n !== notification);
    }
  }

  _trimNotifications() {
    if (this.notifications.length <= this.config.maxNotifications) {
      return;
    }

    const excess = this.notifications.length - this.config.maxNotifications;
    for (let i = 0; i < excess; i++) {
      const oldest = this.notifications.shift();
      if (oldest?.parentNode) {
        oldest.parentNode.removeChild(oldest);
      }
    }
  }

  clearAll() {
    [...this.notifications].forEach((notification) => {
      this._removeNotification(notification);
    });
  }
}

class ConfirmationDialog {
  constructor(config = {}) {
    this.config = {
      modalId: config.modalId || "confirmationModal",
      backdropStatic: config.backdropStatic !== false,
      defaultTitle: config.defaultTitle || "Confirm",
      defaultMessage: config.defaultMessage || "Are you sure?",
      defaultConfirmText: config.defaultConfirmText || "Confirm",
      defaultCancelText: config.defaultCancelText || "Cancel",
      defaultConfirmButtonClass: config.defaultConfirmButtonClass || "btn-primary",
    };

    this.modalId = this.config.modalId;
    this.activeModal = null;
    this._createModal();
  }

  _createModal() {
    if (document.getElementById(this.modalId)) {
      return;
    }

    const modal = document.createElement("div");
    modal.className = "modal fade";
    modal.id = this.modalId;
    modal.tabIndex = -1;

    if (this.config.backdropStatic) {
      modal.setAttribute("data-bs-backdrop", "static");
    }

    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content bg-dark text-white">
          <div class="modal-header">
            <h5 class="modal-title"></h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary cancel-btn" data-bs-dismiss="modal"></button>
            <button type="button" class="btn confirm-btn"></button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  show(options = {}) {
    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      if (!modalElement) {
        console.error("Confirmation modal not found");
        resolve(false);
        return;
      }

      const title = options.title || this.config.defaultTitle;
      const message = options.message || this.config.defaultMessage;
      const confirmText = options.confirmText || this.config.defaultConfirmText;
      const cancelText = options.cancelText || this.config.defaultCancelText;
      const confirmButtonClass =
        options.confirmButtonClass || this.config.defaultConfirmButtonClass;

      modalElement.querySelector(".modal-title").textContent = title;
      modalElement.querySelector(".modal-body").innerHTML = message;

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".cancel-btn");

      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;
      }

      if (cancelBtn) {
        cancelBtn.textContent = cancelText;
      }

      const handleConfirm = () => {
        confirmBtn?.blur();
        cleanup();
        this.activeModal?.hide();
        this.activeModal = null;
        resolve(true);
      };

      const handleDismiss = () => {
        cleanup();
        this.activeModal = null;
        resolve(false);
      };

      function cleanup() {
        confirmBtn?.removeEventListener("mousedown", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
      }

      confirmBtn?.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
          return;
        }
        handleConfirm();
      });
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);

      try {
        this.activeModal = new bootstrap.Modal(modalElement);
        modalElement.removeAttribute("aria-hidden");
        this.activeModal.show();
      } catch (error) {
        console.error("Error showing modal:", error);
        cleanup();
        resolve(false);
      }
    });
  }

  hide() {
    if (this.activeModal) {
      this.activeModal.hide();
      this.activeModal = null;
    }
  }
}

class PromptDialog {
  constructor(config = {}) {
    this.config = {
      modalId: config.modalId || "promptModal",
      backdropStatic: config.backdropStatic !== false,
      defaultTitle: config.defaultTitle || "Input Required",
      defaultMessage: config.defaultMessage || "Please enter a value:",
      defaultConfirmText: config.defaultConfirmText || "OK",
      defaultCancelText: config.defaultCancelText || "Cancel",
      defaultConfirmButtonClass: config.defaultConfirmButtonClass || "btn-primary",
      defaultInputType: config.inputType || "text",
    };

    this.modalId = this.config.modalId;
    this.activeModal = null;
    this._createModal();
  }

  _createModal() {
    if (document.getElementById(this.modalId)) {
      return;
    }

    const modal = document.createElement("div");
    modal.className = "modal fade";
    modal.id = this.modalId;
    modal.tabIndex = -1;

    if (this.config.backdropStatic) {
      modal.setAttribute("data-bs-backdrop", "static");
    }

    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content bg-dark text-white">
          <div class="modal-header">
            <h5 class="modal-title"></h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <p class="modal-message mb-3"></p>
            <input type="text" class="form-control bg-dark text-white border-secondary prompt-input" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary cancel-btn" data-bs-dismiss="modal"></button>
            <button type="button" class="btn confirm-btn"></button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  show(options = {}) {
    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      if (!modalElement) {
        console.error("Prompt modal not found");
        resolve(null);
        return;
      }

      const title = options.title || this.config.defaultTitle;
      const message = options.message || this.config.defaultMessage;
      const confirmText = options.confirmText || this.config.defaultConfirmText;
      const cancelText = options.cancelText || this.config.defaultCancelText;
      const confirmButtonClass =
        options.confirmButtonClass || this.config.defaultConfirmButtonClass;
      const inputType = options.inputType || this.config.defaultInputType;
      const placeholder = options.placeholder || "";
      const defaultValue = options.defaultValue || "";

      modalElement.querySelector(".modal-title").textContent = title;
      modalElement.querySelector(".modal-message").textContent = message;

      const input = modalElement.querySelector(".prompt-input");
      input.type = inputType;
      input.placeholder = placeholder;
      input.value = defaultValue;

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".cancel-btn");

      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;
      }

      if (cancelBtn) {
        cancelBtn.textContent = cancelText;
      }

      const handleConfirm = () => {
        const { value } = input;
        cleanup();
        this.activeModal?.hide();
        this.activeModal = null;
        resolve(value);
      };

      const handleDismiss = () => {
        cleanup();
        this.activeModal = null;
        resolve(null);
      };

      const handleKeypress = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleConfirm();
        }
      };

      const handleShown = () => {
        input.focus();
      };

      function cleanup() {
        confirmBtn?.removeEventListener("mousedown", handleConfirm);
        input?.removeEventListener("keypress", handleKeypress);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
        modalElement.removeEventListener("shown.bs.modal", handleShown);
      }

      confirmBtn?.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
          return;
        }
        handleConfirm();
      });
      input?.addEventListener("keypress", handleKeypress);
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);
      modalElement.addEventListener("shown.bs.modal", handleShown);

      try {
        this.activeModal = new bootstrap.Modal(modalElement);
        this.activeModal.show();
      } catch (error) {
        console.error("Error showing modal:", error);
        cleanup();
        resolve(null);
      }
    });
  }

  hide() {
    if (this.activeModal) {
      this.activeModal.hide();
      this.activeModal = null;
    }
  }
}

// Initialize global instances
window.notificationManager = window.notificationManager || new NotificationManager();
window.confirmationDialog = window.confirmationDialog || new ConfirmationDialog();
window.promptDialog = window.promptDialog || new PromptDialog();

// Export utilities
window.handleError = handleError;
window.utils = utils;
window.DateUtils = DateUtils;

document.addEventListener("es:page-load", () => {
  window.utils?._elementCache?.clear();
});

document.addEventListener("es:page-unload", () => {
  window.utils?._elementCache?.clear();
});

// Initialize connection monitoring once
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.utils.setupConnectionMonitoring();
  });
} else {
  window.utils.setupConnectionMonitoring();
}
