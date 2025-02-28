/**
 * Export functionality - Handles exporting data in various formats
 */
"use strict";
(() => {
  // Cache DOM elements and state
  const elements = {};

  // Configuration for export forms
  const EXPORT_CONFIG = {
    trips: {
      id: "export-trips-form",
      dateStart: "trips-start-date",
      dateEnd: "trips-end-date",
      format: "trips-format",
      endpoint: "/api/export/trips",
    },
    matchedTrips: {
      id: "export-matched-trips-form",
      dateStart: "matched-trips-start-date",
      dateEnd: "matched-trips-end-date",
      format: "matched-trips-format",
      endpoint: "/api/export/trips",
    },
    streets: {
      id: "export-streets-form",
      location: "streets-location",
      format: "streets-format",
      endpoint: "/api/export/streets",
    },
    boundary: {
      id: "export-boundary-form",
      location: "boundary-location",
      format: "boundary-format",
      endpoint: "/api/export/boundary",
    },
    all: {
      id: "export-all-form",
      format: "all-format",
      endpoint: "/api/export/all_trips",
    },
  };

  /**
   * Initialize export functionality
   */
  function init() {
    cacheElements();
    initEventListeners();
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
      ".validate-location-btn",
    );
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

    try {
      let url;

      // Build the URL based on form type
      if (formType === "trips" || formType === "matchedTrips") {
        // Date-based exports
        const startDate = elements[config.dateStart]?.value;
        const endDate = elements[config.dateEnd]?.value;
        const format = elements[config.format]?.value;

        if (!startDate || !endDate) {
          throw new Error("Please select both start and end dates");
        }

        url = `${config.endpoint}?start_date=${startDate}&end_date=${endDate}&format=${format}`;
      } else if (formType === "streets" || formType === "boundary") {
        // Location-based exports
        const locationInput = elements[config.location];
        const format = elements[config.format]?.value;

        if (!validateLocationInput(locationInput)) {
          return; // Error already shown by validateLocationInput
        }

        const locationData = locationInput.getAttribute("data-location");
        url = `${config.endpoint}?location=${encodeURIComponent(locationData)}&format=${format}`;
      } else {
        // Simple format-only exports (all)
        const format = elements[config.format]?.value;
        url = `${config.endpoint}?format=${format}`;
      }

      const filename = `${formType}.${elements[config.format].value}`;
      await downloadFile(url, filename);
    } catch (error) {
      handleError(error, `exporting ${formType}`);
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

    try {
      const response = await fetch("/api/validate_location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: locationInput.value,
          locationType: "city",
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Server returned ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();

      if (data) {
        // Store the validated location data
        locationInput.setAttribute("data-location", JSON.stringify(data));
        locationInput.setAttribute(
          "data-display-name",
          data.display_name || data.name || locationInput.value,
        );

        // Enable submit button in parent form
        const form = locationInput.closest("form");
        const submitButton = form?.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = false;
        }

        showNotification("Location validated successfully!", "success");
      } else {
        showNotification(
          "Location not found. Please try a different search term",
          "warning",
        );
      }
    } catch (error) {
      handleError(error, "validating location");
    }
  }

  /**
   * Download a file from a URL
   * @param {string} url - URL to download from
   * @param {string} filename - Filename for downloaded file
   */
  async function downloadFile(url, filename) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Server returned ${response.status}: ${response.statusText}`,
        );
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.style.display = "none";
      a.href = blobUrl;
      a.download = filename;

      document.body.appendChild(a);
      a.click();

      // Clean up
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 100);

      showNotification(`Successfully exported ${filename}`, "success");
    } catch (error) {
      handleError(error, `downloading ${filename}`);
    }
  }

  /**
   * Show a notification using the global notification manager
   * @param {string} message - Notification message
   * @param {string} type - Notification type (success, warning, danger, info)
   */
  function showNotification(message, type) {
    if (window.notificationManager) {
      window.notificationManager.show(
        `${type.toUpperCase()}: ${message}`,
        type,
      );
    } else {
      alert(`${type.toUpperCase()}: ${message}`);
    }
  }

  /**
   * Handle errors and show notifications
   * @param {Error} error - Error object
   * @param {string} context - Error context
   */
  function handleError(error, context) {
    console.error(`Error ${context}:`, error);
    showNotification(`Error ${context}: ${error.message}`, "danger");
  }

  // Initialize on DOM ready
  document.addEventListener("DOMContentLoaded", init);

  // Expose validateLocation function to make it available for inline onclick handlers
  window.validateLocation = validateLocation;
})();
