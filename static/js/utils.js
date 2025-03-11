/** global bootstrap */

/**
 * @file Application utilities for error handling, notifications, and UI components
 */

/**
 * DateUtils: Centralized utilities for consistent date handling
 */
const DateUtils = {
  /**
   * Default date format for the application (ISO format YYYY-MM-DD)
   */
  DEFAULT_FORMAT: "YYYY-MM-DD",

  /**
   * Application timezone - defaults to user's local timezone
   * This can be changed based on application requirements
   */
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,

  /**
   * Parse a date string into a Date object
   * @param {string|Date|null} dateValue - Date to parse
   * @param {boolean} [endOfDay=false] - If true, set time to end of day (23:59:59.999)
   * @returns {Date|null} - JavaScript Date object or null if invalid
   */
  parseDate(dateValue, endOfDay = false) {
    if (!dateValue) return null;

    // Already a Date object
    if (dateValue instanceof Date) {
      return new Date(dateValue); // Create a copy to avoid mutating the original
    }

    let date = null;
    try {
      if (typeof dateValue === "string") {
        // Handle ISO format (YYYY-MM-DD)
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
          date = new Date(dateValue);
        }
        // Handle other date formats
        else {
          date = new Date(dateValue);
        }
      } else {
        // Handle unexpected types
        console.warn(`Unexpected date type: ${typeof dateValue}`);
        return null;
      }

      // Check if date is valid
      if (isNaN(date.getTime())) {
        console.warn(`Invalid date value: ${dateValue}`);
        return null;
      }

      // Set to end of day if requested
      if (endOfDay) {
        date.setHours(23, 59, 59, 999);
      }

      return date;
    } catch (error) {
      console.warn("Error parsing date: %s", error);
      return null;
    }
  },

  /**
   * Format a date to a standardized string
   * @param {Date|string} date - Date to format
   * @param {string} [format=DEFAULT_FORMAT] - Output format
   * @returns {string|null} - Formatted date string or null if invalid
   */
  formatDate(date, format = this.DEFAULT_FORMAT) {
    const parsedDate = this.parseDate(date);
    if (!parsedDate) return null;

    // Default format is ISO date (YYYY-MM-DD)
    if (format === this.DEFAULT_FORMAT) {
      return parsedDate.toISOString().split("T")[0];
    }

    return parsedDate.toISOString();
  },

  /**
   * Get current date as a string in the specified format
   * @param {string} [format=DEFAULT_FORMAT] - Output format
   * @returns {string} - Current date as a string
   */
  getCurrentDate(format = this.DEFAULT_FORMAT) {
    return this.formatDate(new Date(), format);
  },

  /**
   * Get date range for a preset period
   * @param {string} preset - Preset name ('today', '7days', '30days', 'all-time', etc.)
   * @returns {Object} - Object with startDate and endDate as formatted strings in DEFAULT_FORMAT
   */
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
            startDate = this.parseDate(data.first_trip_date);
            if (!startDate) {
              // Fallback if API returns invalid date
              startDate = new Date("2000-01-01");
            }
          } else {
            // Fallback if API fails
            startDate = new Date("2000-01-01");
          }
        } catch (error) {
          console.warn("Error fetching first trip date: %s", error);
          startDate = new Date("2000-01-01"); // Fallback date
        }
        break;
      default:
        console.warn(`Unknown date preset: ${preset}`);
        return {
          startDate: this.formatDate(startDate),
          endDate: this.formatDate(endDate),
        };
    }

    return {
      startDate: this.formatDate(startDate),
      endDate: this.formatDate(endDate),
    };
  },

  /**
   * Get date range for a preset period (synchronous version)
   * This version doesn't call APIs for the all-time case
   * @param {string} preset - Preset name
   * @returns {Object} - Object with startDate and endDate as Date objects
   */
  getDateRangeForPreset(preset) {
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
        // We'll use a very early date for immediate fallback
        startDate = new Date("2000-01-01");
        break;
      default:
        console.warn(`Unknown date preset: ${preset}`);
    }

    return { startDate, endDate };
  },

  /**
   * Format a date for display to users
   * @param {Date|string} date - Date to format
   * @param {Object} [options] - Intl.DateTimeFormat options
   * @returns {string} - Formatted date string
   */
  formatForDisplay(date, options = {}) {
    const dateObj = this.parseDate(date);
    if (!dateObj) return "";

    // Create a clean options object without any null values
    const formatterOptions = {};

    // Apply default dateStyle if not explicitly set to null
    if (options.dateStyle !== null) {
      formatterOptions.dateStyle = options.dateStyle || "medium";
    }

    // Only include timeStyle if explicitly provided and not null
    if (options.timeStyle !== null && options.timeStyle !== undefined) {
      formatterOptions.timeStyle = options.timeStyle;
    }

    // Add any other options
    Object.entries(options).forEach(([key, value]) => {
      if (
        value !== null &&
        value !== undefined &&
        key !== "dateStyle" &&
        key !== "timeStyle"
      ) {
        formatterOptions[key] = value;
      }
    });

    const formatter = new Intl.DateTimeFormat("en-US", formatterOptions);
    return formatter.format(dateObj);
  },

  /**
   * Check if a date is within a specified date range (inclusive)
   * @param {Date|string} date - Date to check
   * @param {Date|string} startDate - Start of range
   * @param {Date|string} endDate - End of range
   * @returns {boolean} - True if date is within range
   */
  isDateInRange(date, startDate, endDate) {
    const dateObj = this.parseDate(date);
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate, true); // Use end of day for end date

    if (!dateObj || !start || !end) return false;

    return dateObj >= start && dateObj <= end;
  },

  /**
   * Validate a date range
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @returns {boolean} - True if range is valid
   */
  isValidDateRange(startDate, endDate) {
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);

    if (!start || !end) return false;

    return start <= end;
  },

  /**
   * Calculate duration between two dates
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @returns {string} - Human-readable duration
   */
  getDuration(startDate, endDate) {
    const start = this.parseDate(startDate);
    const end = this.parseDate(endDate);

    if (!start || !end) return "Unknown";

    const diffMs = Math.abs(end - start);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays} day${diffDays !== 1 ? "s" : ""}`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours !== 1 ? "s" : ""}`;
    } else if (diffMin > 0) {
      return `${diffMin} minute${diffMin !== 1 ? "s" : ""}`;
    } else {
      return `${diffSec} second${diffSec !== 1 ? "s" : ""}`;
    }
  },

  /**
   * Get yesterday's date
   * @param {string} [format=DEFAULT_FORMAT] - Output format
   * @returns {string} - Yesterday's date as a string
   */
  getYesterday(format = this.DEFAULT_FORMAT) {
    const dateObj = new Date();
    dateObj.setDate(dateObj.getDate() - 1);
    return this.formatDate(dateObj, format);
  },

  /**
   * Format a timestamp as "time ago" (e.g., "2m ago")
   * @param {Date|string} timestamp - The timestamp to format
   * @param {boolean} [abbreviated=false] - Use abbreviated format (2m vs 2 minutes)
   * @returns {string} Formatted "time ago" string
   */
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

    // For abbreviated format, use date if older than a week
    return this.formatForDisplay(date, { dateStyle: "short" });
  },

  /**
   * Format a vehicle speed value with appropriate status indication
   * @param {number} speed - Speed in mph
   * @returns {Object} Object with formatted value and status
   */
  formatVehicleSpeed(speed) {
    if (typeof speed !== "number") {
      speed = parseFloat(speed) || 0;
    }

    let status = "stopped";
    if (speed > 35) {
      status = "fast";
    } else if (speed > 10) {
      status = "medium";
    } else if (speed > 0) {
      status = "slow";
    }

    return {
      value: speed.toFixed(1),
      status: status,
      formatted: `${speed.toFixed(1)} mph`,
      cssClass: `vehicle-${status}`,
    };
  },

  /**
   * Initialize Flatpickr date pickers with standard configuration
   * @param {HTMLElement|string} element - Element or selector to initialize
   * @param {Object} [options={}] - Additional Flatpickr options to merge
   * @returns {Object} - Flatpickr instance
   */
  initDatePicker(element, options = {}) {
    if (!window.flatpickr) {
      console.warn("Flatpickr not loaded, cannot initialize date picker");
      return null;
    }

    const defaultOptions = {
      dateFormat: "Y-m-d",
      allowInput: true,
      errorHandler: (error) => {
        console.warn("Flatpickr error: %s", error);
      },
    };

    // Merge options, with provided options taking precedence
    const mergedOptions = { ...defaultOptions, ...options };

    return flatpickr(element, mergedOptions);
  },
};

