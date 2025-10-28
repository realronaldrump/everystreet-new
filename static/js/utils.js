/* global flatpickr, bootstrap */

// Consolidated utility functions that will be used across the application
const utils = {
  // Element management with caching
  _elementCache: new Map(),

  getElement(selector) {
    if (this._elementCache.has(selector)) {
      return this._elementCache.get(selector);
    }

    const element = document.querySelector(
      selector.startsWith("#") ||
        selector.includes(" ") ||
        selector.startsWith(".")
        ? selector
        : `#${selector}`,
    );

    if (element) {
      this._elementCache.set(selector, element);
    }
    return element;
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
        setTimeout(() => (inThrottle = false), limit);
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
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * (4 - retries)),
          );
          return this.fetchWithRetry(url, options, retries - 1, cacheTime);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Cache successful response
      if (!this._apiCache) this._apiCache = new Map();
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
      const duration = performance.now() - startTime;
      console.log(`Performance: ${name} took ${duration.toFixed(2)}ms`);
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      console.error(
        `Performance: ${name} failed after ${duration.toFixed(2)}ms`,
        error,
      );
      throw error;
    }
  },

  // Batch DOM updates
  batchDOMUpdates(updates) {
    requestAnimationFrame(() => {
      updates.forEach((update) => update());
    });
  },

  // Storage utilities (moved from app.js)
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
    let stringValue;
    try {
      stringValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);

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
      } catch (error) {
        void error;
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

    cacheKeys
      .slice(0, Math.floor(cacheKeys.length / 2))
      .forEach((key) => localStorage.removeItem(key));
  },

  // Cached fetch (existing implementation)
  _apiCache: new Map(),

  async cachedFetch(url, options = {}, cacheTime = 10000) {
    const key = url + JSON.stringify(options);
    const now = Date.now();
    const cached = this._apiCache.get(key);
    if (cached && now - cached.ts < cacheTime) {
      return cached.data;
    }
    const response = await fetch(url, options);
    if (!response.ok) {
      let errorMsg = `API request failed for ${url} (Status: ${response.status})`;
      try {
        const errData = await response.json();
        errorMsg += `: ${errData.detail || errData.message || response.statusText}`;
      } catch (error) {
        void error;
      }
      throw new Error(errorMsg);
    }
    const data = await response.json();
    this._apiCache.set(key, { data, ts: now });
    return data;
  },

  // Connection monitoring (moved from coverage-management.js)
  setupConnectionMonitoring() {
    let offlineTimer = null;

    const handleConnectionChange = () => {
      const isOnline = navigator.onLine;
      const alertsContainer = document.querySelector("#alerts-container");
      if (!alertsContainer) return;

      // Clear existing connection status alerts
      alertsContainer
        .querySelectorAll(".connection-status")
        .forEach((el) => el.remove());

      if (!isOnline) {
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
            handleConnectionChange();
          }
        }, 5000);
      } else {
        // Show temporary online confirmation
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
      }
    };

    window.addEventListener("online", handleConnectionChange);
    window.addEventListener("offline", handleConnectionChange);
    handleConnectionChange();
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
};

