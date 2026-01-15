/**
 * Modern Export Manager
 * Handles all export functionality with clean, unified UI
 */

import { onPageLoad } from "../utils.js";

class ExportManager {
  constructor() {
    this.exportType = "trips";
    this.coverageAreas = [];
    this.elements = {};
    this.isExporting = false;
  }

  /**
   * Initialize the export manager
   */
  init({ signal } = {}) {
    this.cacheElements();
    this.attachEventListeners(signal);
    this.loadCoverageAreas();
    this.initDateDefaults();
  }

  /**
   * Cache DOM elements
   */
  cacheElements() {
    // Export type selectors
    this.elements.exportTypeRadios = document.querySelectorAll(
      'input[name="export-type"]',
    );

    // Form containers
    this.elements.formTrips = document.getElementById("form-trips");
    this.elements.formStreets = document.getElementById("form-streets");
    this.elements.formBoundaries = document.getElementById("form-boundaries");
    this.elements.formUndriven = document.getElementById("form-undriven");

    // Trips form elements
    this.elements.tripsStartDate = document.getElementById("trips-start-date");
    this.elements.tripsEndDate = document.getElementById("trips-end-date");
    this.elements.tripsFormatRadios = document.querySelectorAll(
      'input[name="trips-format"]',
    );
    this.elements.tripsFieldConfig =
      document.getElementById("trips-field-config");
    this.elements.tripsToggleFields = document.getElementById(
      "trips-toggle-fields",
    );
    this.elements.tripsFieldsPanel =
      document.getElementById("trips-fields-panel");
    this.elements.tripsPreview = document.getElementById("trips-preview");

    // Streets form elements
    this.elements.streetsArea = document.getElementById("streets-area");
    this.elements.streetsStatus = document.getElementById("streets-status");
    this.elements.streetsFormatRadios = document.querySelectorAll(
      'input[name="streets-format"]',
    );
    this.elements.streetsPreview = document.getElementById("streets-preview");

    // Boundaries form elements
    this.elements.boundariesArea = document.getElementById("boundaries-area");
    this.elements.boundariesFormatRadios = document.querySelectorAll(
      'input[name="boundaries-format"]',
    );
    this.elements.boundariesPreview =
      document.getElementById("boundaries-preview");

    // Undriven form elements
    this.elements.undrivenArea = document.getElementById("undriven-area");
    this.elements.undrivenFormatRadios = document.querySelectorAll(
      'input[name="undriven-format"]',
    );
    this.elements.undrivenPreview = document.getElementById("undriven-preview");

    // Export button and progress
    this.elements.exportForm = document.getElementById("export-form");
    this.elements.exportButton = document.getElementById("export-button");
    this.elements.exportProgress = document.getElementById("export-progress");
    this.elements.exportProgressBar =
      this.elements.exportProgress?.querySelector(".progress-bar");
    this.elements.exportStatus = document.getElementById("export-status");

    // Field checkboxes
    this.elements.fieldBasic = document.getElementById("field-basic");
    this.elements.fieldLocations = document.getElementById("field-locations");
    this.elements.fieldTelemetry = document.getElementById("field-telemetry");
    this.elements.fieldGeometry = document.getElementById("field-geometry");
    this.elements.fieldMetadata = document.getElementById("field-metadata");
    this.elements.fieldCustom = document.getElementById("field-custom");
  }

