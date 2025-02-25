/* global L, flatpickr, notificationManager, bootstrap, LoadingManager, $ */

/**
 * ExportManager - Handles exporting data in various formats
 */
class ExportManager {
  /**
   * Initialize the export manager
   */
  constructor() {
    // DOM elements cache
    this.elements = {};
    
    // Configuration
    this.config = {
      forms: {
        trips: {
          id: "export-trips-form",
          dateStart: "trips-start-date",
          dateEnd: "trips-end-date",
          format: "trips-format",
          endpoint: "/api/export/trips"
        },
        matchedTrips: {
          id: "export-matched-trips-form",
          dateStart: "matched-trips-start-date",
          dateEnd: "matched-trips-end-date",
          format: "matched-trips-format",
          endpoint: "/api/export/trips"
        },
        streets: {
          id: "export-streets-form",
          location: "streets-location",
          format: "streets-format",
          endpoint: "/api/export/streets"
        },
        boundary: {
          id: "export-boundary-form",
          location: "boundary-location",
          format: "boundary-format",
          endpoint: "/api/export/boundary"
        },
        all: {
          id: "export-all-form",
          format: "all-format",
          endpoint: "/api/export/all_trips"
        }
      }
    };
    
    // Initialize on DOM load
    document.addEventListener("DOMContentLoaded", () => this.init());
  }

  /**
   * Initialize the export manager
   */
  init() {
    this.cacheElements();
    this.initializeFormHandlers();
  }

  /**
   * Cache DOM elements for better performance
   */
  cacheElements() {
    Object.values(this.config.forms).forEach(form => {
      this.elements[form.id] = document.getElementById(form.id);
    });
  }

  /**
   * Initialize form event handlers
   */
  initializeFormHandlers() {
    // Trip export form
    this.initializeFormListener(
      this.config.forms.trips.id, 
      () => this.exportTrips()
    );
    
    // Matched trips export form
    this.initializeFormListener(
      this.config.forms.matchedTrips.id, 
      () => this.exportMatchedTrips()
    );
    
    // Streets export form
    this.initializeFormListener(
      this.config.forms.streets.id, 
      () => this.exportStreets()
    );
    
    // Boundary export form
    this.initializeFormListener(
      this.config.forms.boundary.id, 
      () => this.exportBoundary()
    );
    
    // All trips export form
    this.initializeFormListener(
      this.config.forms.all.id, 
      () => this.exportAllTrips()
    );
    
    // Initialize location validation buttons
    this.initializeLocationValidationButtons();
  }

  /**
   * Initialize a form listener
   * @param {string} formId - Form ID
   * @param {Function} submitHandler - Submit handler function
   */
  initializeFormListener(formId, submitHandler) {
    const form = document.getElementById(formId);
    if (form) {
      form.addEventListener("submit", event => {
        event.preventDefault();
        submitHandler();
      });
    }
  }

  /**
   * Initialize location validation buttons
   */
  initializeLocationValidationButtons() {
    const validateButtons = document.querySelectorAll(".validate-location-btn");
    validateButtons.forEach(button => {
      button.addEventListener("click", event => {
        const targetId = event.currentTarget.dataset.target;
        if (targetId) {
          this.validateLocation(targetId);
        }
      });
    });
  }

  /**
   * Export trips data
   */
  exportTrips() {
    try {
      const config = this.config.forms.trips;
      const url = this.getExportUrl(config.dateStart, config.dateEnd, config.format);
      const format = document.getElementById(config.format).value;
      
      this.downloadFile(url, `trips.${format}`);
    } catch (error) {
      this.handleError(error, "exporting trips");
    }
  }

  /**
   * Export matched trips data
   */
  exportMatchedTrips() {
    try {
      const config = this.config.forms.matchedTrips;
      const url = this.getExportUrl(config.dateStart, config.dateEnd, config.format);
      const format = document.getElementById(config.format).value;
      
      this.downloadFile(url, `matched_trips.${format}`);
    } catch (error) {
      this.handleError(error, "exporting matched trips");
    }
  }

