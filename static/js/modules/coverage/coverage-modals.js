/**
 * Coverage Modals
 * Handles modal dialogs, tooltips, and confirmation dialogs
 */

/* global bootstrap */

/**
 * Class to manage modal dialogs and tooltips for coverage functionality
 */
export class CoverageModals {
  /**
   * @param {Object} notificationManager - Notification manager for displaying messages
   */
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
  }

  /**
   * Show enhanced confirmation dialog
   * @param {Object} options - Dialog options
   * @param {string} options.title - Dialog title
   * @param {string} options.message - Dialog message
   * @param {string} options.details - Additional details (optional)
   * @param {string} options.confirmText - Confirm button text
   * @param {string} options.cancelText - Cancel button text
   * @param {string} options.confirmButtonClass - CSS class for confirm button
   * @returns {Promise<boolean>} Resolves to true if confirmed, false otherwise
   */
  showEnhancedConfirmDialog(options) {
    return new Promise((resolve) => {
      const modalHtml = `
        <div class="modal fade" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content bg-dark text-white">
              <div class="modal-header">
                <h5 class="modal-title">${options.title || "Confirm Action"}</h5>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <div class="modal-body">
                <p>${options.message || "Are you sure?"}</p>
                ${
                  options.details
                    ? `<small class="text-muted">${options.details}</small>`
                    : ""
                }
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                  ${options.cancelText || "Cancel"}
                </button>
                <button type="button" class="btn ${
                  options.confirmButtonClass || "btn-primary"
                }" data-action="confirm">
                  ${options.confirmText || "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      const modalElement = document.createElement("div");
      modalElement.innerHTML = modalHtml;
      const modal = modalElement.firstElementChild;
      document.body.appendChild(modal);

      const bsModal = new bootstrap.Modal(modal);

      modal.addEventListener("click", (e) => {
        if (e.target.matches('[data-action="confirm"]')) {
          resolve(true);
          bsModal.hide();
        }
      });

      modal.addEventListener("hidden.bs.modal", () => {
        resolve(false);
        modal.remove();
      });

      bsModal.show();
    });
  }

  /**
   * Show segment length/match settings modal
   * @param {string} locationName - Location name for the modal title
   * @param {Object} defaults - Default values for the settings
   * @param {number} defaults.segment - Default segment length
   * @param {number} defaults.buffer - Default match buffer
   * @param {number} defaults.min - Default minimum match
   * @returns {Promise<Object|null>} Settings object or null if cancelled
   */
  askMatchSettings(
    locationName,
    defaults = { segment: 300, buffer: 50, min: 15 },
  ) {
    return new Promise((resolve) => {
      const modalEl = document.getElementById("segmentLengthModal");
      if (!modalEl) {
        resolve(null);
        return;
      }

      const segEl = modalEl.querySelector("#segment-length-modal-input");
      const bufEl = modalEl.querySelector("#modal-match-buffer");
      const minEl = modalEl.querySelector("#modal-min-match");
      const titleEl = modalEl.querySelector(".modal-title");
      const confirmBtn = modalEl.querySelector("#segment-length-confirm-btn");
      const cancelBtn = modalEl.querySelector("#segment-length-cancel-btn");

      if (segEl) segEl.value = defaults.segment;
      if (bufEl) bufEl.value = defaults.buffer;
      if (minEl) minEl.value = defaults.min;
      if (titleEl)
        titleEl.textContent = `Re-segment Streets for ${locationName}`;

      const bsModal = new bootstrap.Modal(modalEl, { backdrop: "static" });

      function onConfirm() {
        const segVal = parseInt(segEl?.value, 10);
        const bufVal = parseFloat(bufEl?.value);
        const minVal = parseFloat(minEl?.value);
        cleanup();
        bsModal.hide();
        if (
          Number.isNaN(segVal) ||
          segVal <= 0 ||
          Number.isNaN(bufVal) ||
          bufVal <= 0 ||
          Number.isNaN(minVal) ||
          minVal <= 0
        ) {
          resolve(null);
        } else {
          resolve({ segment: segVal, buffer: bufVal, min: minVal });
        }
      }

      function onCancel() {
        cleanup();
        resolve(null);
      }

      function cleanup() {
        confirmBtn?.removeEventListener("click", onConfirm);
        cancelBtn?.removeEventListener("click", onCancel);
        modalEl.removeEventListener("hidden.bs.modal", onCancel);
      }

      confirmBtn?.addEventListener("click", onConfirm);
      cancelBtn?.addEventListener("click", onCancel);
      modalEl.addEventListener("hidden.bs.modal", onCancel);

      bsModal.show();
    });
  }

  /**
   * Reset modal state to defaults
   * @param {Object} validator - Validator module to reset
   * @param {Object} _drawing - Drawing module (reserved for future use)
   * @param {Function} handleTypeChange - Function to handle area definition type change
   */
  resetModalState(validator, _drawing, handleTypeChange) {
    const locationRadio = document.getElementById("area-type-location");
    if (locationRadio) {
      locationRadio.checked = true;
      if (handleTypeChange) {
        handleTypeChange("location");
      }
    }

    const locationInput = document.getElementById("location-input");
    const customAreaName = document.getElementById("custom-area-name");

    if (locationInput) {
      locationInput.value = "";
      locationInput.classList.remove("is-valid", "is-invalid");
    }

    if (customAreaName) {
      customAreaName.value = "";
    }

    if (validator) {
      validator.resetValidationState();
    }
  }

  /**
   * Initialize Bootstrap tooltips
   */
  initTooltips() {
    const tooltipTriggerList = document.querySelectorAll(
      '[data-bs-toggle="tooltip"]',
    );
    tooltipTriggerList.forEach((tooltipTriggerEl) => {
      const existing = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
      if (existing) existing.dispose();
      new bootstrap.Tooltip(tooltipTriggerEl, {
        animation: true,
        delay: { show: 500, hide: 100 },
        html: true,
        placement: "auto",
      });
    });
  }

  /**
   * Setup accessibility features
   */
  setupAccessibility() {
    const liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.className = "visually-hidden";
    liveRegion.id = "coverage-live-region";
    document.body.appendChild(liveRegion);

    const table = document.getElementById("coverage-areas-table");
    if (table) {
      table.setAttribute("role", "table");
      table.setAttribute("aria-label", "Coverage areas data");
    }
  }

  /**
   * Setup theme change listener
   * @param {Object} coverageMap - Coverage map module
   * @param {Object} drawing - Drawing module
   */
  setupThemeListener(coverageMap, drawing) {
    if (typeof MutationObserver !== "undefined") {
      const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "data-bs-theme"
          ) {
            const newTheme =
              document.documentElement.getAttribute("data-bs-theme");
            if (coverageMap) coverageMap.updateTheme(newTheme);
            if (drawing) drawing.updateTheme(newTheme);
          }
        });
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });
    }
  }
}