/**
 * Centralized error handler for consistent error handling
 * @param {Error|string} error - Error object or message
 * @param {string} context - Context where the error occurred
 * @param {Function} [onComplete] - Optional callback after error handling
 * @returns {Error} The original error for chaining
 */
function handleError(error, context = "", onComplete = null) {
  // Convert string errors to Error objects
  const errorObj = typeof error === "string" ? new Error(error) : error;
  console.error(`Error in ${context}:`, errorObj);

  // Create user-friendly message based on error type
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
  } else if (
    errorObj.message.includes("not found") ||
    errorObj.status === 404
  ) {
    userMessage = "Resource not found: The requested item doesn't exist.";
  } else if (errorObj.status >= 500) {
    userMessage = "Server error: Please try again later.";
  }

  // Show notification to user if notificationManager is available
  if (window.notificationManager) {
    window.notificationManager.show(userMessage, "danger");
  }

  // Execute completion callback if provided
  if (typeof onComplete === "function") {
    onComplete();
  }

  return errorObj;
}

/**
 * NotificationManager - Displays toast notifications
 */
class NotificationManager {
  /**
   * Create a new notification manager
   * @param {Object} [config] - Configuration options
   */
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

  /**
   * Get or create the notification container
   * @returns {HTMLElement} The notification container
   * @private
   */
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

