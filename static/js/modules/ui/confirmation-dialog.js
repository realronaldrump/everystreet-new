/* global bootstrap */

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

    // Using .modal-content style from modals.css which uses --surface-1, etc.
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"></h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
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
   * @param {Object} options
   * @returns {Promise<boolean>}
   */
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
      const confirmButtonClass
        = options.confirmButtonClass || this.config.defaultConfirmButtonClass;
      const showCancel = options.showCancel !== false; // Default true

      modalElement.querySelector(".modal-title").textContent = title;
      modalElement.querySelector(".modal-body").innerHTML = message;

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".cancel-btn");

      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;
        confirmBtn.style.display = ""; // Ensure visible
      }

      if (cancelBtn) {
        cancelBtn.textContent = cancelText;
        cancelBtn.style.display = showCancel ? "" : "none";
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

      const handleHide = () => {
        const focusedElement = modalElement.querySelector(":focus");
        if (focusedElement) {
          focusedElement.blur();
        }
      };

      function cleanup() {
        confirmBtn?.removeEventListener("mousedown", handleConfirm);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
        modalElement.removeEventListener("hide.bs.modal", handleHide);
      }

      confirmBtn?.addEventListener("mousedown", (e) => {
        if (e.button !== 0) {
          return;
        }
        handleConfirm();
      });
      // Handle Enter key on the modal
      const keyHandler = (e) => {
        if (e.key === "Enter" && this.activeModal && modalElement.classList.contains("show")) {
          e.preventDefault();
          handleConfirm();
          modalElement.removeEventListener("keydown", keyHandler);
        }
      };
      modalElement.addEventListener("keydown", keyHandler);
      
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);
      modalElement.addEventListener("hide.bs.modal", handleHide);

      try {
        this.activeModal = new bootstrap.Modal(modalElement);
        modalElement.removeAttribute("aria-hidden");
        this.activeModal.show();
        // Focus confirm button by default for a11y/usability
        setTimeout(() => confirmBtn?.focus(), 100);
      } catch (error) {
        console.error("Error showing modal:", error);
        cleanup();
        resolve(false);
      }
    });
  }

  /**
   * Show an alert dialog (no cancel option)
   * @param {string|Object} messageOrOptions - Message string or options object
   * @returns {Promise<void>}
   */
  async alert(messageOrOptions) {
    const options = typeof messageOrOptions === "string"
      ? { message: messageOrOptions }
      : messageOrOptions;
    
    await this.show({
      title: "Alert",
      confirmText: "OK",
      confirmButtonClass: "btn-primary",
      showCancel: false,
      ...options
    });
  }

  hide() {
    if (this.activeModal) {
      this.activeModal.hide();
      this.activeModal = null;
    }
  }
}

const confirmationDialog = new ConfirmationDialog();

const confirm = (options = {}) => confirmationDialog.show(options);
const alert = (messageOrOptions) => confirmationDialog.alert(messageOrOptions);

export { ConfirmationDialog, confirmationDialog, confirm, alert };
export default confirmationDialog;
