/**
 * Export Manager
 * Main orchestrator for all export functionality
 * Coordinates modules and handles initialization
 */

import { buildExportUrl } from "./api.js";
import { EXPORT_CONFIG, EXPORT_TIMEOUT_MS } from "./config.js";
import { downloadFile } from "./download.js";
import {
  validateLocation,
  validateLocationInput,
} from "./location-validator.js";
import { loadSavedExportSettings, saveExportSettings } from "./settings.js";
import {
  cacheElements,
  initDatePickers,
  setButtonLoading,
  updateUIBasedOnFormat,
} from "./ui.js";
import { initUndrivenStreetsExport } from "./undriven-streets.js";

/**
 * ExportManager class
 * Manages all export functionality for the export page
 */
class ExportManager {
  constructor() {
    /** @type {Object} Cached DOM elements */
    this.elements = {};

    /** @type {Object} Track active export operations */
    this.activeExports = {};
  }

  /**
   * Initialize the export manager
   */
  init() {
    this.elements = cacheElements();
    this.initEventListeners();
    initDatePickers(this.elements);
    loadSavedExportSettings(this.elements, (format) =>
      updateUIBasedOnFormat(format, this.elements),
    );
    initUndrivenStreetsExport();

    // Initialize CSV options visibility
    const formatSelect = document.getElementById("adv-format");
    if (formatSelect) {
      updateUIBasedOnFormat(formatSelect.value, this.elements);
    }
  }

  /**
   * Initialize event listeners for export forms
   */
  initEventListeners() {
    // Form submit handlers
    Object.keys(EXPORT_CONFIG).forEach((formKey) => {
      const form = this.elements[EXPORT_CONFIG[formKey].id];
      if (form) {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          this.handleFormSubmit(formKey);
        });
      }
    });

    // Validate location button handlers
    this.elements.validateButtons?.forEach((button) => {
      button.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        const targetId = event.currentTarget.dataset.target;
        if (targetId) {
          validateLocation(targetId);
        }
      });
    });

    // Export all dates checkbox handler
    if (this.elements.exportAllDates) {
      this.elements.exportAllDates.addEventListener("change", (event) => {
        const { checked } = event.target;
        const startDateInput = document.getElementById("adv-start-date");
        const endDateInput = document.getElementById("adv-end-date");

        if (startDateInput && endDateInput) {
          startDateInput.disabled = checked;
          endDateInput.disabled = checked;
        }
      });
    }

    // Format select change handler
    const formatSelect = document.getElementById("adv-format");
    if (formatSelect) {
      formatSelect.addEventListener("change", (event) => {
        updateUIBasedOnFormat(event.target.value, this.elements);
      });
    }
  }

  /**
   * Handle form submission for an export type
   * @param {string} formType - Type of export form
   */
  async handleFormSubmit(formType) {
    // Skip undrivenStreets, handled by its own handler
    if (formType === "undrivenStreets") {
      return;
    }

    const config = EXPORT_CONFIG[formType];
    if (!config) {
      return;
    }

    // Prevent duplicate exports
    if (this.activeExports[formType]) {
      window.notificationManager?.show(
        `Already exporting ${config.name}. Please wait...`,
        "info",
      );
      return;
    }

    const formElement = this.elements[config.id];
    if (!formElement) {
      return;
    }

    const submitButton = formElement.querySelector('button[type="submit"]');
    const originalText = setButtonLoading(
      submitButton,
      true,
      `Export ${config.name}`,
    );

    try {
      this.activeExports[formType] = true;
      window.notificationManager?.show(
        `Starting ${config.name} export...`,
        "info",
      );

      const url = buildExportUrl(
        formType,
        config,
        this.elements,
        validateLocationInput,
        () => saveExportSettings(this.elements),
      );

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
        window.handleError?.(
          `Export operation timed out after ${EXPORT_TIMEOUT_MS / 1000} seconds: ${config.name}`,
        );
      }, EXPORT_TIMEOUT_MS);

      try {
        await downloadFile(url, config.name, abortController.signal);
        window.notificationManager?.show(
          `${config.name} export completed`,
          "success",
        );
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      console.error("Export error:", error);
      window.notificationManager?.show(
        `Export failed: ${error.message || "Unknown error"}`,
        "error",
      );
    } finally {
      this.activeExports[formType] = false;
      setButtonLoading(submitButton, false, originalText);
    }
  }
}

// Create singleton instance
const exportManager = new ExportManager();

// Initialize on DOM content loaded
document.addEventListener("DOMContentLoaded", () => {
  exportManager.init();
});

// Expose validateLocation globally for inline onclick handlers
window.validateLocation = validateLocation;

// Export for module usage
export { ExportManager, exportManager };
export default exportManager;