  /**
   * Attach event listeners
   */
  attachEventListeners(signal) {
    const options = signal ? { signal } : undefined;

    // Export type change
    this.elements.exportTypeRadios.forEach((radio) => {
      radio.addEventListener(
        "change",
        (e) => {
          this.exportType = e.target.value;
          this.switchExportForm(this.exportType);
          this.updatePreview();
        },
        options,
      );
    });

    // Format change listeners
    this.elements.tripsFormatRadios?.forEach((radio) => {
      radio.addEventListener(
        "change",
        () => {
          const format = this.getSelectedFormat("trips");
          this.toggleFieldConfig(format === "csv");
          this.updatePreview();
        },
        options,
      );
    });

    // Field toggle button
    this.elements.tripsToggleFields?.addEventListener(
      "click",
      () => {
        const isVisible =
          this.elements.tripsFieldsPanel.style.display !== "none";
        this.elements.tripsFieldsPanel.style.display = isVisible
          ? "none"
          : "block";
      },
      options,
    );

    // Field checkboxes
    [
      this.elements.fieldBasic,
      this.elements.fieldLocations,
      this.elements.fieldTelemetry,
      this.elements.fieldGeometry,
      this.elements.fieldMetadata,
      this.elements.fieldCustom,
    ].forEach((checkbox) => {
      checkbox?.addEventListener("change", () => this.updatePreview(), options);
    });

    // Date inputs
    [this.elements.tripsStartDate, this.elements.tripsEndDate].forEach(
      (input) => {
        input?.addEventListener("change", () => this.updatePreview(), options);
      },
    );

    // Area selectors
    [
      this.elements.streetsArea,
      this.elements.boundariesArea,
      this.elements.undrivenArea,
      this.elements.streetsStatus,
    ].forEach((select) => {
      select?.addEventListener("change", () => this.updatePreview(), options);
    });

    // Form submit
    this.elements.exportForm?.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        this.handleExport();
      },
      options,
    );
  }

  /**
   * Switch between export forms
   */
  switchExportForm(type) {
    // Hide all forms
    [
      this.elements.formTrips,
      this.elements.formStreets,
      this.elements.formBoundaries,
      this.elements.formUndriven,
    ].forEach((form) => {
      if (form) form.style.display = "none";
    });

    // Show selected form
    const formMap = {
      trips: this.elements.formTrips,
      streets: this.elements.formStreets,
      boundaries: this.elements.formBoundaries,
      undriven: this.elements.formUndriven,
    };

    const targetForm = formMap[type];
    if (targetForm) {
      targetForm.style.display = "block";
    }
  }

  /**
   * Toggle field configuration panel
   */
  toggleFieldConfig(show) {
    if (this.elements.tripsFieldConfig) {
      this.elements.tripsFieldConfig.style.display = show ? "block" : "none";
    }
  }

  /**
   * Get selected format for export type
   */
  getSelectedFormat(type) {
    const radioMap = {
      trips: this.elements.tripsFormatRadios,
      streets: this.elements.streetsFormatRadios,
      boundaries: this.elements.boundariesFormatRadios,
      undriven: this.elements.undrivenFormatRadios,
    };

    const radios = radioMap[type];
    if (!radios) return "geojson";

    const selected = Array.from(radios).find((r) => r.checked);
    return selected ? selected.value : "geojson";
  }

  /**
   * Load coverage areas
   */
  async loadCoverageAreas() {
    try {
      const response = await fetch("/api/coverage/areas");
      if (!response.ok) throw new Error("Failed to load coverage areas");

      const data = await response.json();
      this.coverageAreas = data.areas || [];

      // Populate dropdowns
      this.populateAreaDropdown(this.elements.streetsArea);
      this.populateAreaDropdown(this.elements.boundariesArea);
      this.populateAreaDropdown(this.elements.undrivenArea);
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      window.notificationManager?.show(
        "Failed to load coverage areas",
        "error",
      );
    }
  }

  /**
   * Populate area dropdown
   */
  populateAreaDropdown(select) {
    if (!select) return;

    select.innerHTML = '<option value="">Select an area...</option>';

    this.coverageAreas.forEach((area) => {
      const option = document.createElement("option");
      option.value = area.id;
      option.textContent = area.display_name;
      if (area.status !== "ready") {
        option.disabled = true;
        option.textContent += ` (${area.status})`;
      }
      select.appendChild(option);
    });
  }

  /**
   * Initialize date defaults (last 30 days)
   */
  initDateDefaults() {
    if (!this.elements.tripsStartDate || !this.elements.tripsEndDate) return;

    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);

    this.elements.tripsStartDate.valueAsDate = thirtyDaysAgo;
    this.elements.tripsEndDate.valueAsDate = today;
    this.updatePreview();
  }

  /**
   * Update export preview
   */
  updatePreview() {
    const previewMap = {
      trips: this.elements.tripsPreview,
      streets: this.elements.streetsPreview,
      boundaries: this.elements.boundariesPreview,
      undriven: this.elements.undrivenPreview,
    };

    const preview = previewMap[this.exportType];
    if (!preview) return;

    let message = "";

    if (this.exportType === "trips") {
      const start = this.elements.tripsStartDate?.value;
      const end = this.elements.tripsEndDate?.value;
      const format = this.getSelectedFormat("trips");

      if (start && end) {
        const fields = this.getSelectedFieldGroups();
        message = `<h6>Ready to export</h6><p>Trips from ${start} to ${end} in ${format.toUpperCase()} format`;
        if (format === "csv" && fields.length > 0) {
          message += ` with ${fields.length} field group${fields.length > 1 ? "s" : ""}`;
        }
        message += `</p>`;
      }
    } else {
      const areaSelect = {
        streets: this.elements.streetsArea,
        boundaries: this.elements.boundariesArea,
        undriven: this.elements.undrivenArea,
      }[this.exportType];

      const selectedAreaId = areaSelect?.value;
      if (selectedAreaId) {
        const area = this.coverageAreas.find((a) => a.id === selectedAreaId);
        const format = this.getSelectedFormat(this.exportType);

        if (area) {
          message = `<h6>Ready to export</h6><p>${area.display_name}`;

          if (
            this.exportType === "streets" &&
            this.elements.streetsStatus?.value
          ) {
            message += ` (${this.elements.streetsStatus.value} only)`;
          }

          message += ` in ${format.toUpperCase()} format</p>`;

          if (this.exportType === "undriven" && area.total_segments) {
            const undrivenCount =
              area.total_segments - (area.driven_segments || 0);
            message += `<p class="mb-0"><small>${undrivenCount} undriven segment${undrivenCount !== 1 ? "s" : ""}</small></p>`;
          }
        }
      }
    }

    if (message) {
      preview.innerHTML = message;
      preview.classList.add("show");
    } else {
      preview.classList.remove("show");
    }
  }

  /**
   * Get selected field groups
   */
  getSelectedFieldGroups() {
    const fields = [];
    if (this.elements.fieldBasic?.checked) fields.push("basic");
    if (this.elements.fieldLocations?.checked) fields.push("locations");
    if (this.elements.fieldTelemetry?.checked) fields.push("telemetry");
    if (this.elements.fieldGeometry?.checked) fields.push("geometry");
    if (this.elements.fieldMetadata?.checked) fields.push("metadata");
    if (this.elements.fieldCustom?.checked) fields.push("custom");
    return fields;
  }

  /**
   * Build export URL
   */
  buildExportURL() {
    const format = this.getSelectedFormat(this.exportType);
    const params = new URLSearchParams();
    params.set("fmt", format);

    if (this.exportType === "trips") {
      const start = this.elements.tripsStartDate?.value;
      const end = this.elements.tripsEndDate?.value;

      if (!start || !end) {
        throw new Error("Please select start and end dates");
      }

      params.set("start_date", start);
      params.set("end_date", end);

      // Add field groups for CSV
      if (format === "csv") {
        const fields = this.getSelectedFieldGroups();
        if (fields.length > 0) {
          params.set("fields", fields.join(","));
        }
      }

      return `/api/export/trips?${params.toString()}`;
    } else if (this.exportType === "streets") {
      const areaId = this.elements.streetsArea?.value;
      if (!areaId) throw new Error("Please select a coverage area");

      const statusFilter = this.elements.streetsStatus?.value;
      if (statusFilter) {
        params.set("status_filter", statusFilter);
      }

      return `/api/export/streets/${areaId}?${params.toString()}`;
    } else if (this.exportType === "boundaries") {
      const areaId = this.elements.boundariesArea?.value;
      if (!areaId) throw new Error("Please select a coverage area");

      return `/api/export/boundaries/${areaId}?${params.toString()}`;
    } else if (this.exportType === "undriven") {
      const areaId = this.elements.undrivenArea?.value;
      if (!areaId) throw new Error("Please select a coverage area");

      return `/api/export/undriven-streets/${areaId}?${params.toString()}`;
    }

    throw new Error("Invalid export type");
  }

  /**
   * Handle export
   */
  async handleExport() {
    if (this.isExporting) return;

    try {
      this.isExporting = true;
      this.setButtonLoading(true);
      this.showProgress(true, "Preparing export...");

      const url = this.buildExportURL();

      // Start download
      await this.downloadFile(url);

      window.notificationManager?.show(
        "Export completed successfully",
        "success",
      );
      this.showProgress(false);
    } catch (error) {
      console.error("Export error:", error);
      window.notificationManager?.show(
        error.message || "Export failed. Please try again.",
        "error",
      );
      this.showProgress(false);
    } finally {
      this.isExporting = false;
      this.setButtonLoading(false);
    }
  }

  /**
   * Download file with progress tracking
   */
  async downloadFile(url) {
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `Export failed with status ${response.status}`);
    }

    // Get filename from headers or generate one
    const contentDisposition = response.headers.get("Content-Disposition");
    let filename = "export.dat";
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    // Get content length for progress tracking
    const contentLength = response.headers.get("Content-Length");
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    // Read stream with progress
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      chunks.push(value);
      received += value.length;

      // Update progress
      if (total > 0) {
        const percent = (received / total) * 100;
        this.updateProgress(percent, `Downloading... ${Math.round(percent)}%`);
      }
    }

    // Create blob and trigger download
    const blob = new Blob(chunks);
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    this.updateProgress(100, "Complete!");
  }

  /**
   * Set button loading state
   */
  setButtonLoading(loading) {
    if (!this.elements.exportButton) return;

    if (loading) {
      this.elements.exportButton.classList.add("btn-loading");
      this.elements.exportButton.disabled = true;
    } else {
      this.elements.exportButton.classList.remove("btn-loading");
      this.elements.exportButton.disabled = false;
    }
  }

  /**
   * Show/hide progress UI
   */
  showProgress(show, message = "") {
    if (!this.elements.exportProgress || !this.elements.exportStatus) return;

    if (show) {
      this.elements.exportProgress.style.display = "block";
      this.elements.exportStatus.style.display = "block";
      if (message) {
        this.elements.exportStatus.querySelector("small").textContent = message;
      }
    } else {
      setTimeout(() => {
        this.elements.exportProgress.style.display = "none";
        this.elements.exportStatus.style.display = "none";
      }, 1000);
    }
  }

  /**
   * Update progress bar
   */
  updateProgress(percent, message) {
    if (this.elements.exportProgressBar) {
      this.elements.exportProgressBar.style.width = `${percent}%`;
    }
    if (message && this.elements.exportStatus) {
      this.elements.exportStatus.querySelector("small").textContent = message;
    }
  }
}

// Create singleton instance
const exportManager = new ExportManager();

// Initialize on page load
onPageLoad(
  ({ signal } = {}) => {
    exportManager.init({ signal });
  },
  { route: "/export" },
);

// Export for module usage
export { ExportManager, exportManager };
export default exportManager;