  /**
   * Show a notification
   * @param {string} message - Message to display
   * @param {string} [type='info'] - Notification type (info, success, warning, danger)
   * @param {number} [duration] - Duration in ms to show the notification
   * @returns {HTMLElement} The notification element
   */
  show(message, type = "info", duration = this.config.defaultDuration) {
    // Create notification element
    const notification = document.createElement("div");
    notification.className = `alert alert-${type} alert-dismissible fade show bg-dark text-white`;
    notification.role = "alert";
    notification.innerHTML = `
      ${message}
      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    // Add to container
    this.container.appendChild(notification);

    // Trigger reflow for animation to work
    if (this.config.animations) {
      const _ = notification.offsetHeight; // Force reflow to apply animation classes
    }

    // Track notification
    this.notifications.push(notification);
    this._trimNotifications();

    // Set up auto-removal
    const timeout = setTimeout(() => {
      this._removeNotification(notification);
    }, duration);

    // Handle manual dismissal
    const closeButton = notification.querySelector(".btn-close");
    if (closeButton) {
      closeButton.addEventListener("click", () => {
        clearTimeout(timeout);
        this._removeNotification(notification);
      });
    }

    return notification;
  }

  /**
   * Remove a notification
   * @param {HTMLElement} notification - Notification to remove
   * @private
   */
  _removeNotification(notification) {
    if (!notification || !notification.parentNode) return;

    // Add fade-out class if using animations
    if (this.config.animations) {
      notification.classList.remove("show");

      // Wait for animation before removing
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
        this.notifications = this.notifications.filter(
          (n) => n !== notification
        );
      }, 150);
    } else {
      notification.parentNode.removeChild(notification);
      this.notifications = this.notifications.filter((n) => n !== notification);
    }
  }

  /**
   * Trim notifications to maximum allowed
   * @private
   */
  _trimNotifications() {
    if (this.notifications.length <= this.config.maxNotifications) return;

    const excess = this.notifications.length - this.config.maxNotifications;
    for (let i = 0; i < excess; i++) {
      const oldest = this.notifications.shift();
      if (oldest && oldest.parentNode) {
        oldest.parentNode.removeChild(oldest);
      }
    }
  }

  /**
   * Clear all notifications
   */
  clearAll() {
    // Create a copy to avoid mutation issues during removal
    const notificationsCopy = [...this.notifications];
    notificationsCopy.forEach((notification) => {
      this._removeNotification(notification);
    });
  }
}

/**
 * ConfirmationDialog - Display modal confirmation dialogs
 */
class ConfirmationDialog {
  /**
   * Create a new confirmation dialog manager
   * @param {Object} [config] - Configuration options
   */
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

  /**
   * Create the modal dialog in the DOM
   * @private
   */
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

  /**
   * Show a confirmation dialog
   * @param {Object} options - Dialog options
   * @param {string} [options.title] - Dialog title
   * @param {string} [options.message] - Dialog message
   * @param {string} [options.confirmText] - Text for confirm button
   * @param {string} [options.cancelText] - Text for cancel button
   * @param {string} [options.confirmButtonClass] - Class for confirm button
   * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled
   */
  show(options = {}) {
    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      if (!modalElement) {
        console.error("Confirmation modal not found");
        resolve(false);
        return;
      }

      // Configure the modal
      const title = options.title || this.config.defaultTitle;
      const message = options.message || this.config.defaultMessage;
      const confirmText = options.confirmText || this.config.defaultConfirmText;
      const cancelText = options.cancelText || this.config.defaultCancelText;
      const confirmButtonClass =
        options.confirmButtonClass || this.config.defaultConfirmButtonClass;

      modalElement.querySelector(".modal-title").textContent = title;
      modalElement.querySelector(".modal-body").textContent = message;

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".cancel-btn");

      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;
      }

      if (cancelBtn) {
        cancelBtn.textContent = cancelText;
      }

      // Event handlers
      let cleanup; // Declare cleanup here

      const handleConfirm = () => {
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

      cleanup = () => {
        confirmBtn?.removeEventListener("click", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
      };

      // Attach event listeners
      confirmBtn?.addEventListener("click", handleConfirm);
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);

      // Show the modal
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

  /**
   * Hide the active modal
   */
  hide() {
    if (this.activeModal) {
      this.activeModal.hide();
      this.activeModal = null;
    }
  }
}

// Initialize and expose utility instances
window.notificationManager =
  window.notificationManager || new NotificationManager();
window.confirmationDialog =
  window.confirmationDialog || new ConfirmationDialog();

// Export utilities as namespaces
window.utils = {
  /**
   * Debounce a function
   * @param {Function} func - Function to debounce
   * @param {number} [wait=300] - Wait time in milliseconds
   * @returns {Function} Debounced function
   */
  debounce(func, wait = 300) {
    let timeout = null;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },

  /**
   * Throttle a function
   * @param {Function} func - Function to throttle
   * @param {number} [limit=300] - Limit in milliseconds
   * @returns {Function} Throttled function
   */
  throttle(func, limit = 300) {
    let inThrottle = false;
    return function (...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
    };
  },

  /**
   * Safely access localStorage with error handling
   * @param {string} key - Storage key
   * @param {*} [defaultValue=null] - Default value if key doesn't exist
   * @returns {*} The stored value or default value
   */
  getStorage(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      if (item === null) return defaultValue;

      // Try to parse JSON, return original string if parsing fails
      try {
        return JSON.parse(item);
      } catch (e) {
        return item;
      }
    } catch (error) {
      console.warn(`Error accessing localStorage for key ${key}:`, error);
      return defaultValue;
    }
  },

  /**
   * Safely set localStorage with error handling
   * @param {string} key - Storage key
   * @param {*} value - Value to store
   * @returns {boolean} Success status
   */
  setStorage(key, value) {
    try {
      const valueToStore =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      localStorage.setItem(key, valueToStore);
      return true;
    } catch (error) {
      console.warn(`Error setting localStorage for key ${key}:`, error);
      return false;
    }
  },

  /**
   * Remove item from localStorage with error handling
   * @param {string} key - Storage key
   * @returns {boolean} Success status
   */
  removeStorage(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`Error removing localStorage for key ${key}:`, error);
      return false;
    }
  },

  /**
   * Format trip metrics for display
   * @param {Object} trip - Trip data object
   * @returns {Object} Formatted trip metrics
   */
  formatTripMetrics(trip) {
    if (!trip) return {};

    const startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const endTime = trip.endTime ? new Date(trip.endTime) : null;
    const tripStatus = trip.status || "active";

    // Format duration
    let durationStr = trip.durationFormatted;
    if (!durationStr && startTime) {
      const endTimeToUse =
        tripStatus === "completed" ? endTime : lastUpdate || new Date();
      if (endTimeToUse) {
        const duration = Math.floor((endTimeToUse - startTime) / 1000);
        if (duration >= 0) {
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);
          const seconds = duration % 60;
          durationStr = `${hours}:${minutes
            .toString()
            .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
        } else {
          durationStr = "0:00:00";
        }
      }
    }

    const distance = typeof trip.distance === "number" ? trip.distance : 0;
    const currentSpeed =
      typeof trip.currentSpeed === "number" ? trip.currentSpeed : 0;
    const avgSpeed = typeof trip.avgSpeed === "number" ? trip.avgSpeed : 0;
    const maxSpeed = typeof trip.maxSpeed === "number" ? trip.maxSpeed : 0;
    const pointsRecorded = trip.pointsRecorded || trip.coordinates?.length || 0;

    const speedInfo = DateUtils.formatVehicleSpeed(currentSpeed);

    return {
      startTime: startTime ? DateUtils.formatForDisplay(startTime) : "N/A",
      duration: durationStr || "0:00:00",
      distance: `${distance.toFixed(2)} miles`,
      currentSpeed: speedInfo.formatted,
      speedStatus: speedInfo.status,
      avgSpeed: `${avgSpeed.toFixed(1)} mph`,
      maxSpeed: `${maxSpeed.toFixed(1)} mph`,
      pointsRecorded: pointsRecorded,
      lastUpdate: lastUpdate
        ? DateUtils.formatTimeAgo(lastUpdate, true)
        : "N/A",
      isMoving: currentSpeed > 0,
      isStopped: currentSpeed === 0,
      status: tripStatus,
    };
  },

  /**
   * Adaptive polling utilities
   */
  adaptivePolling: {
    /**
     * Calculate appropriate polling interval based on vehicle status
     * @param {Object} trip - Trip data object
     * @param {boolean} hasNewData - Whether new data was just received
     * @param {number} currentInterval - Current polling interval in ms
     * @param {Object} [options] - Configuration options
     * @returns {number} New polling interval in ms
     */
    calculateInterval(trip, hasNewData, currentInterval, options = {}) {
      const config = {
        minInterval: options.minInterval || 1000,
        maxInterval: options.maxInterval || 10000,
        movingFast: options.movingFast || 1000,
        movingSlow: options.movingSlow || 2000,
        stationaryActive: options.stationaryActive || 3000,
        stationaryIdle: options.stationaryIdle || 5000,
        noTrip: options.noTrip || 7000,
      };

      if (!trip) {
        return Math.min(currentInterval * 1.2, config.noTrip);
      }

      const isMoving = trip.currentSpeed > 2; // Over 2 mph considered moving
      const isFastMoving = trip.currentSpeed > 15; // Over 15 mph is fast

      if (isFastMoving && hasNewData) {
        return config.movingFast;
      } else if (isMoving && hasNewData) {
        return config.movingSlow;
      } else if (isMoving) {
        return Math.max(currentInterval * 0.8, config.movingSlow);
      } else if (hasNewData) {
        return config.stationaryActive;
      } else {
        return Math.min(currentInterval * 1.1, config.stationaryIdle);
      }
    },
  },
};

