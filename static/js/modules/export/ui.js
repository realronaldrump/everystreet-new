/**
 * Export UI Manager
 * Handles UI state management, form interactions, and format-based UI updates
 */

import { EXPORT_CONFIG } from "./config.js";
import { saveExportSettings } from "./settings.js";

/**
 * Cache DOM elements for export forms
 * @returns {Object} Cached element references
 */
export function cacheElements() {
  const elements = {};

  Object.values(EXPORT_CONFIG).forEach((config) => {
    elements[config.id] = document.getElementById(config.id);

    if (config.location) {
      elements[config.location] = document.getElementById(config.location);
    }

    if (config.format) {
      elements[config.format] = document.getElementById(config.format);
    }

    if (config.dateStart) {
      elements[config.dateStart] = document.getElementById(config.dateStart);
    }

    if (config.dateEnd) {
      elements[config.dateEnd] = document.getElementById(config.dateEnd);
    }
  });

  elements.validateButtons = document.querySelectorAll(".validate-location-btn");

  // Advanced export elements
  elements.exportAllDates = document.getElementById("export-all-dates");
  elements.saveExportSettings = document.getElementById("save-export-settings");

  // Data source checkboxes
  elements.includeTrips = document.getElementById("include-trips");
  elements.includeMatchedTrips = document.getElementById("include-matched-trips");

  // Data field checkboxes
  elements.includeBasicInfo = document.getElementById("include-basic-info");
  elements.includeLocations = document.getElementById("include-locations");
  elements.includeTelemetry = document.getElementById("include-telemetry");
  elements.includeGeometry = document.getElementById("include-geometry");
  elements.includeMeta = document.getElementById("include-meta");
  elements.includeCustom = document.getElementById("include-custom");

  // CSV options
  elements.csvOptionsContainer = document.getElementById("csv-options");
  elements.includeGpsInCsv = document.getElementById("include-gps-in-csv");
  elements.flattenLocationFields = document.getElementById("flatten-location-fields");

  return elements;
}

/**
 * Update UI based on selected export format
 * Enables/disables checkboxes and shows/hides CSV options
 * @param {string} format - Selected format
 * @param {Object} elements - Cached DOM elements
 */
export function updateUIBasedOnFormat(format, elements) {
  const checkboxes = [
    elements.includeBasicInfo,
    elements.includeLocations,
    elements.includeTelemetry,
    elements.includeGeometry,
    elements.includeMeta,
    elements.includeCustom,
  ];

  // Reset all checkboxes to enabled state
  checkboxes.forEach((checkbox) => {
    if (checkbox) {
      checkbox.disabled = false;
      checkbox.parentElement.classList.remove("text-muted");
      checkbox.title = "";
    }
  });

  // Show/hide CSV options
  if (elements.csvOptionsContainer) {
    elements.csvOptionsContainer.style.display = format === "csv" ? "block" : "none";
  }

  // Apply format-specific restrictions
  switch (format) {
    case "geojson":
      if (elements.includeGeometry) {
        elements.includeGeometry.checked = true;
        elements.includeGeometry.disabled = true;
      }
      break;

    case "gpx":
      if (elements.includeGeometry) {
        elements.includeGeometry.checked = true;
        elements.includeGeometry.disabled = true;
      }
      if (elements.includeTelemetry) {
        elements.includeTelemetry.disabled = true;
        elements.includeTelemetry.parentElement.classList.add("text-muted");
        elements.includeTelemetry.title = "Limited telemetry support in GPX format";
      }
      if (elements.includeMeta) {
        elements.includeMeta.disabled = true;
        elements.includeMeta.parentElement.classList.add("text-muted");
        elements.includeMeta.title = "Limited metadata support in GPX format";
      }
      if (elements.includeCustom) {
        elements.includeCustom.disabled = true;
        elements.includeCustom.parentElement.classList.add("text-muted");
        elements.includeCustom.title = "Custom data not supported in GPX format";
      }
      break;

    case "shapefile":
      if (elements.includeGeometry) {
        elements.includeGeometry.checked = true;
        elements.includeGeometry.disabled = true;
      }
      if (elements.includeCustom) {
        elements.includeCustom.disabled = true;
        elements.includeCustom.parentElement.classList.add("text-muted");
        elements.includeCustom.title
          = "Custom data may have limited support in Shapefile format";
      }
      break;

    case "csv":
      if (elements.includeGeometry) {
        elements.includeGeometry.disabled = true;
        elements.includeGeometry.parentElement.classList.add("text-muted");
        elements.includeGeometry.title
          = "Complex geometry not fully supported in CSV format";
      }
      break;

    case "json":
      // All checkboxes enabled by default
      break;

    default:
      // No specific UI changes for other formats
      break;
  }

  // Save settings if option is checked
  if (elements.saveExportSettings?.checked) {
    saveExportSettings(elements);
  }
}

/**
 * Set button loading state
 * @param {HTMLButtonElement} button - Button element
 * @param {boolean} isLoading - Whether to show loading state
 * @param {string} originalText - Original button text
 * @param {string} loadingText - Text to show while loading
 * @returns {string} Original button text (if entering loading state)
 */
export function setButtonLoading(
  button,
  isLoading,
  originalText = "",
  loadingText = "Exporting..."
) {
  if (!button) {
    return originalText;
  }

  if (isLoading) {
    const savedText = button.textContent || originalText;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> ${loadingText}`;
    return savedText;
  }

  button.disabled = false;
  button.innerHTML = originalText;
  return originalText;
}

/**
 * Initialize date pickers for export forms
 * @param {Object} elements - Cached DOM elements
 */
export function initDatePickers(elements) {
  if (!window.DateUtils || !window.DateUtils.initDatePicker) {
    console.warn("DateUtils not available for initializing date pickers");
    return;
  }

  const dateInputs = document.querySelectorAll('input[type="date"]');
  dateInputs.forEach((input) => {
    if (input.id) {
      window.DateUtils.initDatePicker(`#${input.id}`, {
        maxDate: "today",
        onClose(_selectedDates, dateStr) {
          if (input.id.includes("start")) {
            const endInputId = input.id.replace("start", "end");
            const endInput = document.getElementById(endInputId);
            if (endInput && window.flatpickr && endInput?._flatpickr) {
              endInput._flatpickr.set("minDate", dateStr);
            }
          }
        },
      });
    }
  });

  // Set default dates asynchronously
  const setDefaultDates = async () => {
    try {
      const dateRange = await window.DateUtils.getDateRangePreset("30days");

      Object.entries(EXPORT_CONFIG).forEach(([, config]) => {
        if (config.dateStart && config.dateEnd) {
          const startInput = elements[config.dateStart];
          const endInput = elements[config.dateEnd];

          if (startInput && !startInput.value && startInput?._flatpickr) {
            startInput._flatpickr.setDate(dateRange.startDate);
          }
          if (endInput && !endInput.value && endInput?._flatpickr) {
            endInput._flatpickr.setDate(dateRange.endDate);
          }
        }
      });
    } catch (error) {
      console.warn("Error setting default dates:", error);
    }
  };

  setTimeout(setDefaultDates, 200);
}

export default {
  cacheElements,
  updateUIBasedOnFormat,
  setButtonLoading,
  initDatePickers,
};
