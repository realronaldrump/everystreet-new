/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */
"use strict";

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
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.activeTaskIds = new Set(); // Keep track of tasks being polled
      this.validatedLocation = null; // Stores result from /api/validate_location
      this.currentFilter = "all"; // Track current map filter ('all', 'driven', 'undriven')

      // Check for notification manager
      if (typeof window.notificationManager === "undefined") {
        console.warn(
          "notificationManager not found, fallbacks will use console.log"
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
          "confirmationDialog not found, fallbacks will use standard confirm()"
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
      });

      this.setupEventListeners();
      this.loadCoverageAreas();
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
          this.cancelProcessing(this.currentProcessingLocation)
        );

      // Disable "Add Area" button when location input changes
      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;
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
        });

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
              error
            );
            window.notificationManager.show(
              "Action failed: Invalid location data.",
              "danger"
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
          ".update-missing-data-btn"
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
              "danger"
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
              "warning"
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
      if (!locationInput) {
        window.notificationManager.show(
          "Please enter a location to validate.",
          "warning"
        );
        return;
      }

      const locTypeEl = document.getElementById("location-type");
      const locType = locTypeEl?.value;
      if (!locType) {
        window.notificationManager.show(
          "Please select a location type.",
          "warning"
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
            data.detail || `HTTP error! status: ${response.status}`
          );
        }

        if (!data || !data.osm_id) {
          // Check for essential data
          window.notificationManager.show(
            "Location not found or invalid response. Please check your input.",
            "warning"
          );
          this.validatedLocation = null;
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          return;
        }

        // Success
        this.validatedLocation = data;
        const addButton = document.getElementById("add-coverage-area");
        if (addButton) addButton.disabled = false;
        window.notificationManager.show(
          `Location validated: ${data.display_name}`,
          "success"
        );
      } catch (error) {
        console.error("Error validating location:", error);
        window.notificationManager.show(
          `Validation failed: ${error.message}. Please try again.`,
          "danger"
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
          "warning"
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
            area.location?.display_name === this.validatedLocation.display_name
        );

        if (exists) {
          window.notificationManager.show(
            "This area is already being tracked.",
            "warning"
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

        // Show progress modal immediately
        this.currentProcessingLocation = this.validatedLocation; // Set context for modal
        this.showProgressModal(
          `Starting processing for ${this.validatedLocation.display_name}...`,
          0
        );

        // Trigger the backend processing
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.validatedLocation), // Send the validated location object
        });

        const taskData = await preprocessResponse.json(); // Try parsing JSON regardless of status

        if (!preprocessResponse.ok) {
          // If backend fails, remove optimistic row and show error
          await this.loadCoverageAreas(); // Reload to remove temp row
          this.hideProgressModal();
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`
          );
        }

        window.notificationManager.show(
          "Coverage area processing started in background.",
          "info"
        );

        // Start polling if we got a task ID
        if (taskData?.task_id) {
          this.activeTaskIds.add(taskData.task_id);
          // Poll progress immediately after starting
          try {
            await this.pollCoverageProgress(taskData.task_id);
            // If polling finishes successfully (status complete)
            window.notificationManager.show(
              "Processing completed successfully!",
              "success"
            );
          } catch (pollError) {
            // Polling failed (error or timeout)
            window.notificationManager.show(
              `Processing failed: ${pollError.message}`,
              "danger"
            );
          } finally {
            this.activeTaskIds.delete(taskData.task_id);
            this.hideProgressModal(); // Hide modal after polling finishes or fails
            await this.loadCoverageAreas(); // Refresh table state
          }
        } else {
          // No task ID returned, hide modal and show generic message
          this.hideProgressModal();
          window.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning"
          );
          await this.loadCoverageAreas(); // Refresh table
        }

        // Reset input form
        const locationInput = document.getElementById("location-input");
        if (locationInput) locationInput.value = "";
        this.validatedLocation = null;
        // Add button remains disabled until next validation
      } catch (error) {
        console.error("Error adding coverage area:", error);
        window.notificationManager.show(
          `Failed to add coverage area: ${error.message}`,
          "danger"
        );
        this.hideProgressModal(); // Ensure modal is hidden on error
        await this.loadCoverageAreas(); // Refresh table to remove temp row if needed
      } finally {
        // Reset add button state
        addButton.disabled = true; // Keep disabled until next validation
        addButton.innerHTML = originalButtonText;
        this.currentProcessingLocation = null; // Clear context
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel || !locationToCancel.display_name) {
        window.notificationManager.show(
          "No active processing context found to cancel.",
          "warning"
        );
        return;
      }

      window.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info"
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
              `Failed to send cancel request (HTTP ${response.status})`
          );
        }

        window.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success"
        );
        this.hideProgressModal(); // Close the progress modal if it was open
        await this.loadCoverageAreas(); // Refresh the table to show 'canceled' status
      } catch (error) {
        console.error("Error cancelling processing:", error);
        window.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger"
        );
      } finally {
        this.currentProcessingLocation = null; // Clear context
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      // Ensure any previous modal instance is disposed
      const existingModal = bootstrap.Modal.getInstance(modalElement);
      if (existingModal) {
        existingModal.hide(); // Hide just in case, though dispose should handle it
      }

      const modal = new bootstrap.Modal(modalElement); // Create new instance

      const modalTitle = modalElement.querySelector(".modal-title");
      const progressMessageEl = modalElement.querySelector(".progress-message");
      const progressBarEl = modalElement.querySelector(".progress-bar");
      const stageInfoEl = modalElement.querySelector(".stage-info");
      const statsInfoEl = modalElement.querySelector(".stats-info");
      const elapsedTimeEl = modalElement.querySelector(".elapsed-time");
      const estimatedTimeEl = modalElement.querySelector(".estimated-time");

      // Set title based on current processing location
      if (modalTitle && this.currentProcessingLocation?.display_name) {
        modalTitle.textContent = `Processing: ${this.currentProcessingLocation.display_name}`;
      } else if (modalTitle) {
        modalTitle.textContent = "Processing Area";
      }

      if (progressMessageEl) progressMessageEl.textContent = message;
      if (progressBarEl) {
        progressBarEl.style.width = `${progress}%`;
        progressBarEl.setAttribute("aria-valuenow", progress);
        progressBarEl.classList.remove(
          "progress-bar-striped",
          "progress-bar-animated"
        );
        if (progress < 100) {
          progressBarEl.classList.add(
            "progress-bar-striped",
            "progress-bar-animated"
          );
        }
      }
      if (stageInfoEl) stageInfoEl.innerHTML = ""; // Clear previous stage
      if (statsInfoEl) statsInfoEl.innerHTML = ""; // Clear previous stats
      if (elapsedTimeEl) elapsedTimeEl.textContent = "Elapsed: 0s";
      if (estimatedTimeEl)
        estimatedTimeEl.textContent = "Est. remaining: calculating...";

      // Reset step states
      modalElement.querySelectorAll(".step").forEach((step) => {
        step.classList.remove("active", "complete", "error");
      });

      // Set initial step as active
      const initialStep = modalElement.querySelector(".step-initializing");
      if (initialStep) initialStep.classList.add("active");

      // Initialize timing
      this.processingStartTime = Date.now();
      this.lastProgressUpdate = { time: this.processingStartTime, progress: 0 };

      // Clear existing timer before starting a new one
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
      }
      this.progressTimer = setInterval(() => this.updateTimingInfo(), 1000);

      modal.show();
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) {
        modal.hide();
      }

      // Clear timer
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
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

      // Calculate estimated remaining time
      let estimatedText = "calculating...";
      const progressBar = document.querySelector(
        "#taskProgressModal .progress-bar"
      );
      if (!progressBar) return; // Ensure progress bar exists

      const currentProgress = parseInt(
        progressBar.getAttribute("aria-valuenow") || "0",
        10
      );

      // Only estimate if progress is meaningful and has changed
      if (
        currentProgress > 5 &&
        this.lastProgressUpdate &&
        this.lastProgressUpdate.progress !== currentProgress
      ) {
        const progressDelta =
          currentProgress - this.lastProgressUpdate.progress;
        const timeDelta = (now - this.lastProgressUpdate.time) / 1000; // seconds

        if (progressDelta > 0 && timeDelta > 0.5) {
          // Require some time delta
          const progressPerSecond = progressDelta / timeDelta;
          const remainingProgress = 100 - currentProgress;
          const estimatedRemainingSeconds = Math.ceil(
            remainingProgress / progressPerSecond
          );

          if (estimatedRemainingSeconds < 60) {
            estimatedText = `${estimatedRemainingSeconds}s`;
          } else if (estimatedRemainingSeconds < 3600) {
            const minutes = Math.floor(estimatedRemainingSeconds / 60);
            const seconds = estimatedRemainingSeconds % 60;
            estimatedText = `${minutes}m ${seconds}s`;
          } else if (estimatedRemainingSeconds < 86400) {
            // Less than a day
            const hours = Math.floor(estimatedRemainingSeconds / 3600);
            const minutes = Math.floor((estimatedRemainingSeconds % 3600) / 60);
            estimatedText = `${hours}h ${minutes}m`;
          } else {
            estimatedText = "> 1 day";
          }

          // Update last progress point for next calculation
          this.lastProgressUpdate = { time: now, progress: currentProgress };
        }
      } else if (currentProgress === 0 && elapsedSeconds > 10) {
        estimatedText = "pending..."; // If stuck at 0%
      } else if (currentProgress === 100) {
        estimatedText = "done";
      }

      // Update time display elements within the modal
      const elapsedTimeEl = document.querySelector(
        "#taskProgressModal .elapsed-time"
      );
      const estimatedTimeEl = document.querySelector(
        "#taskProgressModal .estimated-time"
      );

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      if (estimatedTimeEl)
        estimatedTimeEl.textContent = `Est. remaining: ${estimatedText}`;
    }

    // --- FIX: Update this function to always update UI elements ---
    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return; // Ensure modal exists

      const stage = data.stage || "unknown";
      const progress = data.progress || 0;
      const message = data.message || "";
      const error = data.error || null;

      // Update progress bar
      const progressBar = modalElement.querySelector(".progress-bar");
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        progressBar.classList.remove(
          "progress-bar-striped",
          "progress-bar-animated",
          "bg-danger"
        );
        if (stage === "error") {
          progressBar.classList.add("bg-danger");
        } else if (progress < 100) {
          progressBar.classList.add(
            "progress-bar-striped",
            "progress-bar-animated"
          );
        }
      }

      // Update message - show error message if present
      const progressMessageEl = modalElement.querySelector(".progress-message");
      if (progressMessageEl) {
        progressMessageEl.textContent = error ? `Error: ${error}` : message;
        progressMessageEl.classList.toggle("text-danger", !!error); // Add text-danger class on error
      }

      // Update step indicators
      this.updateStepIndicators(stage, progress);

      // Update stage information with icon
      const stageInfo = modalElement.querySelector(".stage-info");
      if (stageInfo) {
        stageInfo.innerHTML = `
          <span class="badge ${this.constructor.getStageBadgeClass(stage)}">
            ${this.constructor.getStageIcon(stage)}
            ${this.constructor.formatStageName(stage)}
          </span>
        `;
      }

      // Update stats information (e.g., trips processed)
      let statsText = "";
      const metrics = data.metrics || {}; // Use metrics from progress update if available
      if (metrics.total_trips_to_process > 0) {
        const processed = metrics.processed_trips || 0;
        const total = metrics.total_trips_to_process;
        const tripsProgress = total > 0 ? (processed / total) * 100 : 0;
        statsText += `<div class="mt-2">
            <div class="d-flex justify-content-between">
              <small>Trips Processed:</small>
              <small>${processed}/${total}</small>
            </div>
            <div class="progress mt-1" style="height: 5px;">
              <div class="progress-bar bg-info" style="width: ${tripsProgress}%"></div>
            </div>
          </div>`;
      }
      // Add other stats if needed from metrics...
      if (metrics.newly_covered_segments !== undefined) {
        statsText += `<div class="mt-1 d-flex justify-content-between"><small>New Segments Covered:</small><small>${metrics.newly_covered_segments}</small></div>`;
      }

      const statsInfoEl = modalElement.querySelector(".stats-info");
      if (statsInfoEl) statsInfoEl.innerHTML = statsText;

      // Stop animation and timer if complete or error
      if (stage === "complete" || stage === "error") {
        if (progressBar) {
          progressBar.classList.remove(
            "progress-bar-striped",
            "progress-bar-animated"
          );
        }
        if (this.progressTimer) {
          clearInterval(this.progressTimer);
          this.progressTimer = null;
          // Update estimated time to 'done' or 'failed'
          const estimatedTimeEl = modalElement.querySelector(".estimated-time");
          if (estimatedTimeEl)
            estimatedTimeEl.textContent = `Est. remaining: ${
              stage === "complete" ? "done" : "failed"
            }`;
        }
      }
    }

    updateStepIndicators(stage, progress) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const steps = {
        initializing: modalElement.querySelector(".step-initializing"),
        preprocessing: modalElement.querySelector(".step-preprocessing"), // Added preprocessing step
        indexing: modalElement.querySelector(".step-indexing"),
        calculating: modalElement.querySelector(".step-calculating"),
        complete: modalElement.querySelector(".step-complete"),
      };

      // Reset all steps first
      Object.values(steps).forEach((step) => {
        if (step) step.classList.remove("active", "complete", "error");
      });

      // Determine state based on stage and progress
      if (stage === "error") {
        // Mark the step where the error likely occurred as 'error'
        // Mark preceding steps as 'complete'
        if (progress < 5) {
          // Error during initialization
          if (steps.initializing) steps.initializing.classList.add("error");
        } else if (progress < 50) {
          // Error during preprocessing
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing) steps.preprocessing.classList.add("error");
        } else if (progress < 90) {
          // Error during calculation (indexing or trip processing)
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("error"); // Assume error during indexing/calc
          if (steps.calculating) steps.calculating.classList.add("error");
        } else {
          // Error during finalization
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("complete");
          if (steps.complete) steps.complete.classList.add("error"); // Mark complete step as error
        }
      } else if (stage === "complete") {
        // Mark all steps as complete
        Object.values(steps).forEach((step) => {
          if (step) step.classList.add("complete");
        });
      } else {
        // Mark steps based on progress and stage name
        if (stage === "initializing" || progress < 5) {
          if (steps.initializing) steps.initializing.classList.add("active");
        } else if (
          stage === "preprocessing" ||
          (progress >= 5 && progress < 50)
        ) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing) steps.preprocessing.classList.add("active");
        } else if (stage === "indexing" || (progress >= 50 && progress < 60)) {
          // Indexing phase
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("active");
        } else if (
          stage === "processing_trips" ||
          (progress >= 60 && progress < 95)
        ) {
          // Calculation phase
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("active");
        } else if (stage === "finalizing" || progress >= 95) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.calculating) steps.calculating.classList.add("complete");
          if (steps.complete) steps.complete.classList.add("active"); // Show complete step as active during finalization
        } else {
          // Default: mark initializing as active if stage is unknown
          if (steps.initializing) steps.initializing.classList.add("active");
        }
      }
    }

    static getStageIcon(stage) {
      // Add preprocessing icon
      const icons = {
        initializing: '<i class="fas fa-cog fa-spin"></i>',
        preprocessing: '<i class="fas fa-magic"></i>', // Example icon
        loading_streets: '<i class="fas fa-map"></i>', // Kept if needed, but maybe covered by preprocessing/indexing
        indexing: '<i class="fas fa-search-location"></i>', // More specific icon
        counting_trips: '<i class="fas fa-calculator"></i>',
        processing_trips: '<i class="fas fa-route"></i>', // Changed icon
        finalizing: '<i class="fas fa-flag-checkered"></i>', // Changed icon
        complete: '<i class="fas fa-check-circle"></i>',
        error: '<i class="fas fa-exclamation-circle"></i>',
        warning: '<i class="fas fa-exclamation-triangle"></i>', // Added warning state
        calculating: '<i class="fas fa-cogs fa-spin"></i>', // Generic calculating state
      };
      return icons[stage] || '<i class="fas fa-question-circle"></i>';
    }

    static getStageBadgeClass(stage) {
      // Add preprocessing badge class
      const badges = {
        initializing: "bg-secondary",
        preprocessing: "bg-info",
        loading_streets: "bg-info",
        indexing: "bg-primary",
        counting_trips: "bg-primary",
        processing_trips: "bg-primary",
        calculating: "bg-primary", // Generic calculating state
        finalizing: "bg-info",
        complete: "bg-success",
        error: "bg-danger",
        warning: "bg-warning", // Added warning state
      };
      return badges[stage] || "bg-secondary";
    }

    static formatStageName(stage) {
      // Add preprocessing stage name
      const stageNames = {
        initializing: "Initializing",
        preprocessing: "Preprocessing Streets",
        loading_streets: "Loading Streets",
        indexing: "Building Street Index",
        counting_trips: "Counting Trips",
        processing_trips: "Processing Trips",
        calculating: "Calculating Coverage", // Generic calculating state
        finalizing: "Finalizing Results",
        complete: "Completed",
        error: "Error",
        warning: "Warning", // Added warning state
      };
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      ); // Default formatting
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok)
          throw new Error(
            `Failed to fetch coverage areas (HTTP ${response.status})`
          );
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");
        this.constructor.updateCoverageTable(data.areas); // Use static method
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        window.notificationManager.show(
          `Failed to load coverage areas: ${error.message}. Please refresh.`,
          "danger"
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
        a.location.display_name.localeCompare(b.location.display_name)
      );

      areas.forEach((area) => {
        const row = document.createElement("tr");
        const status = area.status || "unknown";
        const isProcessing =
          status === "processing" ||
          status === "preprocessing" ||
          status === "calculating" ||
          status === "indexing" ||
          status === "finalizing"; // Add all processing stages
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
          "'"
        );

        row.innerHTML = `
          <td>
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
                ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>Processing...</div>`
                : ""
            }
          </td>
          <td class="text-end">${totalLengthMiles} mi</td>
          <td class="text-end">${drivenLengthMiles} mi</td>
          <td>
            <div class="progress" style="height: 20px;" title="${coveragePercentage}%">
              <div class="progress-bar ${progressBarColor}" role="progressbar"
                style="width: ${coveragePercentage}%;"
                aria-valuenow="${coveragePercentage}"
                aria-valuemin="0" aria-valuemax="100">
                ${coveragePercentage}%
              </div>
            </div>
          </td>
          <td class="text-end">${area.total_segments || 0}</td>
          <td>${lastUpdated}</td>
          <td>
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success update-coverage-btn" title="Full Update (Recalculate All)" data-location='${escapedLocation}' ${
          isProcessing ? "disabled" : ""
        }>
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-info update-incremental-btn" title="Quick Update (New Trips Only)" data-location='${escapedLocation}' ${
          isProcessing ? "disabled" : ""
        }>
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-sm btn-danger delete-area-btn" title="Delete Area" data-location='${escapedLocation}' ${
          isProcessing ? "disabled" : ""
        }>
                <i class="fas fa-trash-alt"></i>
              </button>
              ${
                isProcessing
                  ? `<button class="btn btn-sm btn-warning cancel-processing" title="Cancel Processing" data-location='${escapedLocation}'><i class="fas fa-stop-circle"></i></button>`
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
          "warning"
        );
        return;
      }

      // Prevent multiple updates on the same location simultaneously
      if (
        this.currentProcessingLocation?.display_name === location.display_name
      ) {
        window.notificationManager.show(
          `Update already in progress for ${location.display_name}.`,
          "info"
        );
        return;
      }

      try {
        this.currentProcessingLocation = location; // Set context

        // Check if we are updating the currently displayed dashboard location
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id &&
          (await this.isSameLocation(this.selectedLocation.location, location));
        const displayedLocationId = isUpdatingDisplayedLocation
          ? this.selectedLocation._id
          : null;

        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${location.display_name}...`
        );

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";
        const payload = { location: location }; // Send the location object directly

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to start update (HTTP ${response.status})`
          );
        }

        if (data.task_id) {
          this.activeTaskIds.add(data.task_id);
          try {
            // Poll for completion
            await this.pollCoverageProgress(data.task_id);
            window.notificationManager.show(
              `Coverage update for ${location.display_name} completed.`,
              "success"
            );
          } catch (pollError) {
            // Polling failed (error or timeout)
            window.notificationManager.show(
              `Coverage update for ${location.display_name} failed: ${pollError.message}`,
              "danger"
            );
            // Don't automatically hide modal on poll failure, user might want to see the error state
            // this.hideProgressModal(); // Keep modal open to show error state
            await this.loadCoverageAreas(); // Refresh table to show error status
            return; // Exit early
          } finally {
            this.activeTaskIds.delete(data.task_id);
          }
        } else {
          // No task ID, maybe immediate error or unexpected response
          window.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning"
          );
        }

        // --- Success Path ---
        this.hideProgressModal(); // Hide modal only after successful polling
        await this.loadCoverageAreas(); // Refresh table state

        // If we were viewing this location's dashboard, refresh it
        if (displayedLocationId) {
          await this.displayCoverageDashboard(displayedLocationId);
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        window.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger"
        );
        this.hideProgressModal(); // Ensure modal hides on error
        await this.loadCoverageAreas(); // Refresh table state
      } finally {
        this.currentProcessingLocation = null; // Clear context
      }
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
          "warning"
        );
        return;
      }

      const confirmed = await window.confirmationDialog.show({
        title: "Delete Coverage Area",
        message: `Are you sure you want to delete all coverage data and street segments for <strong>${location.display_name}</strong>? This action cannot be undone.`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        window.notificationManager.show(
          `Deleting coverage area: ${location.display_name}...`,
          "info"
        );

        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(location), // Send the full location object
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`
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
          `Coverage area '${location.display_name}' deleted successfully.`,
          "success"
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        window.notificationManager.show(
          `Error deleting coverage area: ${error.message}`,
          "danger"
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

    // --- FIX: Always call updateModalContent ---
    async pollCoverageProgress(taskId) {
      const maxRetries = 360; // ~30 minutes (5s interval) - adjust as needed
      let retries = 0;

      while (retries < maxRetries) {
        try {
          // Check if the modal is still supposed to be open for this task
          if (!this.currentProcessingLocation) {
            console.log(
              `Polling stopped for task ${taskId} as modal context was cleared.`
            );
            throw new Error("Processing context lost."); // Stop polling if modal context is gone
          }

          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (response.status === 404) {
            throw new Error(
              "Task ID not found. It might have expired or been invalid."
            );
          }
          if (!response.ok) {
            // Try to get error detail from response body
            let errorDetail = `HTTP error ${response.status}`;
            try {
              const errorData = await response.json();
              errorDetail = errorData.detail || errorDetail;
            } catch (parseError) {
              /* Ignore if response body isn't JSON */
            }
            throw new Error(`Failed to get coverage status: ${errorDetail}`);
          }

          const data = await response.json();

          // ALWAYS update modal content with the latest data
          this.updateModalContent(data);

          // Check for terminal states
          if (data.stage === "complete") {
            console.log(`Task ${taskId} completed.`);
            return data; // Success
          } else if (data.stage === "error") {
            console.error(`Task ${taskId} failed with error: ${data.error}`);
            throw new Error(
              data.message || data.error || "Coverage calculation failed"
            );
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 5000)); // 5-second interval
          retries++;
        } catch (error) {
          console.error(
            `Error polling coverage progress for task ${taskId}:`,
            error
          );
          this.updateModalContent({
            stage: "error",
            progress: 0,
            message: `Polling failed: ${error.message}`,
            error: error.message,
          }); // Update modal to show polling error
          throw error; // Re-throw to signal failure to the caller
        }
      }

      // If loop finishes without completion or error
      this.updateModalContent({
        stage: "error",
        progress: 0,
        message: "Polling timed out.",
        error: "Polling timed out",
      });
      throw new Error("Coverage calculation polling timed out");
    }

    // --- FIX: Use 'street_name' ---
    async displayCoverageDashboard(locationId) {
      const dashboardContainer = document.getElementById("coverage-dashboard");
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name"
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

      // Show loading state
      dashboardLocationName.textContent = "Loading...";
      mapContainer.innerHTML =
        '<div class="text-center p-5"><i class="fas fa-spinner fa-spin fa-3x"></i><p>Loading map data...</p></div>';
      chartContainer.innerHTML = ""; // Clear chart area
      dashboardContainer.style.display = "block"; // Make dashboard visible

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
          status === "calculating"
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
            statusMessage = `<h5><i class="fas fa-exclamation-circle me-2"></i>Error in Last Calculation</h5>
               <p>${
                 coverage.error_message || "An unknown error occurred."
               }</p>`;
          } else if (status === "completed" && !hasStreetData) {
            // Calculation completed, but GeoJSON might still be generating or failed
            statusMessage = `<h5><i class="fas fa-spinner fa-spin me-2"></i>Finalizing Map Data</h5>
               <p class="mb-0">Coverage statistics calculated. Generating detailed map data...</p>
               <p>This should complete shortly. If this message persists, the map data might have failed to generate.</p>`;
            // Optionally trigger a delayed refresh
            setTimeout(() => this.displayCoverageDashboard(locationId), 8000); // Refresh after 8 seconds
          } else {
            statusMessage = `<h5><i class="fas fa-exclamation-triangle me-2"></i>Street Map Data Not Available</h5>
               <p class="mb-1">Detailed street map data is not yet available.</p>
               <p class="small text-muted">This could be due to ongoing processing, a previous error, or the area having no streets.</p>`;
          }

          mapContainer.innerHTML = `
            <div class="alert alert-warning mt-3">
              ${statusMessage}
              <hr>
              <p class="mb-1">You can try initiating an update:</p>
              <button class="update-missing-data-btn btn btn-sm btn-primary" data-location='${JSON.stringify(
                coverage.location || {}
              ).replace(/'/g, "'")}'>
                <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
              </button>
            </div>`;
          chartContainer.innerHTML =
            '<div class="alert alert-secondary">Chart requires map data.</div>'; // Clear chart area

          // Show appropriate notification
          if (hasError)
            window.notificationManager.show(
              `Error loading map for ${coverage.location_name}`,
              "danger"
            );
          else if (status !== "completed")
            window.notificationManager.show(
              `Map data still processing for ${coverage.location_name}.`,
              "info"
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
          "success"
        );

        // Initialize map and chart
        this.initializeCoverageMap(coverage); // This now handles clearing/creating the map
        this.createStreetTypeChart(coverage.street_types);

        // Scroll to dashboard
        dashboardContainer.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
        chartContainer.innerHTML = ""; // Clear chart area
        window.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger"
        );
      }
    }

    updateDashboardStats(coverage) {
      if (!coverage) return;

      // Set the location name (handled in displayCoverageDashboard)

      const totalMiles = (coverage.total_length * 0.000621371).toFixed(2);
      const drivenMiles = (coverage.driven_length * 0.000621371).toFixed(2);
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";

      // Update the coverage percentage bar
      const coverageBar = document.getElementById("coverage-percentage-bar");
      if (coverageBar) {
        coverageBar.style.width = `${coveragePercentage}%`;
        coverageBar.setAttribute("aria-valuenow", coveragePercentage);
        coverageBar.classList.remove(
          "bg-success",
          "bg-warning",
          "bg-danger",
          "bg-secondary"
        ); // Reset colors
        let barColor = "bg-success";
        if (coverage.status === "error" || coverage.status === "canceled")
          barColor = "bg-secondary";
        else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
        else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";
        coverageBar.classList.add(barColor);
      }

      const coveragePercentageText = document.getElementById(
        "dashboard-coverage-percentage-text"
      );
      if (coveragePercentageText)
        coveragePercentageText.textContent = `${coveragePercentage}%`;

      // Update the stats
      const totalStreetsEl = document.getElementById("dashboard-total-streets");
      const totalLengthEl = document.getElementById("dashboard-total-length");
      const drivenLengthEl = document.getElementById("dashboard-driven-length");
      const lastUpdatedEl = document.getElementById("dashboard-last-updated");

      if (totalStreetsEl)
        totalStreetsEl.textContent =
          coverage.total_streets || coverage.total_segments || 0; // Use total_streets if available
      if (totalLengthEl) totalLengthEl.textContent = `${totalMiles} miles`;
      if (drivenLengthEl) drivenLengthEl.textContent = `${drivenMiles} miles`;
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
        "street-type-coverage"
      );
      if (!streetTypeCoverageEl) return;

      if (!streetTypes || !streetTypes.length) {
        streetTypeCoverageEl.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data available.</div>';
        return;
      }

      const sortedTypes = [...streetTypes].sort((a, b) => b.length - a.length);
      const topTypes = sortedTypes.slice(0, 6); // Show top 6

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        const totalMiles = (type.length * 0.000621371).toFixed(2);
        const coveredMiles = (type.covered_length * 0.000621371).toFixed(2);

        let barColor = "bg-success";
        if (type.coverage_percentage < 25) barColor = "bg-danger";
        else if (type.coverage_percentage < 75) barColor = "bg-warning";

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between mb-1">
              <small><strong>${this.formatStreetType(
                type.type
              )}</strong></small>
              <small>${coveragePct}% (${coveredMiles}/${totalMiles} mi)</small>
            </div>
            <div class="progress" style="height: 8px;" title="${this.formatStreetType(
              type.type
            )}: ${coveragePct}% Covered">
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
        }
      ).addTo(this.coverageMap);

      L.control
        .scale({ imperial: true, metric: false, position: "bottomleft" })
        .addTo(this.coverageMap);
      L.control
        .attribution({ position: "bottomright", prefix: false })
        .addTo(this.coverageMap); // Use prefix: false

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

    // --- FIX: Use 'street_name' ---
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

      const styleStreet = (feature) => {
        const isDriven = feature.properties.driven;
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

        return {
          color: isDriven ? "#4caf50" : "#ff5252", // Green for driven, Red for not driven
          weight: weight,
          opacity: 0.8,
          className: isDriven ? "driven-street" : "undriven-street", // For potential CSS/export styling
        };
      };

      const streetsLayer = L.geoJSON(geojson, {
        style: styleStreet,
        filter: () => true, // Initially show all
        onEachFeature: (feature, layer) => {
          const props = feature.properties;
          // --- FIX: Read 'street_name' instead of 'name' ---
          const streetName = props.street_name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const lengthMiles = (props.segment_length * 0.000621371).toFixed(3); // Use segment_length
          const status = props.driven ? "Driven" : "Not Driven";
          const segmentId = props.segment_id || "N/A";

          // Store info for hover effect
          layer.streetInfo = {
            name: streetName,
            type: streetType,
            length: lengthMiles,
            status: status,
            driven: props.driven,
            segmentId: segmentId,
          };

          // Create popup content
          layer.bindPopup(
            `
            <div class="street-popup">
              <h6>${streetName}</h6>
              <hr class="my-1">
              <small>
                <strong>Type:</strong> ${this.formatStreetType(streetType)}<br>
                <strong>Length:</strong> ${lengthMiles} mi<br>
                <strong>Status:</strong> <span class="${
                  props.driven ? "text-success" : "text-danger"
                }">${status}</span><br>
                <strong>ID:</strong> ${segmentId}
              </small>
            </div>
          `,
            { closeButton: false, minWidth: 150 }
          ); // Add some options
        },
      }).addTo(this.streetLayers); // Add to the layer group

      // Store bounds and the layer itself
      this.mapBounds = streetsLayer.getBounds();
      this.streetsGeoJsonLayer = streetsLayer; // Keep reference to the Leaflet layer
    }

    addMapHoverEffects() {
      if (!this.coverageMap || !this.streetLayers) return;

      let infoPanel = document.querySelector(".map-info-panel");
      // Create info panel if it doesn't exist
      if (!infoPanel) {
        infoPanel = L.DomUtil.create("div", "map-info-panel");
        infoPanel.style.display = "none"; // Initially hidden
        const mapContainer = document.getElementById("coverage-map");
        if (mapContainer) {
          mapContainer.appendChild(infoPanel);
          // Add CSS dynamically if needed (or ensure it's in your main CSS)
          if (!document.getElementById("map-info-panel-style")) {
            const style = document.createElement("style");
            style.id = "map-info-panel-style";
            style.textContent = `
                      .map-info-panel { position: absolute; z-index: 1000; background: rgba(40, 40, 40, 0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                      .map-info-panel .text-success { color: #4caf50 !important; }
                      .map-info-panel .text-danger { color: #ff5252 !important; }
                      .map-info-panel strong { color: #eee; }
                  `;
            document.head.appendChild(style);
          }
        } else {
          console.error("Map container not found for info panel.");
          return; // Cannot add panel
        }
      }

      this.streetLayers.eachLayer((layer) => {
        // Ensure original style is stored correctly
        if (
          !layer.originalStyle &&
          layer.options &&
          typeof layer.options.weight === "number"
        ) {
          layer.originalStyle = { ...layer.options };
        } else if (!layer.originalStyle) {
          // Fallback if options aren't as expected
          layer.originalStyle = {
            weight: 3,
            opacity: 0.8,
            color: layer.options?.color || "#ccc",
          };
        }

        layer.off("mouseover mouseout mousemove"); // Remove previous listeners

        layer.on("mouseover", (e) => {
          const targetLayer = e.target;
          // Highlight: Increase weight and opacity
          targetLayer.setStyle({
            weight: (targetLayer.originalStyle.weight || 3) + 2, // Use original weight
            opacity: 1,
          });
          targetLayer.bringToFront(); // Bring highlighted segment to front

          // Show info panel content
          if (targetLayer.streetInfo) {
            infoPanel.innerHTML = `
              <strong>${targetLayer.streetInfo.name}</strong><br>
              <small>Type: ${this.formatStreetType(
                targetLayer.streetInfo.type
              )} | Len: ${targetLayer.streetInfo.length} mi</small><br>
              <small>Status: <span class="${
                targetLayer.streetInfo.driven ? "text-success" : "text-danger"
              }">${targetLayer.streetInfo.status}</span></small>
            `;
            infoPanel.style.display = "block";
          }
        });

        layer.on("mouseout", (e) => {
          // Reset style using stored original style
          if (e.target.originalStyle) {
            e.target.setStyle(e.target.originalStyle);
          }
          // Hide info panel
          infoPanel.style.display = "none";
        });

        layer.on("mousemove", (e) => {
          // Update info panel position relative to map container
          const mapContainer = document.getElementById("coverage-map");
          if (!mapContainer) return;
          const rect = mapContainer.getBoundingClientRect();
          // Position slightly offset from cursor
          let x = e.originalEvent.clientX - rect.left + 15;
          let y = e.originalEvent.clientY - rect.top + 15;

          // Prevent panel from going off-screen
          if (x + infoPanel.offsetWidth > mapContainer.offsetWidth) {
            x -= infoPanel.offsetWidth + 30; // Move to left of cursor
          }
          if (y + infoPanel.offsetHeight > mapContainer.offsetHeight) {
            y -= infoPanel.offsetHeight + 30; // Move above cursor
          }

          infoPanel.style.left = `${x}px`;
          infoPanel.style.top = `${y}px`;
        });
      });
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
            "coverage-summary-control leaflet-bar"
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

      // Clear previous chart instance if it exists
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }

      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data for chart.</div>';
        return;
      }

      // Ensure Chart.js is loaded
      if (typeof Chart === "undefined") {
        console.error("Chart.js is not loaded");
        chartContainer.innerHTML =
          '<div class="alert alert-warning">Chart.js library not found.</div>';
        return;
      }

      // Prepare data (top 5-7 types)
      const sortedTypes = [...streetTypes].sort((a, b) => b.length - a.length);
      const topTypes = sortedTypes.slice(0, 7);
      const labels = topTypes.map((t) => this.formatStreetType(t.type));
      const totalLengths = topTypes.map((t) =>
        parseFloat((t.length * 0.000621371).toFixed(2))
      );
      const drivenLengths = topTypes.map((t) =>
        parseFloat((t.covered_length * 0.000621371).toFixed(2))
      );
      const notDrivenLengths = totalLengths.map((total, i) =>
        parseFloat((total - drivenLengths[i]).toFixed(2))
      );

      // Ensure container has a canvas
      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      const drivenColor = "rgba(76, 175, 80, 0.8)"; // Green
      const notDrivenColor = "rgba(255, 82, 82, 0.7)"; // Red (slightly transparent)

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
              label: "Not Driven",
              data: notDrivenLengths,
              backgroundColor: notDrivenColor,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y", // Horizontal bars
          scales: {
            x: {
              stacked: true,
              ticks: { color: "#ccc", font: { size: 10 } },
              grid: { color: "rgba(255, 255, 255, 0.1)" },
              title: {
                display: true,
                text: "Miles",
                color: "#ccc",
                font: { size: 11 },
              },
            },
            y: {
              stacked: true,
              ticks: { color: "#eee", font: { size: 11 } }, // Slightly larger labels
              grid: { display: false }, // Cleaner look
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
                  const total = totalLengths[context.dataIndex];
                  const percentage =
                    total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                  return `${label}: ${value.toFixed(2)} mi (${percentage}%)`;
                },
                footer: (tooltipItems) => {
                  // Calculate total for the bar
                  const total = tooltipItems.reduce(
                    (sum, item) => sum + (item.raw || 0),
                    0
                  );
                  return `Total: ${total.toFixed(2)} mi`;
                },
              },
            },
            legend: {
              position: "bottom", // Move legend to bottom
              labels: {
                color: "#eee",
                usePointStyle: true,
                padding: 10,
                font: { size: 11 },
              },
            },
            title: {
              display: true,
              text: "Coverage by Street Type (Top 7)",
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
          "warning"
        );
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation.location_name) {
        window.notificationManager.show(
          "Cannot export map: No location selected.",
          "warning"
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
        "info"
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
                "danger"
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
                "success"
              );
            } catch (downloadError) {
              console.error("Error triggering download:", downloadError);
              window.notificationManager.show(
                "Failed to trigger map download.",
                "danger"
              );
            }
          },
          {
            // Options for leaflet-image - quality doesn't apply to PNG
            // svgRenderer: true, // Might cause issues with complex maps or specific browsers
            preferCanvas: true, // Often more reliable than SVG for export
          }
        );
      }, 800); // Increased delay slightly
    }

    setMapFilter(filterType) {
      if (!this.coverageMap || !this.streetsGeoJson || !this.streetLayers) {
        console.warn(
          "Cannot set map filter: Map or street data not initialized."
        );
        return;
      }

      this.currentFilter = filterType;
      this.streetLayers.clearLayers(); // Clear previous layers from the group

      const styleStreet = (feature) => {
        // Re-use the styling logic from addStreetsToMap
        const isDriven = feature.properties.driven;
        const streetType = feature.properties.highway || "unknown";
        const baseWeight = 3;
        let weight = baseWeight;
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
        return {
          color: isDriven ? "#4caf50" : "#ff5252",
          weight: weight,
          opacity: 0.8,
          className: isDriven ? "driven-street" : "undriven-street",
        };
      };

      const filterFunc = (feature) => {
        if (filterType === "driven") return feature.properties.driven === true;
        if (filterType === "undriven")
          return feature.properties.driven === false;
        return true; // Default is 'all'
      };

      // Create and add the new filtered layer
      const filteredLayer = L.geoJSON(this.streetsGeoJson, {
        style: styleStreet,
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
            { closeButton: false, minWidth: 150 }
          );
        },
      });

      this.streetLayers.addLayer(filteredLayer); // Add the filtered layer to the group
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
  } // End of CoverageManager class

  // Initialize on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    // Ensure Leaflet and Chart.js are loaded before initializing
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      console.error(
        "Leaflet or Chart.js not loaded. Coverage Manager initialization aborted."
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