window.dom = {
  /**
   * Get element by ID with type checking
   * @param {string} id - Element ID
   * @returns {HTMLElement|null} Element or null
   */
  byId(id) {
    return document.getElementById(id);
  },

  /**
   * Query selector with optional context
   * @param {string} selector - CSS selector
   * @param {Element|Document} [context=document] - Context element
   * @returns {Element|null} First matching element or null
   */
  query(selector, context = document) {
    return context.querySelector(selector);
  },

  /**
   * Query all elements matching selector
   * @param {string} selector - CSS selector
   * @param {Element|Document} [context=document] - Context element
   * @returns {Element[]} Array of matching elements
   */
  queryAll(selector, context = document) {
    return Array.from(context.querySelectorAll(selector));
  },

  /**
   * Create an element with attributes and content
   * @param {string} tag - Element tag name
   * @param {Object} [attrs] - Element attributes
   * @param {string|Node|Array} [content] - Element content
   * @returns {HTMLElement} The created element
   */
  create(tag, attrs = {}, content = null) {
    const element = document.createElement(tag);

    // Set attributes
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === "class" || key === "className") {
        element.className = value;
      } else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (key.startsWith("data-")) {
        element.setAttribute(key, value);
      } else {
        element[key] = value;
      }
    });

    // Add content
    if (content) {
      if (Array.isArray(content)) {
        content.forEach((item) => {
          if (item instanceof Node) {
            element.appendChild(item);
          } else {
            element.appendChild(document.createTextNode(String(item)));
          }
        });
      } else if (content instanceof Node) {
        element.appendChild(content);
      } else {
        element.textContent = content;
      }
    }

    return element;
  },
};

