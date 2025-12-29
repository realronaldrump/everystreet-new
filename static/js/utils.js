/* global bootstrap */

// Consolidated utility functions that will be used across the application
const utils = {
  // Element management with caching
  _elementCache: new Map(),

  // XSS Sanitization - escapes HTML special characters
  escapeHtml(str) {
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
  },

  // Create an element with safe text content
  createElement(tag, text = "", className = "") {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  },

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
      updates.forEach((update) => {
        update();
      });
    });
  },

  /**
   * Yield control back to the browser to keep the UI responsive.
   * @param {number} delay - Optional delay in milliseconds before yielding.
   */
  async yieldToBrowser(delay = 0) {
    return new Promise((resolve) => {
      if (delay > 0) {
        setTimeout(() => requestAnimationFrame(resolve), delay);
      } else {
        requestAnimationFrame(resolve);
      }
    });
  },

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
      navigator.connection &&
      navigator.connection.saveData === true;

    this._deviceProfile = {
      isMobile: Boolean(hasTouch || smallViewport),
      lowMemory,
      deviceMemory: deviceMemory || null,
      saveData,
      isConstrained: Boolean(
        hasTouch || smallViewport || lowMemory || saveData,
      ),
    };

    return this._deviceProfile;
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

    cacheKeys.slice(0, Math.floor(cacheKeys.length / 2)).forEach((key) => {
      localStorage.removeItem(key);
    });
  },

  // Cached fetch (existing implementation)
  _apiCache: new Map(),

  // Delegate to fetchWithRetry with no retries for backward compatibility
  cachedFetch(url, options = {}, cacheTime = 10000) {
    return this.fetchWithRetry(url, options, 0, cacheTime);
  },

  // Connection monitoring (moved from coverage-management.js)
  setupConnectionMonitoring() {
    let offlineTimer = null;
    let wasOffline = false; // Track if we were actually offline

    const handleConnectionChange = (isInitialCheck = false) => {
      const isOnline = navigator.onLine;
      const alertsContainer = document.querySelector("#alerts-container");
      if (!alertsContainer) return;

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

/**
 * NOTE: DateUtils has been consolidated into the module-based dateUtils.
 * The consolidated version is available at static/js/modules/date-utils.js
 *
 * This compatibility shim will be loaded dynamically when the module is available.
 * For non-module code, window.DateUtils will reference the consolidated implementation.
 */

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
// NOTE: window.DateUtils is now loaded from modules/date-utils.js via app-controller
window.utils = utils;

// Initialize connection monitoring once
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    window.utils.setupConnectionMonitoring();
  });
} else {
  window.utils.setupConnectionMonitoring();
}