  /**
   * Export streets data
   */
  exportStreets() {
    try {
      const config = this.config.forms.streets;
      const locationInput = document.getElementById(config.location);
      const format = document.getElementById(config.format).value;
      
      if (!this.validateLocationInput(locationInput)) {
        return;
      }
      
      const locationData = locationInput.getAttribute("data-location");
      const url = `${config.endpoint}?location=${encodeURIComponent(locationData)}&format=${format}`;
      
      this.downloadFile(url, `streets.${format}`);
    } catch (error) {
      this.handleError(error, "exporting streets");
    }
  }

  /**
   * Export boundary data
   */
  exportBoundary() {
    try {
      const config = this.config.forms.boundary;
      const locationInput = document.getElementById(config.location);
      const format = document.getElementById(config.format).value;
      
      if (!this.validateLocationInput(locationInput)) {
        return;
      }
      
      const locationData = locationInput.getAttribute("data-location");
      const url = `${config.endpoint}?location=${encodeURIComponent(locationData)}&format=${format}`;
      
      this.downloadFile(url, `boundary.${format}`);
    } catch (error) {
      this.handleError(error, "exporting boundary");
    }
  }

  /**
   * Export all trips data
   */
  exportAllTrips() {
    try {
      const config = this.config.forms.all;
      const format = document.getElementById(config.format).value;
      const url = `${config.endpoint}?format=${format}`;
      
      this.downloadFile(url, `all_trips.${format}`);
    } catch (error) {
      this.handleError(error, "exporting all trips");
    }
  }

  /**
   * Get export URL for date-based exports
   * @param {string} startDateId - Start date input ID
   * @param {string} endDateId - End date input ID
   * @param {string} formatId - Format input ID
   * @returns {string} Export URL
   */
  getExportUrl(startDateId, endDateId, formatId) {
    const startDate = document.getElementById(startDateId).value;
    const endDate = document.getElementById(endDateId).value;
    const format = document.getElementById(formatId).value;
    
    if (!startDate || !endDate) {
      throw new Error("Please select start and end dates");
    }
    
    return `/api/export/trips?start_date=${startDate}&end_date=${endDate}&format=${format}`;
  }

  /**
   * Download a file from a URL
   * @param {string} url - Download URL
   * @param {string} filename - File name
   */
  async downloadFile(url, filename) {
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
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
      
      notificationManager.show(`Successfully exported ${filename}`, "success");
    } catch (error) {
      this.handleError(error, `downloading ${filename}`);
    }
  }

  /**
   * Validate a location input
   * @param {HTMLElement} locationInput - Location input element
   * @returns {boolean} Whether the location is valid
   */
  validateLocationInput(locationInput) {
    if (!locationInput) {
      notificationManager.show("Location input not found", "warning");
      return false;
    }
    
    if (!locationInput.value.trim()) {
      notificationManager.show("Please enter a location", "warning");
      return false;
    }
    
    const locationData = locationInput.getAttribute("data-location");
    if (!locationData) {
      notificationManager.show("Please validate the location first", "warning");
      return false;
    }
    
    return true;
  }

  /**
   * Validate a location
   * @param {string} inputId - Location input ID
   */
  async validateLocation(inputId) {
    const locationInput = document.getElementById(inputId);
    
    if (!locationInput || !locationInput.value.trim()) {
      notificationManager.show("Please enter a location", "warning");
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
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (data) {
        this.handleValidLocationData(locationInput, data);
      } else {
        notificationManager.show("Location not found. Please try a different search term", "warning");
      }
    } catch (error) {
      this.handleError(error, "validating location");
    }
  }

  /**
   * Handle successful location validation
   * @param {HTMLElement} locationInput - Location input element
   * @param {Object} data - Location data
   */
  handleValidLocationData(locationInput, data) {
    locationInput.setAttribute("data-location", JSON.stringify(data));
    locationInput.setAttribute(
      "data-display-name",
      data.display_name || data.name || locationInput.value
    );
    
    // Enable the submit button in the parent form
    const form = locationInput.closest("form");
    if (form) {
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
    
    notificationManager.show("Location validated successfully!", "success");
  }

  /**
   * Handle an error
   * @param {Error} error - Error object
   * @param {string} context - Error context
   */
  handleError(error, context) {
    console.error(`Error ${context}:`, error);
    notificationManager.show(`Error ${context}: ${error.message}`, "danger");
  }
}

// Initialize the export manager
const exportManager = new ExportManager();
