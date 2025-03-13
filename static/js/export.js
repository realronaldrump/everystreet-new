/**
 * Export functionality - Handles exporting data in various formats
 * Provides improved user feedback and error handling
 */
"use strict";
(() => {
  // Cache DOM elements and state
  const elements = {};

  // Track ongoing exports to prevent duplicate requests
  let activeExports = {};

  // Configuration for export forms
  const EXPORT_CONFIG = {
    trips: {
      id: "export-trips-form",
      dateStart: "trips-start-date",
      dateEnd: "trips-end-date",
      format: "trips-format",
      endpoint: "/api/export/trips",
      name: "trips",
    },
    matchedTrips: {
      id: "export-matched-trips-form",
      dateStart: "matched-trips-start-date",
      dateEnd: "matched-trips-end-date",
      format: "matched-trips-format",
      endpoint: "/api/export/matched_trips",
      name: "map-matched trips",
    },
    streets: {
      id: "export-streets-form",
      location: "streets-location",
      format: "streets-format",
      endpoint: "/api/export/streets",
      name: "streets",
    },
    boundary: {
      id: "export-boundary-form",
      location: "boundary-location",
      format: "boundary-format",
      endpoint: "/api/export/boundary",
      name: "boundary",
    },
    all: {
      id: "export-all-form",
      format: "all-format",
      endpoint: "/api/export/all_trips",
      name: "all trips",
    },
  };

  /**
   * Initialize export functionality
   */
  function init() {
    cacheElements();
    initEventListeners();
    initDatePickers();
  }

  /**
   * Cache DOM elements for better performance
   */
  function cacheElements() {
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

    // Cache validate buttons
    elements.validateButtons = document.querySelectorAll(
      ".validate-location-btn"
    );
  }

  /**
   * Initialize date pickers using DateUtils
   */
  function initDatePickers() {
    // Only initialize if DateUtils is available
    if (!window.DateUtils || !window.DateUtils.initDatePicker) {
      console.warn("DateUtils not available for initializing date pickers");
      return;
    }

    // Initialize date inputs with DateUtils
    const dateInputs = document.querySelectorAll('input[type="date"]');
    dateInputs.forEach((input) => {
      if (input.id) {
        window.DateUtils.initDatePicker(`#${input.id}`, {
          maxDate: "today",
          onClose: function (selectedDates, dateStr) {
            // If this is a start date, update the corresponding end date min value
            if (input.id.includes("start")) {
              const endInputId = input.id.replace("start", "end");
              const endInput = document.getElementById(endInputId);
              if (endInput && window.flatpickr && endInput._flatpickr) {
                endInput._flatpickr.set("minDate", dateStr);
              }
            }
          },
        });
      }
    });

    // Set default dates if not already set
    const setDefaultDates = async () => {
      try {
        const dateRange = await window.DateUtils.getDateRangePreset("30days");

        for (const [formKey, config] of Object.entries(EXPORT_CONFIG)) {
          if (config.dateStart && config.dateEnd) {
            const startInput = elements[config.dateStart];
            const endInput = elements[config.dateEnd];

            if (startInput && !startInput.value && startInput._flatpickr) {
              startInput._flatpickr.setDate(dateRange.startDate);
            }

            if (endInput && !endInput.value && endInput._flatpickr) {
              endInput._flatpickr.setDate(dateRange.endDate);
            }
          }
        }
      } catch (error) {
        console.warn("Error setting default dates:", error);
      }
    };

    // Set default dates with a slight delay to allow flatpickr to initialize
    setTimeout(setDefaultDates, 200);
  }

  /**
   * Initialize event listeners
   */
  function initEventListeners() {
    // Set up form submit handlers
    Object.keys(EXPORT_CONFIG).forEach((formKey) => {
      const form = elements[EXPORT_CONFIG[formKey].id];
      if (form) {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          handleFormSubmit(formKey);
        });
      }
    });

    // Set up location validation buttons
    elements.validateButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        const targetId = event.currentTarget.dataset.target;
        if (targetId) {
          validateLocation(targetId);
        }
      });
    });
  }

  /**
   * Handle form submission for export
   * @param {string} formType - Key identifying which form was submitted
   */
  async function handleFormSubmit(formType) {
    const config = EXPORT_CONFIG[formType];
    if (!config) return;

    // Prevent duplicate exports
    if (activeExports[formType]) {
      showNotification(
        `Already exporting ${config.name}. Please wait...`,
        "info"
      );
      return;
    }

    const formElement = elements[config.id];
    if (!formElement) return;

    // Define originalText outside the try block so it's available in finally
    let submitButton = null;
    let originalText = "";

    // Show export in progress
    submitButton = formElement.querySelector('button[type="submit"]');
    if (submitButton) {
      originalText = submitButton.textContent || `Export ${config.name}`;
      submitButton.disabled = true;
      submitButton.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Exporting...';
    }

    try {
      activeExports[formType] = true;
      showNotification(`Starting ${config.name} export...`, "info");

      let url = "";

      // Build the URL based on form type
      if (formType === "trips" || formType === "matchedTrips") {
        // Date-based exports
        const startDate = elements[config.dateStart]?.value;
        const endDate = elements[config.dateEnd]?.value;
        const format = elements[config.format]?.value;

        if (!startDate || !endDate) {
          throw new Error("Please select both start and end dates");
        }

        if (!window.DateUtils.isValidDateRange(startDate, endDate)) {
          throw new Error("Start date must be before or equal to end date");
        }

        url = `${config.endpoint}?start_date=${startDate}&end_date=${endDate}&format=${format}`;
      } else if (formType === "streets" || formType === "boundary") {
        // Location-based exports
        const locationInput = elements[config.location];
        const format = elements[config.format]?.value;

        if (!validateLocationInput(locationInput)) {
          throw new Error("Invalid location. Please validate it first.");
        }

        const locationData = locationInput.getAttribute("data-location");
        url = `${config.endpoint}?location=${encodeURIComponent(
          locationData
        )}&format=${format}`;
      } else {
        // Simple format-only exports (all)
        const format = elements[config.format]?.value;
        url = `${config.endpoint}?format=${format}`;
      }

      // Show user the format they're exporting
      const format = elements[config.format]?.value || "default";
      showNotification(`Preparing ${format.toUpperCase()} export...`, "info");

      // Request timeout for large exports
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

      await downloadFile(url, config.name, controller.signal);
      clearTimeout(timeoutId);
    } catch (error) {
      // Use the centralized error handler from utils.js
      if (window.handleError) {
        window.handleError(error, `exporting ${config.name}`);
      } else {
        console.error(`Error exporting ${config.name}:`, error);
        showNotification(`Export failed: ${error.message}`, "danger");
      }
    } finally {
      // Clean up
      activeExports[formType] = false;

      // Reset button state
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.innerHTML = originalText;
      }
    }
  }

  /**
   * Validate location input
   * @param {HTMLElement} locationInput - Location input element
   * @returns {boolean} Whether location is valid
   */
  function validateLocationInput(locationInput) {
    if (!locationInput) {
      showNotification("Location input not found", "warning");
      return false;
    }

    if (!locationInput.value.trim()) {
      showNotification("Please enter a location", "warning");
      return false;
    }

    const locationData = locationInput.getAttribute("data-location");
    if (!locationData) {
      showNotification("Please validate the location first", "warning");
      return false;
    }

    return true;
  }

  /**
   * Validate a location through the API
   * @param {string} inputId - ID of location input element
   */
  async function validateLocation(inputId) {
    const locationInput = document.getElementById(inputId);

    if (!locationInput || !locationInput.value.trim()) {
      showNotification("Please enter a location", "warning");
      return;
    }

    // Define these variables outside the try block so they're accessible in finally
    let validateButton = null;
    let originalText = "";

    // Show validation in progress
    const form = locationInput.closest("form");
    validateButton = form?.querySelector(".validate-location-btn");

    if (validateButton) {
      originalText = validateButton.textContent || "Validate";
      validateButton.disabled = true;
      validateButton.innerHTML =
        '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Validating...';
    }

    try {
      showNotification(
        `Validating location: "${locationInput.value}"...`,
        "info"
      );

      const response = await fetch("/api/validate_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locationInput.value,
          locationType: "city",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      if (data) {
        // Store the validated location data
        locationInput.setAttribute("data-location", JSON.stringify(data));
        locationInput.setAttribute(
          "data-display-name",
          data.display_name || data.name || locationInput.value
        );

        // Update the input value with the canonical name
        locationInput.value =
          data.display_name || data.name || locationInput.value;

        // Style the input to show it's validated
        locationInput.classList.add("is-valid");
        locationInput.classList.remove("is-invalid");

        // Enable submit button in parent form
        const submitButton = form?.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = false;
        }

        showNotification(
          `Location validated: "${
            data.display_name || data.name || locationInput.value
          }"`,
          "success"
        );
      } else {
        locationInput.classList.add("is-invalid");
        locationInput.classList.remove("is-valid");
        showNotification(
          "Location not found. Please try a different search term",
          "warning"
        );
      }
    } catch (error) {
      // Use the centralized error handler if available
      if (window.handleError) {
        window.handleError(error, "validating location");
      } else {
        console.error("Error validating location:", error);
        showNotification(`Validation failed: ${error.message}`, "danger");
      }

      locationInput.classList.add("is-invalid");
      locationInput.classList.remove("is-valid");
    } finally {
      // Reset button state
      if (validateButton) {
        validateButton.disabled = false;
        validateButton.innerHTML = originalText;
      }
    }
  }

  /**
   * Download a file from a URL
   * @param {string} url - URL to download from
   * @param {string} exportName - Name of the export for user feedback
   * @param {AbortSignal} [signal] - AbortSignal for timeout control
   */
  async function downloadFile(url, exportName, signal) {
    try {
      showNotification(`Requesting ${exportName} data...`, "info");

      // Show loading indicator if available
      // Check for various loading indicator implementations
      if (
        window.loadingManager &&
        typeof window.loadingManager.show === "function"
      ) {
        window.loadingManager.show(`Exporting ${exportName}...`);
      } else if (
        window.LoadingManager &&
        typeof window.LoadingManager.show === "function"
      ) {
        window.LoadingManager.show(`Exporting ${exportName}...`);
      } else {
        // Find the loading overlay element directly if it exists
        const loadingOverlay = document.querySelector(".loading-overlay");
        if (loadingOverlay) {
          loadingOverlay.style.display = "flex";
          const loadingText = loadingOverlay.querySelector(".loading-text");
          if (loadingText) {
            loadingText.textContent = `Exporting ${exportName}...`;
          }
        }
      }

      // Add fetch options including abort signal for timeout
      const fetchOptions = { signal };

      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;

        try {
          // Try to get detailed error message
          const errorText = await response.text();
          if (errorText) {
            try {
              const errorJson = JSON.parse(errorText);
              errorMsg = errorJson.detail || errorJson.message || errorText;
            } catch (e) {
              errorMsg = errorText.substring(0, 100); // Truncate long error messages
            }
          }
        } catch (e) {
          // Ignore error parsing error
        }

        throw new Error(errorMsg);
      }

      // Get content length if available
      const contentLength = response.headers.get("Content-Length");
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

      // Get filename from Content-Disposition header
      const contentDisposition = response.headers.get("Content-Disposition");
      const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
      const filename = filenameMatch
        ? filenameMatch[1]
        : `${exportName}-export.file`;

      showNotification(`Downloading ${filename}...`, "info");

      // Create a reader to read the stream and keep track of progress
      const reader = response.body.getReader();
      let receivedLength = 0;
      const chunks = [];

      // Function to process chunks
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        chunks.push(value);
        receivedLength += value.length;

        // Update progress if we know the total size
        if (totalSize) {
          const progress = Math.min(
            Math.round((receivedLength / totalSize) * 100),
            100
          );

          // Try to update progress through different possible interfaces
          if (
            window.loadingManager &&
            typeof window.loadingManager.updateProgress === "function"
          ) {
            window.loadingManager.updateProgress(progress);
          } else if (
            window.LoadingManager &&
            typeof window.LoadingManager.updateProgress === "function"
          ) {
            window.LoadingManager.updateProgress(progress);
          } else {
            // Try to find progress bar element directly
            const progressBar = document.getElementById("loading-progress-bar");
            if (progressBar) {
              progressBar.style.width = `${progress}%`;
            }
          }
        }
      }

      // Combine chunks into a single Uint8Array
      const chunksAll = new Uint8Array(receivedLength);
      let position = 0;
      for (const chunk of chunks) {
        chunksAll.set(chunk, position);
        position += chunk.length;
      }

      // Convert to blob
      const blob = new Blob([chunksAll]);
      const blobUrl = URL.createObjectURL(blob);

      // Create and trigger download
      const downloadLink = document.createElement("a");
      downloadLink.style.display = "none";
      downloadLink.href = blobUrl;
      downloadLink.download = filename;

      document.body.appendChild(downloadLink);
      downloadLink.click();

      // Clean up
      setTimeout(() => {
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(blobUrl);
      }, 100);

      showNotification(`Successfully exported ${filename}`, "success");
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "Export timed out. The file might be too large or the server is busy."
        );
      }
      throw error;
    } finally {
      // Hide loading indicator - checking for all possible implementations
      if (
        window.loadingManager &&
        typeof window.loadingManager.hide === "function"
      ) {
        window.loadingManager.hide();
      } else if (
        window.LoadingManager &&
        typeof window.LoadingManager.hide === "function"
      ) {
        window.LoadingManager.hide();
      } else {
        // Find the loading overlay element directly if it exists
        const loadingOverlay = document.querySelector(".loading-overlay");
        if (loadingOverlay) {
          loadingOverlay.style.display = "none";
        }
      }
    }
  }

  /**
   * Show a notification using the global notification manager
   * @param {string} message - Notification message
   * @param {string} type - Notification type (success, warning, danger, info)
   */
  function showNotification(message, type) {
    if (window.notificationManager) {
      window.notificationManager.show(message, type);
    } else {
      console.log(`${type.toUpperCase()}: ${message}`);
    }
  }

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", init);

  // Expose validateLocation function to make it available for inline onclick handlers
  window.validateLocation = validateLocation;
})();
