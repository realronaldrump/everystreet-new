/**
 * @file Application utilities for error handling, notifications, and UI components
 */

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
      notification.offsetHeight; // Force reflow
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

/**
 * DOM utility functions
 */
const DOM = {
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

/**
 * Common utility functions
 */
const Utils = {
  /**
   * Debounce a function
   * @param {Function} func - Function to debounce
   * @param {number} [wait=300] - Wait time in milliseconds
   * @returns {Function} Debounced function
   */
  debounce(func, wait = 300) {
    let timeout;
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
    let inThrottle;
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
   * Format a date using Intl.DateTimeFormat
   * @param {Date|string|number} date - Date to format
   * @param {string} [locale] - Locale code (defaults to browser locale)
   * @param {Object} [options] - Intl.DateTimeFormat options
   * @returns {string} Formatted date string
   */
  formatDate(date, locale, options = {}) {
    const dateObj = date instanceof Date ? date : new Date(date);
    const defaultOptions = {
      dateStyle: "medium",
      timeStyle: "short",
    };

    return new Intl.DateTimeFormat(locale, {
      ...defaultOptions,
      ...options,
    }).format(dateObj);
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
};

// Initialize and expose utility instances
window.notificationManager = new NotificationManager();
window.confirmationDialog = new ConfirmationDialog();

// Export utilities as namespaces
window.utils = Utils;
window.dom = DOM;
window.handleError = handleError;
