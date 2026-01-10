/**
 * Unified Modal Manager
 * Consolidates all Bootstrap modal creation and management
 * Replaces 6+ scattered modal implementations
 */

import { createElement } from "./utils.js";

class ModalManager {
  constructor() {
    this.modals = new Map();
    this.modalCounter = 0;
  }

  /**
   * Show a confirmation modal
   */
  async showConfirm(options = {}) {
    const {
      title = "Confirm",
      message = "Are you sure?",
      confirmText = "Confirm",
      cancelText = "Cancel",
      confirmClass = "btn-primary",
      cancelClass = "btn-secondary",
      size = "", // '', 'modal-sm', 'modal-lg', 'modal-xl'
      icon = null,
    } = options;

    return new Promise((resolve) => {
      const modalId = this._generateId("confirm");
      const modal = this._createModal({
        id: modalId,
        title,
        body: this._formatMessage(message, icon),
        size,
        footer: [
          {
            text: cancelText,
            class: `btn ${cancelClass}`,
            dismiss: true,
            callback: () => resolve(false),
          },
          {
            text: confirmText,
            class: `btn ${confirmClass}`,
            dismiss: true,
            callback: () => resolve(true),
          },
        ],
      });

      this._showModal(modal, modalId, () => resolve(false));
    });
  }

  /**
   * Show a prompt modal for text input
   */
  async showPrompt(options = {}) {
    const {
      title = "Enter Value",
      message = "",
      placeholder = "",
      defaultValue = "",
      confirmText = "OK",
      cancelText = "Cancel",
      inputType = "text",
      required = false,
      validator = null,
      size = "",
    } = options;

    return new Promise((resolve) => {
      const modalId = this._generateId("prompt");
      const inputId = `${modalId}-input`;

      const body = createElement(
        "div",
        {},
        [
          message ? createElement("p", { className: "mb-3" }, message) : null,
          createElement("input", {
            type: inputType,
            className: "form-control bg-dark text-white",
            id: inputId,
            placeholder,
            value: defaultValue,
            required,
          }),
        ].filter(Boolean)
      );

      const modal = this._createModal({
        id: modalId,
        title,
        body,
        size,
        footer: [
          {
            text: cancelText,
            class: "btn btn-secondary",
            dismiss: true,
            callback: () => resolve(null),
          },
          {
            text: confirmText,
            class: "btn btn-primary",
            callback: async (_e, _btn) => {
              const input = document.getElementById(inputId);
              const value = input.value.trim();

              if (required && !value) {
                input.classList.add("is-invalid");
                return;
              }

              if (validator) {
                const error = await validator(value);
                if (error) {
                  input.classList.add("is-invalid");
                  const feedback = input.nextElementSibling;
                  if (feedback?.classList.contains("invalid-feedback")) {
                    feedback.textContent = error;
                  } else {
                    const errorDiv = createElement(
                      "div",
                      { className: "invalid-feedback" },
                      error
                    );
                    input.parentNode.insertBefore(errorDiv, input.nextSibling);
                  }
                  return;
                }
              }

              this._dismissModal(modalId);
              resolve(value);
            },
          },
        ],
      });

      this._showModal(modal, modalId, () => resolve(null));

      // Focus input after modal is shown
      setTimeout(() => {
        const input = document.getElementById(inputId);
        if (input) input.focus();
      }, 300);
    });
  }

  /**
   * Show an alert/info modal
   */
  async showAlert(options = {}) {
    const {
      title = "Alert",
      message = "",
      type = "info", // 'info', 'success', 'warning', 'error'
      buttonText = "OK",
      size = "",
    } = options;

    const icons = {
      info: "&#9432;",
      success: "&#10004;",
      warning: "&#9888;",
      error: "&#10008;",
    };

    return new Promise((resolve) => {
      const modalId = this._generateId("alert");
      const modal = this._createModal({
        id: modalId,
        title,
        body: this._formatMessage(message, icons[type]),
        size,
        footer: [
          {
            text: buttonText,
            class: `btn btn-${type === "error" ? "danger" : type === "warning" ? "warning" : "primary"}`,
            dismiss: true,
            callback: () => resolve(true),
          },
        ],
      });

      this._showModal(modal, modalId, () => resolve(true));
    });
  }

  /**
   * Show an error modal
   */
  async showError(message, title = "Error") {
    return this.showAlert({
      title,
      message,
      type: "error",
      buttonText: "Close",
    });
  }

