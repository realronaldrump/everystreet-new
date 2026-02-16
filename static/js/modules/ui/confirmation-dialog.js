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
    this.hasDom = typeof document !== "undefined" && Boolean(document.body);
    if (!this.hasDom) {
      return;
    }
    this._createModal();
  }

  _createModal() {
    if (!this.hasDom) {
      return;
    }

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

  _blurModalFocus(modalElement) {
    if (!this.hasDom || !modalElement) {
      return;
    }
    const activeElement = document.activeElement;
    if (
      activeElement &&
      modalElement.contains(activeElement) &&
      typeof activeElement.blur === "function"
    ) {
      activeElement.blur();
    }
  }

  /**
   * Show a confirmation dialog
   * @param {Object} options
   * @param {boolean} [options.allowHtml=false] - Render message as HTML when true
   * @returns {Promise<boolean>}
   */
  show(options = {}) {
    if (!this.hasDom) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      if (!modalElement) {
        console.error("Confirmation modal not found");
        resolve(false);
        return;
      }

      const title = options.title || this.config.defaultTitle;
      const message = options.message ?? this.config.defaultMessage;
      const allowHtml = options.allowHtml === true;
      const confirmText = options.confirmText || this.config.defaultConfirmText;
      const cancelText = options.cancelText || this.config.defaultCancelText;
      const confirmButtonClass =
        options.confirmButtonClass || this.config.defaultConfirmButtonClass;
      const showCancel = options.showCancel !== false; // Default true

      modalElement.querySelector(".modal-title").textContent = title;
      const modalBody = modalElement.querySelector(".modal-body");
      if (modalBody) {
        if (allowHtml) {
          modalBody.innerHTML = String(message);
        } else {
          modalBody.textContent = String(message);
        }
      }

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
        this._blurModalFocus(modalElement);
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
        this._blurModalFocus(modalElement);
      };

      const handleClick = () => {
        handleConfirm();
      };

      const handleKeyDown = (e) => {
        if (
          e.key === "Enter" &&
          this.activeModal &&
          modalElement.classList.contains("show")
        ) {
          e.preventDefault();
          handleConfirm();
        }
      };

      function cleanup() {
        confirmBtn?.removeEventListener("click", handleClick);
        modalElement.removeEventListener("keydown", handleKeyDown);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
        modalElement.removeEventListener("hide.bs.modal", handleHide);
      }

      confirmBtn?.addEventListener("click", handleClick);
      modalElement.addEventListener("keydown", handleKeyDown);

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
    if (!this.hasDom) {
      return;
    }

    const options =
      typeof messageOrOptions === "string"
        ? { message: messageOrOptions }
        : messageOrOptions;

    await this.show({
      title: "Alert",
      confirmText: "OK",
      confirmButtonClass: "btn-primary",
      showCancel: false,
      ...options,
    });
  }

  /**
   * Show a prompt dialog (text input)
   * @param {Object} options
   * @returns {Promise<string|null>}
   */
  prompt(options = {}) {
    if (!this.hasDom) {
      return Promise.resolve(null);
    }

    return new Promise((resolve) => {
      const modalElement = document.getElementById(this.modalId);
      if (!modalElement) {
        console.error("Confirmation modal not found");
        resolve(null);
        return;
      }

      const title = options.title || this.config.defaultTitle;
      const message = options.message || "";
      const inputLabel = options.inputLabel || "Input";
      const defaultValue = options.defaultValue ?? "";
      const placeholder = options.placeholder || "";
      const confirmText = options.confirmText || this.config.defaultConfirmText;
      const cancelText = options.cancelText || this.config.defaultCancelText;
      const confirmButtonClass =
        options.confirmButtonClass || this.config.defaultConfirmButtonClass;
      const showCancel = options.showCancel !== false; // Default true
      const allowEmpty = options.allowEmpty === true;
      const inputType = options.inputType || "text";
      const { maxLength } = options;

      modalElement.querySelector(".modal-title").textContent = title;

      const body = modalElement.querySelector(".modal-body");
      body.replaceChildren();

      if (message) {
        const messageEl = document.createElement("p");
        messageEl.className = "mb-3";
        messageEl.textContent = message;
        body.appendChild(messageEl);
      }

      const inputWrapper = document.createElement("div");
      inputWrapper.className = "mb-2";

      const labelEl = document.createElement("label");
      const inputId = `${this.modalId}-input`;
      labelEl.className = "form-label";
      labelEl.setAttribute("for", inputId);
      labelEl.textContent = inputLabel;
      inputWrapper.appendChild(labelEl);

      const inputEl = document.createElement("input");
      inputEl.className = "form-control";
      inputEl.id = inputId;
      inputEl.type = inputType;
      inputEl.value = defaultValue;
      if (placeholder) {
        inputEl.placeholder = placeholder;
      }
      if (typeof maxLength === "number") {
        inputEl.maxLength = maxLength;
      }
      inputWrapper.appendChild(inputEl);
      body.appendChild(inputWrapper);

      const confirmBtn = modalElement.querySelector(".confirm-btn");
      const cancelBtn = modalElement.querySelector(".cancel-btn");

      if (confirmBtn) {
        confirmBtn.textContent = confirmText;
        confirmBtn.className = `btn confirm-btn ${confirmButtonClass}`;
        confirmBtn.style.display = "";
        confirmBtn.disabled = !allowEmpty && !inputEl.value.trim();
      }

      if (cancelBtn) {
        cancelBtn.textContent = cancelText;
        cancelBtn.style.display = showCancel ? "" : "none";
      }

      const handleConfirm = () => {
        const value = inputEl.value.trim();
        if (!allowEmpty && !value) {
          inputEl.focus();
          return;
        }
        this._blurModalFocus(modalElement);
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

      const handleHide = () => {
        this._blurModalFocus(modalElement);
      };

      const handleClick = () => {
        if (confirmBtn?.disabled) {
          return;
        }
        handleConfirm();
      };

      const handleKeyDown = (e) => {
        if (
          e.key === "Enter" &&
          this.activeModal &&
          modalElement.classList.contains("show")
        ) {
          e.preventDefault();
          handleConfirm();
        }
      };

      const handleInput = () => {
        if (!confirmBtn) {
          return;
        }
        confirmBtn.disabled = !allowEmpty && !inputEl.value.trim();
      };

      function cleanup() {
        confirmBtn?.removeEventListener("click", handleClick);
        inputEl.removeEventListener("input", handleInput);
        modalElement.removeEventListener("keydown", handleKeyDown);
        modalElement.removeEventListener("hidden.bs.modal", handleDismiss);
        modalElement.removeEventListener("hide.bs.modal", handleHide);
      }

      confirmBtn?.addEventListener("click", handleClick);
      inputEl.addEventListener("input", handleInput);
      modalElement.addEventListener("keydown", handleKeyDown);
      modalElement.addEventListener("hidden.bs.modal", handleDismiss);
      modalElement.addEventListener("hide.bs.modal", handleHide);

      try {
        this.activeModal = new bootstrap.Modal(modalElement);
        modalElement.removeAttribute("aria-hidden");
        this.activeModal.show();
        setTimeout(() => {
          inputEl.focus();
          inputEl.select();
        }, 100);
      } catch (error) {
        console.error("Error showing modal:", error);
        cleanup();
        resolve(null);
      }
    });
  }

  hide() {
    if (this.activeModal) {
      const modalElement = document.getElementById(this.modalId);
      this._blurModalFocus(modalElement);
      this.activeModal.hide();
      this.activeModal = null;
    }
  }
}

const confirmationDialog = new ConfirmationDialog();

const confirm = (options = {}) => confirmationDialog.show(options);
const alert = (messageOrOptions) => confirmationDialog.alert(messageOrOptions);
const prompt = (options = {}) => confirmationDialog.prompt(options);

export { ConfirmationDialog, confirmationDialog, confirm, alert, prompt };
export default confirmationDialog;
