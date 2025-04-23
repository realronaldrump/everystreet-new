/* global flatpickr, bootstrap */
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
      closeButton.addEventListener("click", (e) => {
        e.stopPropagation();
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
        confirmBtn?.removeEventListener("click", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
      };

      confirmBtn?.addEventListener("click", handleConfirm);
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

window.notificationManager =
  window.notificationManager || new NotificationManager();
window.confirmationDialog =
  window.confirmationDialog || new ConfirmationDialog();

window.handleError = handleError;
window.DateUtils = DateUtils;

window.utils = {
  debounce(func, wait = 300) {
    let timeout = null;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  },

  getStorage(key, defaultValue = null) {
    try {
      const item = localStorage.getItem(key);
      if (item === null) return defaultValue;

      try {
        return JSON.parse(item);
      } catch /* (_e) removed */ {
        return item;
      }
    } catch (error) {
      console.warn(`Error accessing localStorage for key ${key}:`, error);
      return defaultValue;
    }
  },

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

  removeStorage(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn(`Error removing localStorage for key ${key}:`, error);
      return false;
    }
  },
};
