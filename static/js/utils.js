/* global bootstrap */

/**
 * NotificationManager is responsible for showing notifications.
 */
class NotificationManager {
  constructor() {
    // Use the static method to get (or create) the container.
    this.container = NotificationManager._getOrCreateContainer();
  }

  /**
   * Returns the notification container element. Creates one if it doesn't exist.
   * Since this method does not depend on instance state, it is declared static.
   */
  static _getOrCreateContainer() {
    let container = document.querySelector(".notification-container");
    if (!container) {
      container = document.createElement("div");
      container.className =
        "notification-container position-fixed top-0 end-0 p-3";
      document.body.appendChild(container);
    }
    return container;
  }

  /**
   * Displays a notification with the provided message, type, and duration.
   * @param {string} message - The notification message.
   * @param {string} [type="info"] - The Bootstrap alert type (e.g., "info", "success").
   * @param {number} [duration=5000] - Time in milliseconds before the notification is removed.
   */
  show(message, type = "info", duration = 5000) {
    const notificationDiv = document.createElement("div");
    notificationDiv.className = `alert alert-${type} alert-dismissible fade show bg-dark text-white`;
    notificationDiv.innerHTML = `
      ${message}
      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    this.container.appendChild(notificationDiv);
    setTimeout(() => notificationDiv.remove(), duration);
  }
}

/**
 * ConfirmationDialog displays a modal dialog to confirm or cancel an action.
 */
class ConfirmationDialog {
  constructor() {
    this.modalId = "confirmationModal";
    this._createModal();
  }

  /**
   * Creates the modal element and appends it to the document body if it doesn't already exist.
   */
  _createModal() {
    const modalHtml = `
      <div class="modal fade" id="${this.modalId}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content bg-dark text-white">
            <div class="modal-header">
              <h5 class="modal-title"></h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary confirm-btn">Confirm</button>
            </div>
          </div>
        </div>
      </div>
    `;

    if (!document.getElementById(this.modalId)) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(modalHtml, "text/html");
      const modalElement = doc.body.firstElementChild;
      if (modalElement) {
        document.body.appendChild(modalElement);
      }
    }
  }

  /**
   * Displays the confirmation dialog with the specified options.
   * @param {Object} options - Options for the dialog.
   * @param {string} [options.title="Confirm"] - The title of the modal.
   * @param {string} [options.message="Are you sure?"] - The message body.
   * @param {string} [options.confirmText="Confirm"] - Text for the confirm button.
   * @param {string} [options.cancelText="Cancel"] - Text for the cancel button.
   * @param {string} [options.confirmButtonClass="btn-danger"] - Additional CSS class(es) for the confirm button.
   * @returns {Promise<boolean>} Resolves to true if confirmed, false if cancelled.
   */
  show(options = {}) {
    const {
      title = "Confirm",
      message = "Are you sure?",
      confirmText = "Confirm",
      cancelText = "Cancel",
      confirmButtonClass = "btn-danger",
    } = options;

    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      const modal = new bootstrap.Modal(modalElement);

      modalElement.querySelector(".modal-title").textContent = title;
      modalElement.querySelector(".modal-body").textContent = message;

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".btn-secondary");

      confirmBtn.textContent = confirmText;
      cancelBtn.textContent = cancelText;
      confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;

      // Function declarations are hoisted, ensuring that cleanup is defined
      // before it's used in the event handlers.
      function cleanup() {
        confirmBtn.removeEventListener("click", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
      }

      function handleConfirm() {
        cleanup();
        modal.hide();
        resolve(true);
      }

      function handleDismiss() {
        cleanup();
        resolve(false);
      }

      confirmBtn.addEventListener("click", handleConfirm);
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);

      modal.show();
    });
  }
}

// Create global instances
window.notificationManager = new NotificationManager();
window.confirmationDialog = new ConfirmationDialog();