// Enhanced DateUtils with additional methods
const DateUtils = {
  DEFAULT_FORMAT: "YYYY-MM-DD",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

  parseDate(dateValue, endOfDay = false) {
    if (!dateValue) return null;
    if (dateValue instanceof Date) return new Date(dateValue);

    try {
      const date = new Date(dateValue);
      if (isNaN(date.getTime())) {
        console.warn(`Invalid date value: ${dateValue}`);
        return null;
      }

      if (endOfDay) date.setHours(23, 59, 59, 999);
      return date;
    } catch (error) {
      console.warn("Error parsing date:", error);
      return null;
    }
  },

  formatDate(date, format = this.DEFAULT_FORMAT) {
    const parsedDate = this.parseDate(date);
    if (!parsedDate) return null;

    return format === this.DEFAULT_FORMAT
      ? parsedDate.toISOString().split("T")[0]
      : parsedDate.toISOString();
  },

  getCurrentDate(format = this.DEFAULT_FORMAT) {
    return this.formatDate(new Date(), format);
  },

  async getDateRangePreset(preset) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);

    let startDate = new Date(today);

    switch (preset) {
      case "today":
        break;
      case "yesterday":
        startDate.setDate(startDate.getDate() - 1);
        endDate.setDate(endDate.getDate() - 1);
        break;
      case "7days":
      case "last-week":
        startDate.setDate(startDate.getDate() - 7);
        break;
      case "30days":
      case "last-month":
        startDate.setDate(startDate.getDate() - 30);
        break;
      case "90days":
      case "last-quarter":
        startDate.setDate(startDate.getDate() - 90);
        break;
      case "180days":
      case "last-6-months":
        startDate.setMonth(startDate.getMonth() - 6);
        break;
      case "365days":
      case "last-year":
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      case "all-time":
        try {
          const response = await fetch("/api/first_trip_date");
          if (response.ok) {
            const data = await response.json();
            startDate =
              this.parseDate(data.first_trip_date) || new Date("2000-01-01");
          } else {
            startDate = new Date("2000-01-01");
          }
        } catch (error) {
          console.warn("Error fetching first trip date:", error);
          startDate = new Date("2000-01-01");
        }
        break;
      default:
        console.warn(`Unknown date preset: ${preset}`);
    }

    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate),
    };
  },

  formatForDisplay(date, options = {}) {
    const dateObj = this.parseDate(date);
    if (!dateObj) return "";

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

    return new Intl.DateTimeFormat("en-US", formatterOptions).format(dateObj);
  },

  formatDurationHMS(startDate, endDate = new Date()) {
    const start = this.parseDate(startDate);
    if (!start) return "00:00:00";

    const diffMs = Math.max(0, this.parseDate(endDate) - start);
    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  },

  formatSecondsToHMS(seconds) {
    if (typeof seconds !== "number" || isNaN(seconds)) return "00:00:00";

    seconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  },

  // NEW: converts duration strings like "2h 5m 7s" to seconds
  convertDurationToSeconds(duration = "") {
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
  },

  // NEW: formats a millisecond (or second) duration into a human-readable string
  formatDuration(durationMsOrSec = 0) {
    if (!durationMsOrSec || isNaN(durationMsOrSec)) return "N/A";

    // Allow callers to pass seconds as well as milliseconds
    let totalSeconds = durationMsOrSec;
    if (durationMsOrSec > 1000000) {
      // values larger than ~11 days in seconds will be > million but typical callers pass ms
      totalSeconds = Math.floor(durationMsOrSec / 1000);
    }

    const days = Math.floor(totalSeconds / 86400);
    totalSeconds %= 86400;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(" ");
  },

  formatTimeFromHours(hours) {
    if (typeof hours !== "number" || isNaN(hours)) return "--:--";

    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);

    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
  },

  isDateInRange(date, startDate, endDate) {
    const dateObj = this.parseDate(date);
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate, true);

    return dateObj && start && end && dateObj >= start && dateObj <= end;
  },

  isValidDateRange(startDate, endDate) {
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);
    return start && end && start <= end;
  },

  getDuration(startDate, endDate) {
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);
    if (!start || !end) return "Unknown";

    const diffMs = Math.abs(end - start);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays} day${diffDays !== 1 ? "s" : ""}`;
    if (diffHours > 0) return `${diffHours} hour${diffHours !== 1 ? "s" : ""}`;
    if (diffMin > 0) return `${diffMin} minute${diffMin !== 1 ? "s" : ""}`;
    return `${diffSec} second${diffSec !== 1 ? "s" : ""}`;
  },

  getYesterday(format = this.DEFAULT_FORMAT) {
    const dateObj = new Date();
    dateObj.setDate(dateObj.getDate() - 1);
    return this.formatDate(dateObj, format);
  },

  formatTimeAgo(timestamp, abbreviated = false) {
    const date = this.parseDate(timestamp);
    if (!date) return "";

    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 5) return "just now";
    if (seconds < 60) {
      return abbreviated
        ? `${seconds}s ago`
        : `${seconds} second${seconds !== 1 ? "s" : ""} ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return abbreviated
        ? `${minutes}m ago`
        : `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return abbreviated
        ? `${hours}h ago`
        : `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    }

    const days = Math.floor(hours / 24);
    if (days < 7 || !abbreviated) {
      return abbreviated
        ? `${days}d ago`
        : `${days} day${days !== 1 ? "s" : ""} ago`;
    }

    return this.formatForDisplay(date, { dateStyle: "short" });
  },

  // Moved from coverage-management.js
  formatRelativeTime(dateString) {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) {
      return date.toLocaleDateString();
    } else if (days > 0) {
      return `${days} day${days > 1 ? "s" : ""} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    } else {
      return "Just now";
    }
  },

  // Moved from driver_behavior.js
  weekKeyToDateRange(weekKey) {
    // weekKey: 'YYYY-Www'
    const match = weekKey.match(/(\d{4})-W(\d{2})/);
    if (!match) return weekKey;
    const year = parseInt(match[1], 10);
    const week = parseInt(match[2], 10);
    // Get Monday of the week
    const simple = new Date(year, 0, 1 + (week - 1) * 7);
    const dow = simple.getDay();
    const monday = new Date(simple);
    if (dow <= 4) {
      // Mon-Thu: go back to Monday
      monday.setDate(simple.getDate() - simple.getDay() + 1);
    } else {
      // Fri-Sun: go forward to next Monday
      monday.setDate(simple.getDate() + 8 - simple.getDay());
    }
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    // Format as YYYY-MM-DD
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(monday)} to ${fmt(sunday)}`;
  },

  // Distance formatting (moved from coverage-management.js)
  distanceInUserUnits(meters, fixed = 2) {
    if (typeof meters !== "number" || isNaN(meters)) {
      meters = 0;
    }
    const miles = meters * 0.000621371;
    return miles < 0.1
      ? `${(meters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  },

  formatVehicleSpeed(speed) {
    if (typeof speed !== "number") {
      speed = parseFloat(speed) || 0;
    }

    let status = "stopped";
    if (speed > 35) status = "fast";
    else if (speed > 10) status = "medium";
    else if (speed > 0) status = "slow";

    return {
      value: speed.toFixed(1),
      status,
      formatted: `${speed.toFixed(1)} mph`,
      cssClass: `vehicle-${status}`,
    };
  },

  initDatePicker(element, options = {}) {
    if (!window.flatpickr) {
      console.warn("Flatpickr not loaded, cannot initialize date picker");
      return null;
    }

    const defaultOptions = {
      dateFormat: "Y-m-d",
      allowInput: true,
      errorHandler: (error) => console.warn("Flatpickr error:", error),
    };

    return flatpickr(element, { ...defaultOptions, ...options });
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
      userMessage =
        "Network error: Please check your connection and try again.";
    } else if (errorObj.message.includes("timeout")) {
      userMessage = "The operation timed out. Please try again.";
    } else if (errorObj.message.includes("permission")) {
      userMessage =
        "Permission denied: You don't have access to this resource.";
    } else if (
      errorObj.message.includes("not found") ||
      errorObj.status === 404
    ) {
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
    const notification = document.createElement("div");
    notification.className = `notification alert alert-${type} alert-dismissible fade show bg-dark text-white`;
    notification.role = "alert";
    notification.innerHTML = `
      ${message}
      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="alert" aria-label="Close"></button>
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
        if (e.button !== 0) return;
        clearTimeout(timeout);
        this._removeNotification(notification);
      });
    }

    return notification;
  }

  _removeNotification(notification) {
    if (!notification || !notification.parentNode) return;

    if (this.config.animations) {
      notification.classList.remove("show");
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
        this.notifications = this.notifications.filter(
          (n) => n !== notification,
        );
      }, 150);
    } else {
      notification.parentNode.removeChild(notification);
      this.notifications = this.notifications.filter((n) => n !== notification);
    }
  }

  _trimNotifications() {
    if (this.notifications.length <= this.config.maxNotifications) return;

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
      defaultConfirmButtonClass:
        config.defaultConfirmButtonClass || "btn-primary",
    };

    this.modalId = this.config.modalId;
    this.activeModal = null;
    this._createModal();
  }

  _createModal() {
    if (document.getElementById(this.modalId)) return;

    const modal = document.createElement("div");
    modal.className = "modal fade";
    modal.id = this.modalId;
    modal.tabIndex = -1;
    modal.setAttribute("aria-hidden", "true");

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

      const cleanup = () => {
        confirmBtn?.removeEventListener("mousedown", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
      };

      confirmBtn?.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        handleConfirm(e);
      });
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);

      try {
        this.activeModal = new bootstrap.Modal(modalElement);
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

// Initialize global instances
window.notificationManager =
  window.notificationManager || new NotificationManager();
window.confirmationDialog =
  window.confirmationDialog || new ConfirmationDialog();

// Export utilities
window.handleError = handleError;
window.DateUtils = DateUtils;
window.utils = utils;

// Initialize connection monitoring once
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.utils.setupConnectionMonitoring();
  });
} else {
  window.utils.setupConnectionMonitoring();
}
