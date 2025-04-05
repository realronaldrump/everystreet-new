/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */
"use strict";

// Add CSS styles for activity indicator
(() => {
  // Add CSS for pulsing activity indicator
  const style = document.createElement("style");
  style.textContent = `
    .activity-indicator.pulsing {
      animation: pulse 1.5s infinite;
    }
    
    @keyframes pulse {
      0% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
      100% {
        opacity: 1;
      }
    }
    
    .detailed-stage-info {
      font-style: italic;
      color: #6c757d;
    }
    
    .unit-toggle {
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
    }
  `;
  document.head.appendChild(style);
})();

(() => {
  class CoverageManager {
    constructor() {
      this.locationData = null;
      this.map = null; // General map (if any)
      this.coverageMap = null; // Specific map for coverage display
      this.streetLayers = null; // Layer group for street features
      this.streetsGeoJson = null; // Store the raw GeoJSON data
      this.streetsGeoJsonLayer = null; // Store the Leaflet GeoJSON layer instance
      this.mapBounds = null; // Store bounds for fitting map
      this.selectedLocation = null; // Stores the full data of the currently displayed location
      this.currentProcessingLocation = null; // Location being processed via modal
      this.processingStartTime = null;
      this.lastProgressUpdate = null; // Store last data point for timing estimates (though estimate removed)
      this.progressTimer = null;
      this.activeTaskIds = new Set(); // Keep track of tasks being polled
      this.validatedLocation = null; // Stores result from /api/validate_location
      this.currentFilter = "all"; // Track current map filter ('all', 'driven', 'undriven')
      this.tooltips = []; // Store Bootstrap tooltip instances
      this.highlightedLayer = null; // Track the currently highlighted map layer
      this.useMiles = true; // Use miles instead of kilometers for distance
      this.lastActivityTime = null; // Track when last activity happened

      // Check for notification manager
      if (typeof window.notificationManager === "undefined") {
        console.warn(
          "notificationManager not found, fallbacks will use console.log",
        );
        // Simple fallback
        window.notificationManager = {
          show: (message, type = "info") => {
            console.log(`[${type.toUpperCase()}] ${message}`);
          },
        };
      }
      // Check for confirmation dialog
      if (typeof window.confirmationDialog === "undefined") {
        console.warn(
          "confirmationDialog not found, fallbacks will use standard confirm()",
        );
        // Simple fallback
        window.confirmationDialog = {
          show: async (options) => {
            return confirm(options.message || "Are you sure?");
          },
        };
      }

      // Initialize modals once DOM is ready
      document.addEventListener("DOMContentLoaded", () => {
        this.setupAutoRefresh();
        this.checkForInterruptedTasks(); // Check for interrupted tasks on page load
        this.setupConnectionMonitoring(); // Setup connection status monitoring
        this.initTooltips(); // Initialize tooltips
      });

      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    setupConnectionMonitoring() {
      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        const statusBar = document.createElement("div");
        statusBar.className = `connection-status alert alert-${
          isOnline ? "success" : "danger"
        } alert-dismissible fade show`;
        statusBar.innerHTML = `
          <i class="fas fa-${
            isOnline ? "wifi" : "exclamation-triangle"
          } me-2"></i>
          <strong>${isOnline ? "Connected" : "Offline"}</strong>
          ${!isOnline ? " - Changes cannot be saved while offline" : ""}
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;

        // Remove existing status bars
        document
          .querySelectorAll(".connection-status")
          .forEach((el) => el.remove());
        document.querySelector("#alerts-container").appendChild(statusBar);

        // Auto-hide after 5 seconds if connected
        if (isOnline) {
          setTimeout(() => {
            statusBar.classList.remove("show");
            setTimeout(() => statusBar.remove(), 500);
          }, 5000);
        }
      };

      window.addEventListener("online", handleConnectionChange);
      window.addEventListener("offline", handleConnectionChange);

      // Check initial state
      if (!navigator.onLine) {
        handleConnectionChange();
      }
    }

    initTooltips() {
      // Dispose any existing tooltips
      this.tooltips.forEach((tooltip) => {
        if (tooltip && typeof tooltip.dispose === "function") {
          tooltip.dispose();
        }
      });
      this.tooltips = [];

      // Initialize tooltips on elements with data-bs-toggle="tooltip"
      const tooltipTriggerList = document.querySelectorAll(
        '[data-bs-toggle="tooltip"]',
      );
      this.tooltips = [...tooltipTriggerList].map((tooltipTriggerEl) => {
        return new bootstrap.Tooltip(tooltipTriggerEl);
      });
    }

    enhanceResponsiveTables() {
      const tables = document.querySelectorAll("#coverage-areas-table");
      tables.forEach((table) => {
        // Add data-labels for mobile view
        const headers = Array.from(table.querySelectorAll("thead th")).map(
          (th) => th.textContent.trim(),
        );
        const rows = table.querySelectorAll("tbody tr");

        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          cells.forEach((cell, i) => {
            if (headers[i]) {
              cell.setAttribute("data-label", headers[i]);
            }
          });
        });
      });
    }

    checkForInterruptedTasks() {
      // Check localStorage for any interrupted tasks
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          // Only restore if the saved state is recent (< 30 minutes)
          if (now - savedTime < 30 * 60 * 1000) {
            const location = progressData.location;

            // Show notification with option to resume
            const notification = document.createElement("div");
            notification.className =
              "alert alert-info alert-dismissible fade show";
            notification.innerHTML = `
              <h5><i class="fas fa-info-circle me-2"></i>Interrupted Task Found</h5>
              <p>A processing task for <strong>${
                location?.display_name || "Unknown Location"
              }</strong> was interrupted.</p>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-primary resume-task">Resume Task</button>
                <button class="btn btn-sm btn-secondary discard-task">Discard</button>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
            `;

            // Add event listeners
            notification
              .querySelector(".resume-task")
              .addEventListener("click", () => {
                this.resumeInterruptedTask(progressData);
                notification.remove();
              });

            notification
              .querySelector(".discard-task")
              .addEventListener("click", () => {
                localStorage.removeItem("coverageProcessingState");
                notification.remove();
              });

            // Insert at top of page
            document
              .querySelector("#alerts-container")
              .appendChild(notification);
          } else {
            // If too old, just remove it
            localStorage.removeItem("coverageProcessingState");
          }
        } catch (e) {
          console.error("Error restoring saved progress:", e);
          localStorage.removeItem("coverageProcessingState");
        }
      }
    }

    resumeInterruptedTask(savedData) {
      if (!savedData.location) return;

      this.currentProcessingLocation = savedData.location;
      this.showProgressModal(
        `Resuming processing for ${savedData.location.display_name}...`,
        savedData.progress || 0,
      );

      // Depending on what stage we were at, re-trigger the right operation
      if (savedData.progress < 50) {
        // Likely during preprocessing - restart
        this.addCoverageArea();
      } else {
        // Likely during calculation - restart as full update
        this.updateCoverageForArea(savedData.location, "full");
      }
    }

    saveProcessingState() {
      if (this.currentProcessingLocation) {
        const progressBar = document.querySelector(".progress-bar");
        const saveData = {
          location: this.currentProcessingLocation,
          taskId: this.task_id, // Ensure task_id is set on the instance when polling starts
          stage:
            document.querySelector(".progress-message")?.textContent ||
            "Processing",
          progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0"),
          timestamp: new Date().toISOString(),
        };

        localStorage.setItem(
          "coverageProcessingState",
          JSON.stringify(saveData),
        );
      }
    }

    setupEventListeners() {
      // Validation and add buttons
      document
        .getElementById("validate-location")
        ?.addEventListener("click", () => this.validateLocation());

      document
        .getElementById("add-coverage-area")
        ?.addEventListener("click", () => this.addCoverageArea());

      document
        .getElementById("cancel-processing")
        ?.addEventListener("click", () =>
          this.cancelProcessing(this.currentProcessingLocation),
        );

      // Disable "Add Area" button when location input changes
      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;

          // Clear validation classes
          const locationInput = document.getElementById("location-input");
          locationInput.classList.remove("is-invalid", "is-valid");
        });

      // Refresh coverage areas when the progress modal is closed
      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          this.loadCoverageAreas(); // Refresh table when modal closes
          this.currentProcessingLocation = null; // Clear context
          if (this.progressTimer) {
            // Ensure timer is cleared
            clearInterval(this.progressTimer);
            this.progressTimer = null;
          }
          // Remove saved state
          localStorage.removeItem("coverageProcessingState");
        });

      // Save state on page unload
      window.addEventListener("beforeunload", () => this.saveProcessingState());

      // Table action buttons (using event delegation)
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const target = e.target.closest("button[data-location]"); // Target only buttons with location data
          if (!target) return;

          e.preventDefault(); // Prevent default button behavior

          const locationStr = target.dataset.location;
          if (!locationStr) return;

          try {
            const location = JSON.parse(locationStr);

            if (target.classList.contains("update-coverage-btn")) {
              this.updateCoverageForArea(location, "full");
            } else if (target.classList.contains("update-incremental-btn")) {
              this.updateCoverageForArea(location, "incremental");
            } else if (target.classList.contains("delete-area-btn")) {
              this.deleteArea(location);
            } else if (target.classList.contains("cancel-processing")) {
              // Note: Cancel button might be better placed in the modal
              this.cancelProcessing(location);
            }
          } catch (error) {
            console.error(
              "Error parsing location data or handling action:",
              error,
            );
            window.notificationManager.show(
              "Action failed: Invalid location data.",
              "danger",
            );
          }
        });

      // Add click handler for location names in the table (using event delegation)
      document.addEventListener("click", (e) => {
        const locationLink = e.target.closest(".location-name-link");
        if (locationLink) {
          e.preventDefault();
          const locationId = locationLink.dataset.locationId;
          if (locationId) {
            this.displayCoverageDashboard(locationId);
          } else {
            console.error("Location ID missing from link:", locationLink);
          }
        }

        // Handle clicks on the "Update Missing Data" button within the dashboard
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          try {
            const locationStr = updateMissingDataBtn.dataset.location;
            if (!locationStr)
              throw new Error("Missing location data on button");
            const location = JSON.parse(locationStr);
            // Trigger a full update when data is missing
            this.updateCoverageForArea(location, "full");
          } catch (err) {
            console.error("Error parsing location data for update:", err);
            window.notificationManager.show(
              "Failed to initiate update: Invalid location data.",
              "danger",
            );
          }
        }
      });

      // Export coverage map button
      document
        .getElementById("export-coverage-map")
        ?.addEventListener("click", () => {
          if (this.coverageMap) {
            this.exportCoverageMap();
          } else {
            window.notificationManager.show(
              "No map is currently displayed to export.",
              "warning",
            );
          }
        });

      // Map filter buttons
      document
        .getElementById("show-all-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("all");
          this.toggleFilterButtonState(e.target);
        });

      document
        .getElementById("show-driven-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("driven");
          this.toggleFilterButtonState(e.target);
        });

      document
        .getElementById("show-undriven-streets")
        ?.addEventListener("click", (e) => {
          this.setMapFilter("undriven");
          this.toggleFilterButtonState(e.target);
        });
    }

    async validateLocation() {
      const locationInputEl = document.getElementById("location-input");
      const locationInput = locationInputEl?.value.trim();

      // Clear previous validation state
      locationInputEl.classList.remove("is-invalid", "is-valid");

      if (!locationInput) {
        // Show inline validation
        locationInputEl.classList.add("is-invalid");
        window.notificationManager.show(
          "Please enter a location to validate.",
          "warning",
        );
        return;
      }

      const locTypeEl = document.getElementById("location-type");
      const locType = locTypeEl?.value;
      if (!locType) {
        window.notificationManager.show(
          "Please select a location type.",
          "warning",
        );
        return;
      }

      const validateButton = document.getElementById("validate-location");
      const originalButtonText = validateButton.innerHTML;
      validateButton.disabled = true;
      validateButton.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Validating...';

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: locationInput,
            locationType: locType,
          }),
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail || `HTTP error! status: ${response.status}`,
          );
        }

        if (!data || !data.osm_id) {
          // Check for essential data
          locationInputEl.classList.add("is-invalid");
          window.notificationManager.show(
            "Location not found or invalid response. Please check your input.",
            "warning",
          );
          this.validatedLocation = null;
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          return;
        }

        // Success
        locationInputEl.classList.add("is-valid");
        this.validatedLocation = data;
        const addButton = document.getElementById("add-coverage-area");
        if (addButton) addButton.disabled = false;
        window.notificationManager.show(
          `Location validated: ${data.display_name}`,
          "success",
        );
      } catch (error) {
        console.error("Error validating location:", error);
        locationInputEl.classList.add("is-invalid");
        window.notificationManager.show(
          `Validation failed: ${error.message}. Please try again.`,
          "danger",
        );
        this.validatedLocation = null;
        const addButton = document.getElementById("add-coverage-area");
        if (addButton) addButton.disabled = true;
      } finally {
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonText;
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation || !this.validatedLocation.display_name) {
        window.notificationManager.show(
          "Please validate a location first.",
          "warning",
        );
        return;
      }

      const addButton = document.getElementById("add-coverage-area");
      const originalButtonText = addButton.innerHTML;
      addButton.disabled = true; // Disable while processing
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      try {
        // Check if area already exists (fetch current list)
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok)
          throw new Error("Failed to fetch current coverage areas");
        const { areas } = await currentAreasResponse.json();

        const exists = areas.some(
          (area) =>
            area.location?.display_name === this.validatedLocation.display_name,
        );

        if (exists) {
          window.notificationManager.show(
            "This area is already being tracked.",
            "warning",
          );
          return; // Exit without adding
        }

        // Optimistically add to table (will be updated by auto-refresh or on modal close)
        const newArea = {
          _id: `temp_${Date.now()}`, // Temporary ID
          location: this.validatedLocation,
          total_length: 0,
          driven_length: 0,
          coverage_percentage: 0,
          total_segments: 0,
          last_updated: null,
          status: "preprocessing", // Start with preprocessing status
        };
        this.constructor.updateCoverageTable([...areas, newArea]); // Use static method

        // Store the validated location for the entire process (don't reset in finally)
        const processingLocation = this.validatedLocation;

        // Show progress modal immediately
        this.currentProcessingLocation = processingLocation;
        this.task_id = null; // Reset task ID before starting
        this.showProgressModal(
          `Starting processing for ${processingLocation.display_name}...`,
          0,
        );

        // Trigger the backend processing
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(processingLocation), // Send the validated location object
        });

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          // If backend fails, remove optimistic row and show error
          await this.loadCoverageAreas(); // Reload to remove temp row
          this.hideProgressModal();
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`,
          );
        }

        window.notificationManager.show(
          "Coverage area processing started in background.",
          "info",
        );

        // Start polling if we got a task ID
        if (taskData?.task_id) {
          this.task_id = taskData.task_id; // Store the task ID for state saving
          this.activeTaskIds.add(taskData.task_id);
          let pollingSuccessful = false; // <-- Keep track of polling success

          try {
            await this.pollCoverageProgress(taskData.task_id);
            pollingSuccessful = true; // <-- Mark success
            window.notificationManager.show(
              "Processing completed successfully!",
              "success",
            );
            // DO NOT hide modal here on success
          } catch (pollError) {
            // Convert any objects to strings for better error messages
            const errorMessage =
              typeof pollError === "object"
                ? pollError.message || JSON.stringify(pollError)
                : String(pollError);

            window.notificationManager.show(
              `Processing failed: ${errorMessage}`,
              "danger",
            );
            this.hideProgressModal(); // <-- Hide on polling error
          } finally {
            this.activeTaskIds.delete(taskData.task_id);
            this.task_id = null; // Clear task ID

            // If polling was successful, clear the context but DON'T hide modal
            if (pollingSuccessful) {
              this.currentProcessingLocation = null;
            }
            // No automatic hiding here

            // Always refresh areas list after polling attempt finishes (success or fail)
            await this.loadCoverageAreas();
          }
        } else {
          // No task ID returned
          this.hideProgressModal(); // <-- Hide if no task ID
          window.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        // Reset input form
        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid");
        }
        this.validatedLocation = null;
      } catch (error) {
        // Error during initial API call or setup
        // Ensure error is properly stringified
        const errorMessage =
          typeof error === "object"
            ? error.message || JSON.stringify(error)
            : String(error);

        console.error("Error adding coverage area:", error);
        window.notificationManager.show(
          `Failed to add coverage area: ${errorMessage}`,
          "danger",
        );
        this.hideProgressModal(); // <-- Hide on initial error
        await this.loadCoverageAreas();
      } finally {
        // Only reset button state here, not processing context or modal
        addButton.disabled = true;
        addButton.innerHTML = originalButtonText;
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel || !locationToCancel.display_name) {
        window.notificationManager.show(
          "No active processing context found to cancel.",
          "warning",
        );
        return;
      }

      // Add confirmation dialog
      const confirmed = await window.confirmationDialog.show({
        title: "Cancel Processing",
        message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>? This cannot be undone.`,
        confirmText: "Yes, Cancel",
        cancelText: "No, Continue Processing",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) {
        return; // User chose not to cancel
      }

      window.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info",
      );

      try {
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Send the full location object as expected by the backend Pydantic model
          body: JSON.stringify(locationToCancel),
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Failed to send cancel request (HTTP ${response.status})`,
          );
        }

        window.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success",
        );
        this.hideProgressModal(); // Close the progress modal if it was open
        await this.loadCoverageAreas(); // Refresh the table to show 'canceled' status
      } catch (error) {
        console.error("Error cancelling processing:", error);
        window.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
      } finally {
        this.currentProcessingLocation = null; // Clear context
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      this.processingStartTime = new Date();
      this.lastActivityTime = new Date();

      // Set up modal content
      const modalProgressBar = modalElement.querySelector(".progress-bar");
      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        modalProgressBar.classList.add(
          "progress-bar-striped",
          "progress-bar-animated",
        );
      }

      const progressMessage = modalElement.querySelector(".progress-message");
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.classList.remove("text-danger");
      }

      // Add activity indicator, unit toggle, and last update time if they don't exist
      const activityIndicatorContainer = modalElement.querySelector(
        ".activity-indicator-container",
      );
      if (
        activityIndicatorContainer &&
        !activityIndicatorContainer.querySelector(".activity-indicator")
      ) {
        activityIndicatorContainer.innerHTML = `
          <div class="d-flex align-items-center justify-content-between">
            <small class="activity-indicator pulsing"><i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active</small>
            <small class="last-update-time text-muted"></small>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary mt-2 unit-toggle">
            Switch to ${this.useMiles ? "km" : "mi"}
          </button>
          <div class="detailed-stage-info text-muted mt-2 small"></div>
        `;
      }

      // Show the modal
      if (!modalElement.classList.contains("show")) {
        const bsModal = new bootstrap.Modal(modalElement, {
          backdrop: "static",
          keyboard: false,
        });
        bsModal.show();
      }

      // Start timer to update elapsed time
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
      }
      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();

        // Also check if activity indicator needs to be updated
        const activityIndicator = modalElement.querySelector(
          ".activity-indicator",
        );
        if (activityIndicator) {
          if (
            this.lastActivityTime &&
            new Date() - this.lastActivityTime > 5000
          ) {
            // No activity for more than 5 seconds - switch from pulsing to normal
            activityIndicator.classList.remove("pulsing");
            activityIndicator.innerHTML =
              '<i class="fas fa-circle-notch fa-spin text-secondary me-1"></i>Running';
          } else {
            // Recent activity - ensure pulsing is active
            activityIndicator.classList.add("pulsing");
            activityIndicator.innerHTML =
              '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
          }
        }
      }, 1000);

      // Update immediately to set the initial values
      this.updateTimingInfo();
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      try {
        const modal = bootstrap.Modal.getInstance(modalElement);
        if (modal) {
          modal.hide();
        } else {
          // Fallback if Bootstrap modal instance not found
          modalElement.style.display = "none";
          modalElement.classList.remove("show");
          document.body.classList.remove("modal-open");
          const backdrop = document.querySelector(".modal-backdrop");
          if (backdrop) backdrop.remove();
        }
      } catch (error) {
        console.error("Error hiding modal:", error);
        // Fallback using direct DOM manipulation
        modalElement.style.display = "none";
        modalElement.classList.remove("show");
        document.body.classList.remove("modal-open");
        const backdrop = document.querySelector(".modal-backdrop");
        if (backdrop) backdrop.remove();
      }

      // Clear timer
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }

      // Remove saved state
      localStorage.removeItem("coverageProcessingState");

      // Remove unload listener
      window.removeEventListener("beforeunload", () =>
        this.saveProcessingState(),
      );

      // Clear processing context
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
    }

    updateTimingInfo() {
      if (!this.processingStartTime) return; // Don't run if modal not active

      const now = Date.now();
      const elapsedMs = now - this.processingStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);

      // Format elapsed time
      let elapsedText = `${elapsedSeconds}s`;
      if (elapsedSeconds >= 60) {
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        elapsedText = `${minutes}m ${seconds}s`;
      }

      // **MODIFIED:** Removed estimated time calculation

      // Update time display elements within the modal
      const elapsedTimeEl = document.querySelector(
        "#taskProgressModal .elapsed-time",
      );
      const estimatedTimeEl = document.querySelector(
        "#taskProgressModal .estimated-time",
      );

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      // **MODIFIED:** Clear or hide estimated time
      if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Or set display: none
    }

    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      // Extract data from processing status
      const { stage, progress = 0, metrics = {} } = data || {};
      const progressBar = modalElement.querySelector(".progress-bar");
      const statusEl = modalElement.querySelector(".status-text");
      const stageIconEl = modalElement.querySelector(".stage-icon");
      const stageBadgeEl = modalElement.querySelector(".stage-badge");
      const activityIndicatorEl = modalElement.querySelector(
        ".activity-indicator",
      );

      // Update progress bar if found
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
      }

      // Update stage text with icon if found
      if (stageIconEl && stageBadgeEl) {
        stageIconEl.className = `stage-icon me-1 ${this.constructor.getStageIcon(stage)}`;
        stageBadgeEl.className = `stage-badge badge ${this.constructor.getStageBadgeClass(stage)}`;
        statusEl.innerHTML = `
          <span class="d-block small">${data.message || "Processing..."}</span>
          <span class="d-block">
            ${this.constructor.formatStageName(stage)}
          </span>
        `;
      }

      // Toggle for miles/kilometers
      const unitToggleEl = modalElement.querySelector(".unit-toggle");
      if (unitToggleEl) {
        unitToggleEl.textContent = this.useMiles
          ? "Switch to km"
          : "Switch to mi";
        unitToggleEl.onclick = () => {
          this.useMiles = !this.useMiles;
          // Re-update the content with new units
          this.updateModalContent(data);
        };
      }

      // Update stats information with clearer metrics
      let statsText = "";
      if (metrics.rtree_items !== undefined && stage === "indexing") {
        const totalLength = metrics.total_length_m || 0;
        const driveableLength = metrics.driveable_length_m || 0;
        const coveredLength = metrics.covered_length_m || 0;

        statsText += `
          <div class="mt-1">
            <div class="d-flex justify-content-between">
              <small>Streets Indexed:</small>
              <small class="text-info">${metrics.rtree_items.toLocaleString()}</small>
            </div>
            <div class="d-flex justify-content-between">
              <small>Total Length:</small>
              <small>${this.distanceInUserUnits(totalLength)}</small>
            </div>
            <div class="d-flex justify-content-between">
              <small>Driveable Length:</small>
              <small>${this.distanceInUserUnits(driveableLength)}</small>
            </div>
            <div class="d-flex justify-content-between">
              <small>Already Covered:</small>
              <small>${this.distanceInUserUnits(coveredLength)} (${metrics.coverage_percentage?.toFixed(1) || 0}%)</small>
            </div>
          </div>`;
      }

      if (
        metrics.total_trips_to_process !== undefined &&
        stage === "processing_trips"
      ) {
        const processed = metrics.processed_trips || 0;
        const total = metrics.total_trips_to_process || 0;
        const tripsProgress = total > 0 ? (processed / total) * 100 : 0;
        const newlyFound = metrics.newly_covered_segments || 0;

        statsText += `
          <div class="mt-2">`;

        // Different messages based on progress stage
        if (progress < 56) {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>Preparing Trip Processing:</small>
              <small class="text-info">${progress.toFixed(0)}%</small>
            </div>
            <div class="progress mt-1 mb-2" style="height: 5px;">
              <div class="progress-bar bg-info" style="width: ${(progress - 50) * 10}%"></div>
            </div>`;

          if (total > 0) {
            statsText += `
              <div class="d-flex justify-content-between">
                <small>GPS Trips Found:</small>
                <small>${total.toLocaleString()}</small>
              </div>`;
          }
        } else {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>Trip Progress:</small>
              <small class="text-info">${processed.toLocaleString()}/${total.toLocaleString()} (${tripsProgress.toFixed(1)}%)</small>
            </div>
            <div class="progress mt-1 mb-2" style="height: 5px;">
              <div class="progress-bar bg-info" style="width: ${tripsProgress}%"></div>
            </div>`;
        }

        if (newlyFound > 0) {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>Newly Found Segments:</small>
              <small class="text-success">+${newlyFound.toLocaleString()}</small>
            </div>`;
        }

        if (metrics.coverage_percentage !== undefined) {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>Current Coverage:</small>
              <small>${metrics.coverage_percentage.toFixed(1)}%</small>
            </div>`;
        }

        statsText += `</div>`;
      }

      if (
        (metrics.newly_covered_segments !== undefined ||
          metrics.coverage_percentage !== undefined) &&
        (stage === "finalizing" ||
          stage === "complete_stats" ||
          stage === "complete" ||
          stage === "generating_geojson")
      ) {
        const newlyFound = metrics.newly_covered_segments || 0;
        const totalCovered = metrics.total_covered_segments || 0;
        const initialCovered = metrics.initial_covered_segments || 0;

        statsText += `
          <div class="mt-1">`;

        if (newlyFound > 0) {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>New Segments Covered:</small>
              <small class="text-success">+${newlyFound.toLocaleString()}</small>
            </div>`;
        }

        statsText += `
            <div class="d-flex justify-content-between">
              <small>Total Segments Covered:</small>
              <small>${totalCovered.toLocaleString()} / ${(initialCovered + newlyFound).toLocaleString()}</small>
            </div>`;

        if (metrics.coverage_percentage !== undefined) {
          statsText += `
            <div class="d-flex justify-content-between">
              <small>Final Coverage:</small>
              <small class="text-${metrics.coverage_percentage > 50 ? "success" : "primary"}">${metrics.coverage_percentage.toFixed(1)}%</small>
            </div>`;

          if (metrics.driveable_length_m && metrics.covered_length_m) {
            const driveableLength = metrics.driveable_length_m || 0;
            const coveredLength = metrics.covered_length_m || 0;

            statsText += `
              <div class="d-flex justify-content-between">
                <small>Distance Covered:</small>
                <small>${this.distanceInUserUnits(coveredLength)} / ${this.distanceInUserUnits(driveableLength)}</small>
              </div>`;
          }
        }

        statsText += `</div>`;
      }

      const statsInfoEl = modalElement.querySelector(".stats-info");
      if (statsInfoEl) {
        statsInfoEl.innerHTML =
          statsText || '<div class="text-muted small">Processing...</div>';
      }

      // Stop animation and timer if complete or error
      if (stage === "complete" || stage === "error") {
        if (progressBar) {
          progressBar.classList.remove(
            "progress-bar-striped",
            "progress-bar-animated",
          );
        }
        if (this.progressTimer) {
          clearInterval(this.progressTimer);
          this.progressTimer = null;
          const estimatedTimeEl = modalElement.querySelector(".estimated-time");
          if (estimatedTimeEl) estimatedTimeEl.textContent = "";
        }

        // Stop activity indicator
        if (activityIndicatorEl) {
          activityIndicatorEl.classList.remove("pulsing");
        }
      }
    }

    updateStepIndicators(stage, progress) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const steps = {
        initializing: modalElement.querySelector(".step-initializing"),
        preprocessing: modalElement.querySelector(".step-preprocessing"),
        indexing: modalElement.querySelector(".step-indexing"),
        calculating: modalElement.querySelector(".step-calculating"), // Represents trip processing
        complete: modalElement.querySelector(".step-complete"), // Represents finalizing/generating GeoJSON
      };

      // Reset all steps first
      Object.values(steps).forEach((step) => {
        if (step) step.classList.remove("active", "complete", "error");
      });

      // Determine state based on stage and progress
      if (stage === "error") {
        // Mark the step where the error likely occurred as 'error'
        // Mark preceding steps as 'complete'
        if (stage === "initializing" || progress < 5) {
          if (steps.initializing) steps.initializing.classList.add("error");
        } else if (stage === "preprocessing" || progress < 50) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing) steps.preprocessing.classList.add("error");
        } else if (stage === "indexing" || progress < 60) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("error");
        } else if (stage === "processing_trips" || progress < 90) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("error");
        } else {
          // Error during finalization/GeoJSON gen
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("complete");
          if (steps.complete) steps.complete.classList.add("error");
        }
      } else if (stage === "complete") {
        // Mark all steps as complete
        Object.values(steps).forEach((step) => {
          if (step) step.classList.add("complete");
        });
      } else {
        // Mark steps based on progress and stage name
        if (stage === "initializing") {
          if (steps.initializing) steps.initializing.classList.add("active");
        } else if (stage === "preprocessing") {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing) steps.preprocessing.classList.add("active");
        } else if (stage === "indexing") {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("active");
        } else if (stage === "processing_trips") {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("active");
        } else if (
          stage === "finalizing" ||
          stage === "complete_stats" ||
          stage === "generating_geojson"
        ) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("complete");
          if (steps.complete) steps.complete.classList.add("active");
        } else {
          // Default or unknown stage
          if (steps.initializing) steps.initializing.classList.add("active");
        }
      }
    }

    static getStageIcon(stage) {
      const icons = {
        initializing: '<i class="fas fa-cog fa-spin"></i>',
        preprocessing: '<i class="fas fa-map-marked-alt"></i>',
        loading_streets: '<i class="fas fa-map"></i>',
        indexing: '<i class="fas fa-project-diagram"></i>',
        counting_trips: '<i class="fas fa-calculator"></i>',
        processing_trips: '<i class="fas fa-route fa-spin"></i>',
        calculating: '<i class="fas fa-cogs fa-spin"></i>',
        finalizing: '<i class="fas fa-chart-line"></i>',
        generating_geojson: '<i class="fas fa-file-code fa-spin"></i>',
        complete_stats: '<i class="fas fa-check"></i>',
        complete: '<i class="fas fa-check-circle"></i>',
        error: '<i class="fas fa-exclamation-circle"></i>',
        warning: '<i class="fas fa-exclamation-triangle"></i>',
      };
      return icons[stage] || '<i class="fas fa-question-circle"></i>';
    }

    static getStageBadgeClass(stage) {
      const badges = {
        initializing: "bg-secondary",
        preprocessing: "bg-info",
        loading_streets: "bg-info",
        indexing: "bg-primary",
        counting_trips: "bg-primary",
        processing_trips: "bg-primary",
        calculating: "bg-primary",
        finalizing: "bg-info",
        generating_geojson: "bg-info",
        complete_stats: "bg-info",
        complete: "bg-success",
        error: "bg-danger",
        warning: "bg-warning",
      };
      return badges[stage] || "bg-secondary";
    }

    static formatStageName(stage) {
      const stageNames = {
        initializing: "Initializing",
        preprocessing: "Fetching Streets",
        loading_streets: "Loading Streets",
        indexing: "Building Street Index",
        counting_trips: "Analyzing Trips",
        processing_trips: "Processing Trips",
        calculating: "Calculating Coverage",
        finalizing: "Calculating Statistics",
        generating_geojson: "Generating Map Data",
        complete_stats: "Finalizing",
        complete: "Complete",
        error: "Error",
        warning: "Warning",
      };
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      );
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok)
          throw new Error(
            `Failed to fetch coverage areas (HTTP ${response.status})`,
          );
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");
        this.constructor.updateCoverageTable(data.areas); // Use static method

        // Apply responsive enhancements after table update
        this.enhanceResponsiveTables();

        // Re-initialize tooltips after table update
        this.initTooltips();
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        window.notificationManager.show(
          `Failed to load coverage areas: ${error.message}. Please refresh.`,
          "danger",
        );
      }
    }

    static updateCoverageTable(areas) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = ""; // Clear existing rows

      if (!areas || areas.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="7" class="text-center fst-italic text-muted">No coverage areas defined yet.</td></tr>';
        return;
      }

      // Sort areas, perhaps by name or status? Example: by name
      areas.sort((a, b) =>
        a.location.display_name.localeCompare(b.location.display_name),
      );

      areas.forEach((area) => {
        const row = document.createElement("tr");
        const status = area.status || "unknown";
        // Include all known processing stages
        const isProcessing = [
          "processing",
          "preprocessing",
          "calculating",
          "indexing",
          "finalizing",
          "generating_geojson",
          "complete_stats",
        ].includes(status);
        const hasError = status === "error";
        const isCanceled = status === "canceled";

        if (isProcessing) {
          row.classList.add("processing-row", "table-info"); // Add bootstrap class for visual cue
        } else if (hasError) {
          row.classList.add("table-danger");
        } else if (isCanceled) {
          row.classList.add("table-warning");
        }

        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        const totalLengthMiles = (area.total_length * 0.000621371).toFixed(2);
        const drivenLengthMiles = (area.driven_length * 0.000621371).toFixed(2);
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0"; // Handle null/undefined

        let progressBarColor = "bg-success";
        if (hasError || isCanceled) {
          progressBarColor = "bg-secondary"; // Grey out bar on error/cancel
        } else if (area.coverage_percentage < 25) {
          progressBarColor = "bg-danger";
        } else if (area.coverage_percentage < 75) {
          progressBarColor = "bg-warning";
        }

        // Escape location data for attribute
        const escapedLocation = JSON.stringify(area.location || {}).replace(
          /'/g,
          "'",
        );

        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${
              area._id
            }">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${
              hasError
                ? `<div class="text-danger small" title="${
                    area.last_error || ""
                  }"><i class="fas fa-exclamation-circle me-1"></i>Error</div>`
                : ""
            }
            ${
              isCanceled
                ? `<div class="text-warning small"><i class="fas fa-ban me-1"></i>Canceled</div>`
                : ""
            }
            ${
              isProcessing
                ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>${this.formatStageName(
                    status,
                  )}...</div>`
                : ""
            }
          </td>
          <td data-label="Total Length" class="text-end">${totalLengthMiles} mi</td>
          <td data-label="Driven Length" class="text-end">${drivenLengthMiles} mi</td>
          <td data-label="Coverage">
            <div class="progress" style="height: 20px;" title="${coveragePercentage}%">
              <div class="progress-bar ${progressBarColor}" role="progressbar"
                style="width: ${coveragePercentage}%;"
                aria-valuenow="${coveragePercentage}"
                aria-valuemin="0" aria-valuemax="100">
                ${coveragePercentage}%
              </div>
            </div>
          </td>
          <td data-label="Segments" class="text-end">${
            area.total_segments || 0
          }</td>
          <td data-label="Last Updated">${lastUpdated}</td>
          <td data-label="Actions">
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success update-coverage-btn" title="Full Update (Recalculate All)" data-location='${escapedLocation}' ${
                isProcessing ? "disabled" : ""
              } data-bs-toggle="tooltip" data-bs-title="Full update - recalculates all coverage data">
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-info update-incremental-btn" title="Quick Update (New Trips Only)" data-location='${escapedLocation}' ${
                isProcessing ? "disabled" : ""
              } data-bs-toggle="tooltip" data-bs-title="Quick update - only processes new trips">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-sm btn-danger delete-area-btn" title="Delete Area" data-location='${escapedLocation}' ${
                isProcessing ? "disabled" : ""
              } data-bs-toggle="tooltip" data-bs-title="Remove this area and all its coverage data">
                <i class="fas fa-trash-alt"></i>
              </button>
              ${
                isProcessing
                  ? `<button class="btn btn-sm btn-warning cancel-processing" title="Cancel Processing" data-location='${escapedLocation}' data-bs-toggle="tooltip" data-bs-title="Stop the current processing operation"><i class="fas fa-stop-circle"></i></button>`
                  : ""
              }
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    async updateCoverageForArea(location, mode = "full") {
      if (!location || !location.display_name) {
        window.notificationManager.show(
          "Invalid location data provided for update.",
          "warning",
        );
        return;
      }

      // Prevent multiple updates on the same location simultaneously
      if (
        this.currentProcessingLocation?.display_name === location.display_name
      ) {
        window.notificationManager.show(
          `Update already in progress for ${location.display_name}.`,
          "info",
        );
        return;
      }

      // Store the location for the entire process
      const processingLocation = { ...location };

      try {
        // --- Declare pollingSuccessful here ---
        let pollingSuccessful = false;
        // -------------------------------------

        this.currentProcessingLocation = processingLocation;
        this.task_id = null; // Reset task ID

        // Check if we are updating the currently displayed dashboard location
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id &&
          (await this.isSameLocation(
            this.selectedLocation.location,
            processingLocation,
          ));
        const displayedLocationId = isUpdatingDisplayedLocation
          ? this.selectedLocation._id
          : null;

        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${processingLocation.display_name}...`,
        );

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";
        // Send location properties directly (not nested) as expected by the API
        const payload = { ...processingLocation };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          // Properly handle validation errors (common with 422 responses)
          if (response.status === 422 && data.detail) {
            // Handle case where detail might be an array of validation errors
            if (Array.isArray(data.detail)) {
              const errorMessages = data.detail
                .map((err) =>
                  typeof err === "object" ? JSON.stringify(err) : String(err),
                )
                .join("\n");
              throw new Error(`Validation error: ${errorMessages}`);
            } else {
              throw new Error(`Validation error: ${data.detail}`);
            }
          } else {
            throw new Error(
              data.detail || `Failed to start update (HTTP ${response.status})`,
            );
          }
        }

        if (data.task_id) {
          this.task_id = data.task_id; // Store task ID
          this.activeTaskIds.add(data.task_id);
          // pollingSuccessful is already declared, just assign here
          // let pollingSuccessful = false; // <-- REMOVE this declaration

          try {
            // Poll for completion
            await this.pollCoverageProgress(data.task_id);
            pollingSuccessful = true; // Assign true on success
            window.notificationManager.show(
              `Coverage update for ${processingLocation.display_name} completed.`,
              "success",
            );
            // DO NOT hide modal here on success
          } catch (pollError) {
            // Ensure error is properly stringified
            const errorMessage =
              typeof pollError === "object"
                ? pollError.message || JSON.stringify(pollError)
                : String(pollError);

            window.notificationManager.show(
              `Coverage update for ${processingLocation.display_name} failed: ${errorMessage}`,
              "danger",
            );
            this.hideProgressModal(); // <-- Hide on polling error
            // Refresh areas on error
            await this.loadCoverageAreas();
            // We might want to return or throw here depending on desired flow
            return;
          } finally {
            this.activeTaskIds.delete(data.task_id);
            this.task_id = null; // Clear task ID

            // Only clear processing location if polling succeeded
            if (pollingSuccessful) {
              this.currentProcessingLocation = null;
            }
            // No automatic hiding here

            // Refresh areas list after polling attempt (success or fail)
            // Moved refresh outside the success path
          }
        } else {
          // No task ID
          this.hideProgressModal(); // <-- Hide if no task ID
          window.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning",
          );
        }

        // Refresh areas and dashboard AFTER polling attempt (success or fail)
        await this.loadCoverageAreas();
        // This check will now work correctly as pollingSuccessful is guaranteed to be defined
        if (pollingSuccessful && displayedLocationId) {
          await this.displayCoverageDashboard(displayedLocationId);
        }
      } catch (error) {
        // Error during initial API call or setup
        // Ensure error is properly stringified
        const errorMessage =
          typeof error === "object"
            ? error.message || JSON.stringify(error)
            : String(error);

        console.error("Error updating coverage:", error);
        window.notificationManager.show(
          `Coverage update failed: ${errorMessage}`,
          "danger",
        );
        this.hideProgressModal(); // <-- Hide on initial error
        await this.loadCoverageAreas();
        // Keep context as is - don't clear it here
      }
      // Removed finally block that was hiding the modal
    }

    // Helper to compare location objects (e.g., by display_name or osm_id)
    async isSameLocation(loc1, loc2) {
      if (!loc1 || !loc2) return false;
      // Compare by a reliable identifier, e.g., display_name or osm_id
      return (
        loc1.display_name === loc2.display_name ||
        (loc1.osm_id && loc1.osm_id === loc2.osm_id)
      );
    }

    async deleteArea(location) {
      if (!location || !location.display_name) {
        window.notificationManager.show(
          "Invalid location data for deletion.",
          "warning",
        );
        return;
      }

      const confirmed = await window.confirmationDialog.show({
        title: "Delete Coverage Area",
        message: `Are you sure you want to delete <strong>${location.display_name}</strong>?<br><br>
          This will permanently delete:
          <ul>
            <li>All street segments and their driven status</li>
            <li>All coverage statistics and metadata</li>
            <li>All cached map data</li>
            <li>All manual street markings</li>
          </ul>
          This action cannot be undone.`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        window.notificationManager.show(
          `Deleting coverage area: ${location.display_name}...`,
          "info",
        );

        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(location), // Send the full location object
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`,
          );
        }

        await this.loadCoverageAreas(); // Refresh the table

        // Hide dashboard if the deleted location was being viewed
        if (
          this.selectedLocation &&
          (await this.isSameLocation(this.selectedLocation.location, location))
        ) {
          const dashboard = document.getElementById("coverage-dashboard");
          if (dashboard) dashboard.style.display = "none";
          this.selectedLocation = null; // Clear selected location
          this.coverageMap = null; // Clear map instance
        }

        window.notificationManager.show(
          `Coverage area '${location.display_name}' and all associated data deleted successfully.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        window.notificationManager.show(
          `Error deleting coverage area: ${error.message}`,
          "danger",
        );
      }
    }

    setupAutoRefresh() {
      // Refresh the table periodically if any area is processing
      setInterval(async () => {
        const isProcessing = document.querySelector(".processing-row"); // Check if any row has the processing class
        if (isProcessing) {
          await this.loadCoverageAreas();
        }
      }, 7000); // Refresh every 7 seconds if something is processing
    }

    async pollCoverageProgress(taskId) {
      const maxRetries = 360; // ~30 minutes (5s interval)
      let retries = 0;
      let taskCompleted = false; // Use a simple flag for completion

      while (retries < maxRetries && !taskCompleted) {
        // Loop until complete or max retries
        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (response.status === 404) {
            throw new Error(
              "Task ID not found. It might have expired or been invalid.",
            );
          }
          if (!response.ok) {
            let errorDetail = `HTTP error ${response.status}`;
            try {
              const errorData = await response.json();
              errorDetail = errorData.detail || errorDetail;
            } catch (parseError) {
              /* Ignore */
            }
            throw new Error(`Failed to get coverage status: ${errorDetail}`);
          }

          let data;
          try {
            data = await response.json();

            // Basic validation
            if (!data || typeof data !== "object") {
              console.warn(
                `Task ${taskId}: Received invalid data format:`,
                data,
              );
              // Attempt to read response text for clues
              let responseText = "";
              try {
                responseText = await response.text();
              } catch (e) {}
              // If empty or suggests success, treat as potentially complete but keep polling
              if (
                !responseText ||
                responseText.trim() === "{}" ||
                responseText.includes("success")
              ) {
                console.warn(
                  `Task ${taskId}: Invalid data but suggests success. Continuing poll...`,
                );
                data = {
                  stage: "polling_check",
                  progress: 99,
                  message: "Checking final status...",
                  metrics: {},
                };
              } else {
                throw new Error("Invalid non-JSON response from server");
              }
            }

            // Ensure stage exists before processing
            const stage = data.stage || "unknown"; // Default to unknown if stage missing

            this.updateModalContent(data); // Update UI with latest data

            // Check for terminal states
            if (stage === "complete") {
              console.log(`Task ${taskId} completed successfully.`);
              taskCompleted = true; // Set flag to exit loop
              return data; // Return final data
            } else if (stage === "error") {
              console.error(
                `Task ${taskId} failed with error: ${data.error || "Unknown error"}`,
              );
              taskCompleted = true; // Set flag to exit loop
              throw new Error(data.error || "Coverage calculation failed");
            }
            // --- No premature completion based on missing stage ---
          } catch (jsonError) {
            console.error(
              `Error processing response for task ${taskId}:`,
              jsonError,
            );
            this.updateModalContent({
              stage: "error",
              progress: 0,
              message: "Error processing server response",
              error: jsonError.message || "Parse error",
              metrics: {},
            });
            taskCompleted = true; // Stop polling on parse error
            throw jsonError;
          }

          // Wait before next poll ONLY if not completed
          if (!taskCompleted) {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // 5-second interval
            retries++;
          }
        } catch (error) {
          const errorMessage =
            typeof error === "object"
              ? error.message || JSON.stringify(error)
              : String(error);
          console.error(
            `Error polling coverage progress for task ${taskId}:`,
            error,
          );
          // Update modal only if the task hasn't already completed with an error state reported by the backend
          if (!taskCompleted) {
            this.updateModalContent({
              stage: "error",
              progress: 0,
              message: `Polling failed: ${errorMessage}`,
              error: errorMessage,
              metrics: {},
            });
          }
          taskCompleted = true; // Stop polling on any significant error during fetch/processing
          throw error; // Re-throw to signal failure to the caller
        }
      } // End while loop

      // If loop finishes without completion
      if (!taskCompleted) {
        this.updateModalContent({
          stage: "error",
          progress: 0,
          message: "Polling timed out waiting for completion.",
          error: "Polling timed out",
          metrics: {},
        });
        throw new Error("Coverage calculation polling timed out");
      }
    }

    async displayCoverageDashboard(locationId) {
      const dashboardContainer = document.getElementById("coverage-dashboard");
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name",
      );
      const mapContainer = document.getElementById("coverage-map");
      const chartContainer = document.getElementById("street-type-chart");

      // Basic validation
      if (
        !dashboardContainer ||
        !dashboardLocationName ||
        !mapContainer ||
        !chartContainer
      ) {
        console.error("Dashboard elements not found in the DOM.");
        return;
      }

      // Improved loading indicator
      dashboardContainer.style.display = "block"; // Make dashboard visible first
      dashboardLocationName.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span> Loading...';
      mapContainer.innerHTML = `
        <div class="d-flex flex-column align-items-center justify-content-center p-5 text-center">
          <div class="spinner-border text-info mb-3" style="width: 3rem; height: 3rem;" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <p class="text-info mb-0">Loading map data...</p>
          <small class="text-muted">This may take a moment for large areas</small>
        </div>
      `;
      chartContainer.innerHTML = ""; // Clear chart area

      try {
        // Fetch detailed data
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to load coverage data");
        }

        this.selectedLocation = data.coverage; // Store full data
        const coverage = data.coverage;

        // Check data validity
        const hasStreetData = coverage.streets_geojson?.features?.length > 0;
        const needsReprocessing = coverage.needs_reprocessing || false;
        const hasError = coverage.has_error || false;
        const status = coverage.status || "unknown";

        // Update title
        let titleText = coverage.location_name || "Coverage Details";
        if (hasError)
          titleText += ' <span class="badge bg-danger">Error</span>';
        else if (needsReprocessing)
          titleText += ' <span class="badge bg-warning">Needs Update</span>';
        else if (
          status === "processing" ||
          status === "preprocessing" ||
          status === "calculating" ||
          status === "indexing" ||
          status === "finalizing" ||
          status === "generating_geojson" ||
          status === "complete_stats"
        )
          titleText += ' <span class="badge bg-info">Processing...</span>';
        else if (status === "completed" && !hasStreetData)
          titleText += ' <span class="badge bg-secondary">No Map Data</span>';
        else if (status === "completed")
          titleText += ' <span class="badge bg-success">Completed</span>';

        dashboardLocationName.innerHTML = titleText; // Use innerHTML for badge

        // Update stats regardless of map data
        this.updateDashboardStats(coverage);

        // Handle cases where map data is missing or invalid
        if (needsReprocessing || !hasStreetData) {
          let statusMessage;
          if (hasError) {
            statusMessage = `<div class="alert alert-danger">
              <h5><i class="fas fa-exclamation-circle me-2"></i>Error in Last Calculation</h5>
              <p>${
                coverage.error_message || "An unexpected error occurred."
              }</p>
              <hr>
              <p class="mb-1">Try running an update to resolve this issue:</p>
              <button class="update-missing-data-btn btn btn-sm btn-primary" data-location='${JSON.stringify(
                coverage.location || {},
              ).replace(/'/g, "'")}'>
                <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
              </button>
            </div>`;
          } else if (status === "completed" && !hasStreetData) {
            // Calculation completed, but GeoJSON might still be generating or failed
            statusMessage = `<div class="alert alert-info">
              <h5><i class="fas fa-spinner fa-spin me-2"></i>Finalizing Map Data</h5>
              <p>Coverage statistics calculated. Generating detailed map data...</p>
              <div class="progress mt-2">
                <div class="progress-bar progress-bar-striped progress-bar-animated" style="width: 100%"></div>
              </div>
            </div>`;

            // Auto-refresh
            setTimeout(() => this.displayCoverageDashboard(locationId), 8000); // Refresh after 8 seconds
          } else {
            statusMessage = `<div class="alert alert-warning">
              <h5><i class="fas fa-exclamation-triangle me-2"></i>Map Data Not Available</h5>
              <p>Please update the coverage data to generate the map:</p>
              <button class="update-missing-data-btn btn btn-sm btn-primary" data-location='${JSON.stringify(
                coverage.location || {},
              ).replace(/'/g, "'")}'>
                <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
              </button>
            </div>`;
          }

          mapContainer.innerHTML = statusMessage;
          chartContainer.innerHTML =
            '<div class="alert alert-secondary">Chart requires map data.</div>'; // Clear chart area

          // Show appropriate notification
          if (hasError)
            window.notificationManager.show(
              `Error loading map for ${coverage.location_name}`,
              "danger",
            );
          else if (status !== "completed")
            window.notificationManager.show(
              `Map data still processing for ${coverage.location_name}.`,
              "info",
            );

          // Scroll to dashboard
          dashboardContainer.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
          return; // Stop here
        }

        // --- Success Path: Has Street Data ---
        window.notificationManager.show(
          `Loaded coverage map for ${coverage.location_name}`,
          "success",
        );

        // Initialize map and chart
        this.initializeCoverageMap(coverage); // This now handles clearing/creating the map
        this.createStreetTypeChart(coverage.street_types);

        // Scroll to dashboard
        dashboardContainer.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });

        // Re-initialize tooltips after dashboard is shown
        this.initTooltips();
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
        chartContainer.innerHTML = ""; // Clear chart area
        window.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
      }
    }

    updateDashboardStats(coverage) {
      if (!coverage) return;

      // Use metric fields with '_m' suffix
      const totalLength = coverage.total_length_m || 0;
      const drivenLength = coverage.driven_length_m || 0;
      const driveableLength = coverage.driveable_length_m || 0; // Added driveable for potential use

      const totalMiles = (totalLength * 0.000621371).toFixed(2);
      const drivenMiles = (drivenLength * 0.000621371).toFixed(2);
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";

      // Update the coverage percentage bar (logic seems ok)
      const coverageBar = document.getElementById("coverage-percentage-bar");
      if (coverageBar) {
        coverageBar.style.width = `${coveragePercentage}%`;
        coverageBar.setAttribute("aria-valuenow", coveragePercentage);
        coverageBar.classList.remove(
          "bg-success",
          "bg-warning",
          "bg-danger",
          "bg-secondary",
        );
        let barColor = "bg-success";
        if (coverage.status === "error" || coverage.status === "canceled")
          barColor = "bg-secondary";
        else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
        else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";
        coverageBar.classList.add(barColor);
      }

      const coveragePercentageText = document.getElementById(
        "dashboard-coverage-percentage-text",
      );
      if (coveragePercentageText)
        coveragePercentageText.textContent = `${coveragePercentage}%`;

      // Update the stats
      const totalSegmentsEl = document.getElementById(
        "dashboard-total-segments",
      ); // Changed ID for clarity
      const totalLengthEl = document.getElementById("dashboard-total-length");
      const drivenLengthEl = document.getElementById("dashboard-driven-length");
      const lastUpdatedEl = document.getElementById("dashboard-last-updated");

      // Use total_segments from coverage data
      if (totalSegmentsEl)
        totalSegmentsEl.textContent =
          coverage.total_segments?.toLocaleString() || "0";
      if (totalLengthEl) totalLengthEl.textContent = `${totalMiles} miles`; // Or use this.distanceInUserUnits(totalLength)
      if (drivenLengthEl) drivenLengthEl.textContent = `${drivenMiles} miles`; // Or use this.distanceInUserUnits(drivenLength)
      if (lastUpdatedEl) {
        lastUpdatedEl.textContent = coverage.last_updated
          ? new Date(coverage.last_updated).toLocaleString()
          : "Never";
      }

      // Update street type coverage breakdown
      this.updateStreetTypeCoverage(coverage.street_types);
    }

    updateStreetTypeCoverage(streetTypes) {
      const streetTypeCoverageEl = document.getElementById(
        "street-type-coverage",
      );
      if (!streetTypeCoverageEl) return;

      if (!streetTypes || !streetTypes.length) {
        streetTypeCoverageEl.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data available.</div>';
        return;
      }

      // Sort by total length
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.total_length_m || 0) - (a.total_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6); // Show top 6

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        // Use metric fields and unit conversion
        const totalDist = this.distanceInUserUnits(type.total_length_m || 0);
        const coveredDist = this.distanceInUserUnits(
          type.covered_length_m || 0,
        );
        const driveableDist = this.distanceInUserUnits(
          type.driveable_length_m || 0,
        ); // Added driveable

        let barColor = "bg-success";
        if (type.coverage_percentage < 25) barColor = "bg-danger";
        else if (type.coverage_percentage < 75) barColor = "bg-warning";

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between mb-1">
              <small><strong>${this.formatStreetType(type.type)}</strong></small>
              <small>${coveragePct}% (${coveredDist} / ${driveableDist})</small>
            </div>
            <div class="progress" style="height: 8px;" title="${this.formatStreetType(type.type)}: ${coveragePct}% Covered">
              <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%"
                   aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
          </div>
        `;
      });

      streetTypeCoverageEl.innerHTML = html;
    }

    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      // Clear previous map instance if exists
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }
      // Ensure container is empty before initializing
      mapContainer.innerHTML = "";

      this.coverageMap = L.map("coverage-map", {
        attributionControl: false, // Will add manually later
        zoomControl: true,
        renderer: L.svg(), // Use SVG renderer
      });

      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: "abcd",
          maxZoom: 20, // Increase maxZoom slightly
          minZoom: 5, // Set a minZoom
        },
      ).addTo(this.coverageMap);

      // Add streets
      this.addStreetsToMap(coverage.streets_geojson); // This also sets this.mapBounds

      // Add hover effects
      this.addMapHoverEffects();

      // Fit map
      this.fitMapToBounds();

      // Add summary control
      this.addCoverageSummary(coverage);

      // Re-apply filter on zoom
      this.coverageMap.off("zoomend").on("zoomend", () => {
        // Use off first to prevent multiple listeners
        this.setMapFilter(this.currentFilter || "all");
      });
    }

    styleStreet(feature) {
      const isDriven = feature.properties.driven;
      const isUndriveable = feature.properties.undriveable;
      const streetType = feature.properties.highway || "unknown";
      const baseWeight = 3;
      let weight = baseWeight;

      // Adjust weight based on type for visual hierarchy
      if (["motorway", "trunk", "primary"].includes(streetType))
        weight = baseWeight + 2;
      else if (streetType === "secondary") weight = baseWeight + 1;
      else if (streetType === "tertiary") weight = baseWeight + 0.5;
      else if (
        [
          "service",
          "track",
          "footway",
          "path",
          "cycleway",
          "pedestrian",
          "steps",
        ].includes(streetType)
      )
        weight = baseWeight - 1;

      let color;
      let className;

      if (isUndriveable) {
        // Gray/blue for undriveable streets
        color = "#607d8b";
        className = "undriveable-street";
      } else if (isDriven) {
        // Green for driven streets
        color = "#4caf50";
        className = "driven-street";
      } else {
        // Red for undriven streets
        color = "#ff5252";
        className = "undriven-street";
      }

      return {
        color: color,
        weight: weight,
        opacity: 0.8,
        className: className, // For potential CSS/export styling
        dashArray: isUndriveable ? "4, 4" : null, // Dashed line for undriveable
      };
    }

    // 2. Update the addStreetsToMap method
    // Replace this entire method with the code below

    addStreetsToMap(geojson) {
      if (!this.coverageMap) return; // Ensure map exists

      // Clear existing street layers if they exist
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      } else {
        // Create layer group if it doesn't exist
        this.streetLayers = L.layerGroup().addTo(this.coverageMap);
      }

      // Store the raw GeoJSON data for filtering
      this.streetsGeoJson = geojson;
      this.currentFilter = "all"; // Reset filter on adding new data

      const streetsLayer = L.geoJSON(geojson, {
        style: (feature) => this.styleStreet(feature), // Use class method here
        filter: () => true, // Initially show all
        onEachFeature: (feature, layer) => {
          const props = feature.properties;
          // --- FIX: Read 'street_name' instead of 'name' ---
          const streetName = props.street_name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const lengthMiles = (props.segment_length * 0.000621371).toFixed(3); // Use segment_length
          const status = props.driven ? "Driven" : "Not Driven";
          const segmentId = props.segment_id || "N/A";

          // Store original style for resetting highlight
          // Note: layer.options contains the style set by the 'style' function
          layer.originalStyle = { ...layer.options };
          // Store the feature properties for use in manual marking
          layer.featureProperties = props;

          // Create popup content
          const popupContent = document.createElement("div");
          popupContent.className = "street-popup";
          popupContent.innerHTML = `
            <h6>${streetName}</h6>
            <hr class="my-1">
            <small>
              <strong>Type:</strong> ${this.formatStreetType(streetType)}<br>
              <strong>Length:</strong> ${lengthMiles} mi<br>
              <strong>Status:</strong> <span class="${
                props.driven ? "text-success" : "text-danger"
              }">${status}</span><br>
              ${
                props.undriveable
                  ? '<strong>Marked as:</strong> <span class="text-warning">Undriveable</span><br>'
                  : ""
              }
              <strong>ID:</strong> ${segmentId}
            </small>
            <div class="street-actions mt-2 d-flex gap-2">
              ${
                props.driven
                  ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn">Mark as Undriven</button>`
                  : `<button class="btn btn-sm btn-outline-success mark-driven-btn">Mark as Driven</button>`
              }
              ${
                props.undriveable
                  ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn">Mark as Driveable</button>`
                  : `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn">Mark as Undriveable</button>`
              }
            </div>
          `;

          // Add event listeners to the buttons
          const self = this;
          const markDrivenBtn = popupContent.querySelector(".mark-driven-btn");
          const markUndrivenBtn =
            popupContent.querySelector(".mark-undriven-btn");
          const markUndriveableBtn = popupContent.querySelector(
            ".mark-undriveable-btn",
          );
          const markDriveableBtn = popupContent.querySelector(
            ".mark-driveable-btn",
          );

          if (markDrivenBtn) {
            markDrivenBtn.addEventListener("click", function () {
              self.markStreetSegment(layer, "driven");
            });
          }

          if (markUndrivenBtn) {
            markUndrivenBtn.addEventListener("click", function () {
              self.markStreetSegment(layer, "undriven");
            });
          }

          if (markUndriveableBtn) {
            markUndriveableBtn.addEventListener("click", function () {
              self.markStreetSegment(layer, "undriveable");
            });
          }

          if (markDriveableBtn) {
            markDriveableBtn.addEventListener("click", function () {
              self.markStreetSegment(layer, "driveable");
            });
          }

          layer.bindPopup(popupContent, { closeButton: false, minWidth: 220 });

          // --- ADD Click handler for highlighting ---
          layer.on("click", (e) => {
            const clickedLayer = e.target;
            const infoPanel = document.querySelector(".map-info-panel"); // Find the panel

            // Reset previously highlighted layer
            if (
              this.highlightedLayer &&
              this.highlightedLayer !== clickedLayer
            ) {
              try {
                this.highlightedLayer.setStyle(
                  this.highlightedLayer.originalStyle,
                );
              } catch (styleError) {
                console.warn(
                  "Could not reset style on previously highlighted layer:",
                  styleError,
                );
              }
            }

            // If clicking the already highlighted layer, toggle it off
            if (this.highlightedLayer === clickedLayer) {
              clickedLayer.setStyle(clickedLayer.originalStyle); // Reset style
              this.highlightedLayer = null;
              if (infoPanel) infoPanel.style.display = "none"; // Hide panel
            } else {
              // Highlight the new layer
              const highlightStyle = {
                ...clickedLayer.originalStyle, // Start with original style (color, etc.)
                weight: (clickedLayer.originalStyle.weight || 3) + 2, // Increase weight
                opacity: 1, // Max opacity
              };
              clickedLayer.setStyle(highlightStyle);
              clickedLayer.bringToFront();
              this.highlightedLayer = clickedLayer;

              // Update and show the info panel
              if (infoPanel) {
                infoPanel.innerHTML = `
                  <strong class="d-block mb-1">${streetName}</strong>
                  <div class="d-flex justify-content-between small">
                    <span>Type:</span>
                    <span class="text-info">${this.formatStreetType(
                      streetType,
                    )}</span>
                  </div>
                  <div class="d-flex justify-content-between small">
                    <span>Length:</span>
                    <span class="text-info">${lengthMiles} mi</span>
                  </div>
                  <div class="d-flex justify-content-between small">
                    <span>Status:</span>
                    <span class="${
                      props.driven ? "text-success" : "text-danger"
                    }">
                      <i class="fas fa-${
                        props.driven ? "check-circle" : "times-circle"
                      } me-1"></i>
                      ${status}
                    </span>
                  </div>
                  ${
                    props.undriveable
                      ? `
                  <div class="d-flex justify-content-between small">
                    <span>Special:</span>
                    <span class="text-warning">
                      <i class="fas fa-exclamation-triangle me-1"></i>
                      Undriveable
                    </span>
                  </div>`
                      : ""
                  }
                  <div class="d-flex justify-content-between small">
                     <span>ID:</span>
                     <span class="text-muted">${segmentId}</span>
                  </div>
                  <div class="mt-2 d-flex gap-2 flex-wrap">
                    ${
                      props.driven
                        ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn-panel">Mark Undriven</button>`
                        : `<button class="btn btn-sm btn-outline-success mark-driven-btn-panel">Mark Driven</button>`
                    }
                    ${
                      props.undriveable
                        ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn-panel">Mark Driveable</button>`
                        : `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn-panel">Mark Undriveable</button>`
                    }
                  </div>`;
                infoPanel.style.display = "block"; // Show panel

                // Add event listeners to the panel buttons
                const markDrivenBtnPanel = infoPanel.querySelector(
                  ".mark-driven-btn-panel",
                );
                const markUndrivenBtnPanel = infoPanel.querySelector(
                  ".mark-undriven-btn-panel",
                );
                const markUndriveableBtnPanel = infoPanel.querySelector(
                  ".mark-undriveable-btn-panel",
                );
                const markDriveableBtnPanel = infoPanel.querySelector(
                  ".mark-driveable-btn-panel",
                );

                if (markDrivenBtnPanel) {
                  markDrivenBtnPanel.addEventListener("click", () => {
                    this.markStreetSegment(clickedLayer, "driven");
                  });
                }

                if (markUndrivenBtnPanel) {
                  markUndrivenBtnPanel.addEventListener("click", () => {
                    this.markStreetSegment(clickedLayer, "undriven");
                  });
                }

                if (markUndriveableBtnPanel) {
                  markUndriveableBtnPanel.addEventListener("click", () => {
                    this.markStreetSegment(clickedLayer, "undriveable");
                  });
                }

                if (markDriveableBtnPanel) {
                  markDriveableBtnPanel.addEventListener("click", () => {
                    this.markStreetSegment(clickedLayer, "driveable");
                  });
                }
              }
            }
          });
        },
      }).addTo(this.streetLayers); // Add to the layer group

      // Store bounds and the layer itself
      this.mapBounds = streetsLayer.getBounds();
      this.streetsGeoJsonLayer = streetsLayer; // Keep reference to the Leaflet layer
    }

    addMapHoverEffects() {
      if (!this.coverageMap || !this.streetLayers) return;

      let infoPanel = document.querySelector(".map-info-panel");
      // Create info panel if it doesn't exist (but don't add listeners here)
    }

    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;

      // Remove existing summary control if present
      if (this.coverageSummaryControl) {
        this.coverageMap.removeControl(this.coverageSummaryControl);
        this.coverageSummaryControl = null;
      }

      const CoverageSummaryControl = L.Control.extend({
        options: { position: "topright" },
        onAdd: () => {
          const container = L.DomUtil.create(
            "div",
            "coverage-summary-control leaflet-bar",
          );
          const coveragePercentage =
            coverage.coverage_percentage?.toFixed(1) || "0.0";
          const totalMiles = (coverage.total_length * 0.000621371).toFixed(2);
          const drivenMiles = (coverage.driven_length * 0.000621371).toFixed(2);

          let barColor = "bg-success";
          if (coverage.status === "error" || coverage.status === "canceled")
            barColor = "bg-secondary";
          else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
          else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";

          container.innerHTML = `
            <div class="summary-content">
              <div class="summary-title">Coverage Summary</div>
              <div class="summary-percentage">${coveragePercentage}%</div>
              <div class="summary-progress">
                <div class="progress" style="height: 6px;" title="${coveragePercentage}% Covered">
                  <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePercentage}%"></div>
                </div>
              </div>
              <div class="summary-details">
                <div>${drivenMiles} / ${totalMiles} miles</div>
              </div>
            </div>`;
          return container;
        },
      });

      this.coverageSummaryControl = new CoverageSummaryControl(); // Store reference
      this.coverageSummaryControl.addTo(this.coverageMap);

      // Ensure CSS is added only once
      if (!document.getElementById("coverage-summary-style")) {
        const style = document.createElement("style");
        style.id = "coverage-summary-style";
        style.textContent = `
            .coverage-summary-control { background: rgba(40, 40, 40, 0.9); color: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); border: none !important; min-width: 150px; }
            .summary-title { font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #ccc; }
            .summary-percentage { font-size: 24px; font-weight: bold; margin-bottom: 5px; color: #fff; }
            .summary-progress { margin-bottom: 8px; }
            .summary-details { font-size: 11px; color: #ccc; text-align: right; }
          `;
        document.head.appendChild(style);
      }
    }

    // Handle manually marking street segments as driven/undriven/undriveable/driveable
    async markStreetSegment(layer, action) {
      const props = layer.featureProperties;
      if (!props || !props.segment_id) {
        window.notificationManager.show(
          "Unable to mark street segment: missing segment ID",
          "danger",
        );
        return;
      }

      // Make sure we have the location ID
      if (!this.selectedLocation || !this.selectedLocation._id) {
        window.notificationManager.show(
          "Unable to mark street segment: missing location ID",
          "danger",
        );
        return;
      }

      const locationId = this.selectedLocation._id;
      const segmentId = props.segment_id;
      let apiEndpoint, statusText;

      switch (action) {
        case "driven":
          apiEndpoint = "/api/street_segments/mark_driven";
          statusText = "driven";
          break;
        case "undriven":
          apiEndpoint = "/api/street_segments/mark_undriven";
          statusText = "undriven";
          break;
        case "undriveable":
          apiEndpoint = "/api/street_segments/mark_undriveable";
          statusText = "undriveable";
          break;
        case "driveable":
          apiEndpoint = "/api/street_segments/mark_driveable";
          statusText = "driveable";
          break;
        default:
          window.notificationManager.show("Invalid action specified", "danger");
          return;
      }

      const streetName = props.street_name || "Unnamed Street";
      try {
        // Show processing notification
        window.notificationManager.show(
          `Marking ${streetName} as ${statusText}...`,
          "info",
        );

        // Send request to the API
        const response = await fetch(apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location_id: locationId,
            segment_id: segmentId,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.detail ||
              `Failed to mark segment (HTTP ${response.status})`,
          );
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "API returned failure");
        }

        // Update the layer properties with the new state
        if (action === "driven") {
          layer.featureProperties.driven = true;
          layer.featureProperties.undriveable = false;
        } else if (action === "undriven") {
          layer.featureProperties.driven = false;
        } else if (action === "undriveable") {
          layer.featureProperties.undriveable = true;
        } else if (action === "driveable") {
          layer.featureProperties.undriveable = false;
        }

        // Update the style of the layer
        const newStyle = this.styleStreet({
          properties: layer.featureProperties,
        });
        layer.setStyle(newStyle);
        layer.originalStyle = { ...newStyle }; // Update original style too

        // Close the popup if it's open
        if (layer.getPopup() && layer.getPopup().isOpen()) {
          this.coverageMap.closePopup();
        }

        // Update the highlighted layer display if this is the highlighted layer
        if (this.highlightedLayer === layer) {
          const infoPanel = document.querySelector(".map-info-panel");
          if (infoPanel) {
            // Re-click the layer to refresh the info panel
            layer.fire("click");
          }
        }

        // Success notification
        window.notificationManager.show(
          `Successfully marked ${streetName} as ${statusText}`,
          "success",
        );

        // Refresh the coverage statistics
        try {
          await this.refreshCoverageStats();
        } catch (statsError) {
          console.error("Error refreshing stats:", statsError);
          // Don't fail the entire operation if stats refresh fails
        }
      } catch (error) {
        console.error(`Error marking segment as ${statusText}:`, error);
        window.notificationManager.show(
          `Failed to mark segment as ${statusText}: ${error.message}`,
          "danger",
        );
      }
    }

    // Refresh the coverage statistics after marking a street
    async refreshCoverageStats() {
      if (!this.selectedLocation || !this.selectedLocation._id) return;

      try {
        const locationId = this.selectedLocation._id;
        const response = await fetch(
          `/api/coverage_areas/${locationId}/refresh_stats`,
          {
            method: "POST",
          },
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.detail ||
              `Failed to refresh stats (HTTP ${response.status})`,
          );
        }

        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "API returned failure");
        }

        // Update the dashboard with new stats
        this.updateDashboardStats(data.coverage);

        // Update the summary control
        this.addCoverageSummary(data.coverage);

        return data;
      } catch (error) {
        console.error("Error refreshing coverage stats:", error);
        throw error; // Re-throw to be handled by the caller
      }
    }

    fitMapToBounds() {
      // Ensure map and bounds are valid before fitting
      if (this.coverageMap && this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, { padding: [30, 30] }); // Increased padding slightly
      } else if (this.coverageMap) {
        // Fallback if bounds are invalid (e.g., single point or no data)
        this.coverageMap.setView([40, -95], 4); // Default view (e.g., center of US)
        console.warn("Map bounds invalid, setting default view.");
      }
    }
    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;

      // Clear previous chart instance
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }

      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data for chart.</div>';
        return;
      }

      if (typeof Chart === "undefined") {
        console.error("Chart.js is not loaded");
        chartContainer.innerHTML =
          '<div class="alert alert-warning">Chart.js library not found.</div>';
        return;
      }

      // Prepare data (top 7 types based on driveable length)
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.driveable_length_m || 0) - (a.driveable_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 7);
      const labels = topTypes.map((t) => this.formatStreetType(t.type));

      // Use distanceInUserUnits for data conversion
      const drivenLengths = topTypes.map((t) =>
        parseFloat(
          this.distanceInUserUnits(t.covered_length_m || 0, 2).split(" ")[0],
        ),
      );
      const driveableLengths = topTypes.map((t) =>
        parseFloat(
          this.distanceInUserUnits(t.driveable_length_m || 0, 2).split(" ")[0],
        ),
      );
      // Calculate not driven based on driveable length
      const notDrivenLengths = driveableLengths.map((total, i) =>
        parseFloat(Math.max(0, total - drivenLengths[i]).toFixed(2)),
      );
      const lengthUnit = this.useMiles ? "mi" : "km";

      // Ensure container has a canvas
      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      const drivenColor = "rgba(76, 175, 80, 0.8)"; // Green
      const notDrivenColor = "rgba(255, 82, 82, 0.7)"; // Red

      this.streetTypeChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Driven",
              data: drivenLengths,
              backgroundColor: drivenColor,
            },
            {
              label: "Not Driven (Driveable)",
              data: notDrivenLengths,
              backgroundColor: notDrivenColor,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y",
          scales: {
            x: {
              stacked: true,
              ticks: { color: "#ccc", font: { size: 10 } },
              grid: { color: "rgba(255, 255, 255, 0.1)" },
              title: {
                display: true,
                text: `Distance (${lengthUnit})`,
                color: "#ccc",
                font: { size: 11 },
              },
            },
            y: {
              stacked: true,
              ticks: { color: "#eee", font: { size: 11 } },
              grid: { display: false },
            },
          },
          plugins: {
            tooltip: {
              mode: "index",
              intersect: false,
              callbacks: {
                label: (context) => {
                  const label = context.dataset.label || "";
                  const value = context.raw || 0;
                  const total = driveableLengths[context.dataIndex]; // Use driveable length for total in tooltip
                  const percentage =
                    total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                  return `${label}: ${value.toFixed(2)} ${lengthUnit} (${percentage}%)`;
                },
                footer: (tooltipItems) => {
                  const total = driveableLengths[tooltipItems[0].dataIndex]; // Total driveable for the bar
                  return `Total Driveable: ${total.toFixed(2)} ${lengthUnit}`;
                },
              },
            },
            legend: {
              position: "bottom",
              labels: {
                color: "#eee",
                usePointStyle: true,
                padding: 10,
                font: { size: 11 },
              },
            },
            title: {
              display: true,
              text: "Driveable Coverage by Street Type (Top 7)",
              color: "#eee",
              padding: { top: 5, bottom: 10 },
            },
          },
        },
      });
    }

    formatStreetType(type) {
      if (!type) return "Unknown";
      // Capitalize first letter of each word, replace underscores
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }

    exportCoverageMap() {
      if (!this.coverageMap || typeof leafletImage === "undefined") {
        window.notificationManager.show(
          "Map export requires the leaflet-image library.",
          "warning",
        );
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation.location_name) {
        window.notificationManager.show(
          "Cannot export map: No location selected.",
          "warning",
        );
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const locationName = this.selectedLocation.location_name
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const filename = `coverage_map_${locationName}_${timestamp}.png`;

      window.notificationManager.show(
        "Generating map image (this may take a moment)...",
        "info",
      );

      // Ensure layers are visible (re-apply filter)
      this.setMapFilter(this.currentFilter || "all");

      // Force redraw and wait
      this.coverageMap.invalidateSize();
      setTimeout(() => {
        leafletImage(
          this.coverageMap,
          (err, canvas) => {
            if (err) {
              console.error("Error generating map image:", err);
              window.notificationManager.show(
                `Failed to generate map image: ${err.message || err}`,
                "danger",
              );
              return;
            }
            try {
              const link = document.createElement("a");
              link.download = filename;
              link.href = canvas.toDataURL("image/png");
              document.body.appendChild(link); // Required for Firefox
              link.click();
              document.body.removeChild(link);
              window.notificationManager.show(
                "Map image download started.",
                "success",
              );
            } catch (downloadError) {
              console.error("Error triggering download:", downloadError);
              window.notificationManager.show(
                "Failed to trigger map download.",
                "danger",
              );
            }
          },
          {
            // Options for leaflet-image - quality doesn't apply to PNG
            // svgRenderer: true, // Might cause issues with complex maps or specific browsers
            preferCanvas: true, // Often more reliable than SVG for export
          },
        );
      }, 800); // Increased delay slightly
    }

    setMapFilter(filterType) {
      if (!this.coverageMap || !this.streetsGeoJson || !this.streetLayers) {
        console.warn(
          "Cannot set map filter: Map or street data not initialized.",
        );
        return;
      }

      this.currentFilter = filterType;
      this.streetLayers.clearLayers(); // Clear previous layers from the group

      // Provide better visual distinction for active filter
      const filterButtons = {
        all: document.getElementById("show-all-streets"),
        driven: document.getElementById("show-driven-streets"),
        undriven: document.getElementById("show-undriven-streets"),
      };

      Object.keys(filterButtons).forEach((key) => {
        const btn = filterButtons[key];
        if (!btn) return;

        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
        );
        btn.classList.add("btn-outline-secondary");

        if (key === filterType) {
          btn.classList.add("active");
          if (key === "driven") {
            btn.classList.remove("btn-outline-secondary");
            btn.classList.add("btn-success");
          } else if (key === "undriven") {
            btn.classList.remove("btn-outline-secondary");
            btn.classList.add("btn-danger");
          } else {
            btn.classList.remove("btn-outline-secondary");
            btn.classList.add("btn-primary");
          }
        }
      });

      const filterFunc = (feature) => {
        if (filterType === "driven") return feature.properties.driven === true;
        if (filterType === "undriven")
          return feature.properties.driven === false;
        return true; // Default is 'all'
      };

      // Create and add the new filtered layer
      const filteredLayer = L.geoJSON(this.streetsGeoJson, {
        style: (feature) => this.styleStreet(feature), // Use class method here
        filter: filterFunc,
        onEachFeature: (feature, layer) => {
          // Re-bind popups and streetInfo for the filtered layer
          const props = feature.properties;
          const streetName = props.street_name || "Unnamed Street"; // Use street_name
          const streetType = props.highway || "unknown";
          const lengthMiles = (props.segment_length * 0.000621371).toFixed(3);
          const status = props.driven ? "Driven" : "Not Driven";
          const segmentId = props.segment_id || "N/A";

          layer.streetInfo = {
            name: streetName,
            type: streetType,
            length: lengthMiles,
            status: status,
            driven: props.driven,
            segmentId: segmentId,
          };

          layer.bindPopup(
            `
              <div class="street-popup"><h6>${streetName}</h6><hr class="my-1"><small>
              <strong>Type:</strong> ${this.formatStreetType(streetType)}<br>
              <strong>Length:</strong> ${lengthMiles} mi<br>
              <strong>Status:</strong> <span class="${
                props.driven ? "text-success" : "text-danger"
              }">${status}</span><br>
              <strong>ID:</strong> ${segmentId}</small></div>`,
            { closeButton: false, minWidth: 150 },
          );
        },
      }).addTo(this.streetLayers); // Add the filtered layer to the group

      this.streetsGeoJsonLayer = filteredLayer; // Update reference if needed for export

      // Re-add hover effects to the new layers within the group
      this.addMapHoverEffects();
    }

    toggleFilterButtonState(clickedButton) {
      document.querySelectorAll(".map-controls .btn").forEach((btn) => {
        btn.classList.remove("active", "btn-primary"); // Remove active state and primary color
        btn.classList.add("btn-outline-secondary"); // Set default outline style
      });
      clickedButton.classList.add("active", "btn-primary"); // Add active state and primary color
      clickedButton.classList.remove("btn-outline-secondary");
    }

    // Add unit conversion helper function
    distanceInUserUnits(meters, fixed = 2) {
      if (this.useMiles) {
        // Convert meters to miles (1 meter = 0.000621371 miles)
        return (meters * 0.000621371).toFixed(fixed) + " mi";
      } else {
        // Convert meters to kilometers
        return (meters / 1000).toFixed(fixed) + " km";
      }
    }
  } // End of CoverageManager class

  // Initialize on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    // Ensure Leaflet and Chart.js are loaded before initializing
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      console.error(
        "Leaflet or Chart.js not loaded. Coverage Manager initialization aborted.",
      );
      // Optionally display an error message to the user
      const errorDiv = document.getElementById("coverage-manager-error");
      if (errorDiv)
        errorDiv.innerHTML =
          '<div class="alert alert-danger">Required libraries (Leaflet, Chart.js) failed to load. Map and chart functionality will be unavailable.</div>';
      return;
    }
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized.");
  });
})(); // IIFE