  /**
   * Show a custom modal with full control
   */
  async showCustom(options = {}) {
    const {
      title = "",
      body = "",
      footer = [],
      size = "",
      backdrop = true,
      keyboard = true,
      focus = true,
      onShow = null,
      onHide = null,
    } = options;

    return new Promise((resolve) => {
      const modalId = this._generateId("custom");
      const modal = this._createModal({
        id: modalId,
        title,
        body,
        footer,
        size,
        backdrop,
        keyboard,
        focus,
      });

      this._showModal(modal, modalId, () => {
        if (onHide) onHide();
        resolve(null);
      });

      if (onShow) {
        const modalElement = document.getElementById(modalId);
        modalElement.addEventListener("shown.bs.modal", onShow, { once: true });
      }
    });
  }

  /**
   * Create modal HTML structure
   */
  _createModal(options) {
    const {
      id,
      title,
      body,
      footer = [],
      size = "",
      backdrop = true,
      keyboard = true,
    } = options;

    const footerButtons = footer.map((btn) => {
      const button = createElement(
        "button",
        {
          type: "button",
          className: btn.class || "btn btn-secondary",
          ...(btn.dismiss ? { "data-bs-dismiss": "modal" } : {}),
        },
        btn.text
      );

      if (btn.callback) {
        button.addEventListener("click", (e) => btn.callback(e, button));
      }

      return button;
    });

    const modal = createElement(
      "div",
      {
        className: "modal fade",
        id,
        tabindex: "-1",
        "aria-hidden": "true",
        ...(backdrop === false ? { "data-bs-backdrop": "static" } : {}),
        ...(keyboard === false ? { "data-bs-keyboard": "false" } : {}),
      },
      [
        createElement(
          "div",
          {
            className: `modal-dialog ${size}`,
          },
          [
            createElement(
              "div",
              {
                className: "modal-content bg-dark text-white",
              },
              [
                title
                  ? createElement(
                      "div",
                      {
                        className: "modal-header",
                      },
                      [
                        createElement("h5", { className: "modal-title" }, title),
                        createElement("button", {
                          type: "button",
                          className: "btn-close btn-close-white",
                          "data-bs-dismiss": "modal",
                          "aria-label": "Close",
                        }),
                      ]
                    )
                  : null,
                createElement(
                  "div",
                  {
                    className: "modal-body",
                  },
                  typeof body === "string" ? body : [body]
                ),
                footerButtons.length > 0
                  ? createElement(
                      "div",
                      {
                        className: "modal-footer",
                      },
                      footerButtons
                    )
                  : null,
              ].filter(Boolean)
            ),
          ]
        ),
      ]
    );

    return modal;
  }

  /**
   * Show modal and set up cleanup
   */
  _showModal(modalElement, modalId, onHideCallback) {
    document.body.appendChild(modalElement);

    const bsModal = new window.bootstrap.Modal(modalElement);
    this.modals.set(modalId, bsModal);

    modalElement.addEventListener(
      "hidden.bs.modal",
      () => {
        onHideCallback();
        this._cleanup(modalId);
      },
      { once: true }
    );

    bsModal.show();
  }

  /**
   * Dismiss a modal programmatically
   */
  _dismissModal(modalId) {
    const modal = this.modals.get(modalId);
    if (modal) {
      modal.hide();
    }
  }

  /**
   * Clean up modal after hiding
   */
  _cleanup(modalId) {
    const modal = this.modals.get(modalId);
    if (modal) {
      modal.dispose();
      this.modals.delete(modalId);
    }

    const modalElement = document.getElementById(modalId);
    if (modalElement) {
      modalElement.remove();
    }

    // Remove any remaining backdrops
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      if (!document.querySelector(".modal.show")) {
        backdrop.remove();
      }
    });
  }

  /**
   * Format message with optional icon
   */
  _formatMessage(message, icon) {
    if (!icon) return message;

    return createElement("div", { className: "d-flex align-items-start gap-3" }, [
      createElement(
        "div",
        {
          className: "flex-shrink-0",
          style: "font-size: 2rem;",
        },
        icon
      ),
      createElement("div", { className: "flex-grow-1" }, message),
    ]);
  }

  /**
   * Generate unique modal ID
   */
  _generateId(prefix) {
    return `modal-${prefix}-${++this.modalCounter}-${Date.now()}`;
  }

  /**
   * Close all open modals
   */
  closeAll() {
    this.modals.forEach((modal, _id) => {
      modal.hide();
    });
  }
}

// Create singleton instance
const modalManager = new ModalManager();

// Export both class and singleton
export { ModalManager, modalManager };
export default modalManager;