// Initialize global utility instances
window.handleError = handleError;
window.DateUtils = DateUtils;

// Initialize and export notification manager
window.notificationManager = new NotificationManager({
  position: "bottom-end",
  defaultDuration: 5000,
  maxNotifications: 3,
});

// Initialize and export confirmation dialog
window.confirmationDialog = new ConfirmationDialog({
  backdropClickDismisses: false,
});

/**
 * DOM Helper utility for handling common DOM operations
 */
class DOMHelper {
  /**
   * Find an element by ID
   * @param {string} id - Element ID
   * @returns {HTMLElement} The found element or null
   */
  static byId(id) {
    return document.getElementById(id);
  }

  /**
   * Query a single element
   * @param {string} selector - CSS selector
   * @param {Element} context - Context element (defaults to document)
   * @returns {Element} The found element or null
   */
  static query(selector, context = document) {
    return context.querySelector(selector);
  }

  /**
   * Query multiple elements
   * @param {string} selector - CSS selector
   * @param {Element} context - Context element (defaults to document)
   * @returns {NodeList} List of found elements
   */
  static queryAll(selector, context = document) {
    return context.querySelectorAll(selector);
  }

  /**
   * Create a new element with attributes and optional content
   * @param {string} tag - HTML tag name
   * @param {Object} attrs - Attributes to set
   * @param {string|Node} content - Content to append
   * @returns {HTMLElement} The created element
   */
  static create(tag, attrs = {}, content = null) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class" || key === "className") {
        el.className = value;
      } else {
        el.setAttribute(key, value);
      }
    }

    if (content) {
      if (typeof content === "string") {
        el.innerHTML = content;
      } else {
        el.appendChild(content);
      }
    }

    return el;
  }
}

// Initialize DOM helper
window.DOMHelper = DOMHelper;
