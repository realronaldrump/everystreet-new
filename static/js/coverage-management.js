/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart, showNotification */
"use strict";

(() => {
  class CoverageManager {
    constructor() {
      this.locationData = null;
      this.map = null;
      this.coverageMap = null;
      this.streetLayers = null;
      this.selectedLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.activeTaskIds = new Set();
      this.validatedLocation = null;
      this.currentFilter = "all";

      // Check for notification manager
      if (typeof window.notificationManager === "undefined") {
        console.warn(
          "notificationManager not found, fallbacks will use console.log",
        );
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
          this.cancelProcessing(this.currentProcessingLocation),
        );

      // Minimize and reopen modal
      document
        .getElementById("minimize-modal")
        ?.addEventListener("click", () => this.minimizeModal());

      document
        .getElementById("reopen-modal")
        ?.addEventListener("click", () => this.reopenModal());

      // Real-time progress updates
      this.progressTimer = setInterval(() => this.updateProgress(), 1000);

      // Disable "Add Area" button when location input changes
      document
        .getElementById("location-input")
        ?.addEventListener("input", () => this.toggleAddButton());

      // Refresh coverage areas when the modal is closed
      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          this.loadCoverageAreas();
        });

      // Table action buttons
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          e.preventDefault();
          const target = e.target.closest("button");
          if (!target) return;

          // Extract the location data attribute
          const locationStr = target.dataset.location;
          if (!locationStr) return;

          try {
            const location = JSON.parse(locationStr);

            // Update coverage button
            if (target.classList.contains("update-coverage-btn")) {
              e.preventDefault();
              this.updateCoverageForArea(location);
            }
            // Delete area button
            else if (target.classList.contains("delete-area-btn")) {
              e.preventDefault();
              this.deleteArea(location);
            }
            // Cancel processing button (if it exists)
            else if (target.classList.contains("cancel-processing")) {
              e.preventDefault();
              this.cancelProcessing(location);
            }
          } catch (error) {
            console.error("Error parsing location data:", error);
          }
        });

      // Add click handler for location names in the table
      document.addEventListener("click", (e) => {
        const locationLink = e.target.closest(".location-name-link");
        if (locationLink) {
          e.preventDefault();
          const locationId = locationLink.dataset.locationId;
          this.displayCoverageDashboard(locationId);
        }
      });

      // Dashboard event delegation for the coverage map area
      document.addEventListener("click", (e) => {
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          try {
            const location = JSON.parse(updateMissingDataBtn.dataset.location);
            this.updateCoverageForArea(location);
          } catch (err) {
            console.error("Error parsing location data:", err);
          }
        }
      });

      // Export coverage map button
      document
        .getElementById("export-coverage-map")
        ?.addEventListener("click", () => {
          if (this.coverageMap) {
            this.exportCoverageMap();
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
      const locationInput = document
        .getElementById("location-input")
        ?.value.trim();
      if (!locationInput) {
        window.notificationManager.show(
          "Please enter a location to validate.",
          "warning",
        );
        return;
      }

      const locType = document.getElementById("location-type");
      if (!locType?.value) {
        window.notificationManager.show(
          "Please select a location type.",
          "warning",
        );
        return;
      }

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: locationInput,
            locationType: locType.value,
          }),
        });

        if (!response.ok) throw new Error("Failed to validate location");
        const data = await response.json();

        if (!data) {
          window.notificationManager.show(
            "Location not found. Please check your input.",
            "warning",
          );
          return;
        }

        this.validatedLocation = data;
        const addButton = document.getElementById("add-coverage-area");
        if (addButton) addButton.disabled = false;
        window.notificationManager.show(
          "Location validated successfully!",
          "success",
        );
      } catch (error) {
        console.error("Error validating location:", error);
        window.notificationManager.show(
          "Failed to validate location. Please try again.",
          "danger",
        );
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation) {
        window.notificationManager.show(
          "Please validate a location first.",
          "danger",
        );
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const { areas } = await response.json();

        const exists = areas.some(
          (area) =>
            area.location.display_name === this.validatedLocation.display_name,
        );

        if (exists) {
          window.notificationManager.show(
            "This area is already being tracked.",
            "warning",
          );
          return;
        }

        // Add the new area immediately to the table, marked as "processing"
        const newArea = {
          location: this.validatedLocation,
          total_length: 0,
          driven_length: 0,
          coverage_percentage: 0,
          total_segments: 0,
          last_updated: null, // Indicates that processing is underway
          status: "processing",
        };

        CoverageManager.updateCoverageTable([...areas, newArea]);

        this.showProgressModal("Starting background processing...", 0);
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: this.validatedLocation.display_name,
            location_type: document.getElementById("location-type").value,
          }),
        });

        if (!preprocessResponse.ok)
          throw new Error("Failed to start preprocessing");

        const taskData = await preprocessResponse.json();

        if (taskData?.task_id) {
          this.activeTaskIds.add(taskData.task_id);
        }

        window.notificationManager.show(
          "Coverage area processing started. You can check the status in the table.",
          "success",
        );

        // Reset input and validated state
        const locationInput = document.getElementById("location-input");
        const addButton = document.getElementById("add-coverage-area");

        if (locationInput) locationInput.value = "";
        if (addButton) addButton.disabled = true;

        this.validatedLocation = null;
      } catch (error) {
        console.error("Error adding coverage area:", error);
        window.notificationManager.show(
          "Failed to add coverage area. Please try again.",
          "danger",
        );
      } finally {
        this.hideProgressModal();
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel) {
        window.notificationManager.show(
          "No active processing to cancel.",
          "warning",
        );
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: locationToCancel }),
        });

        if (!response.ok) throw new Error("Failed to cancel processing");

        window.notificationManager.show(
          "Processing cancelled successfully.",
          "success",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        window.notificationManager.show(
          "Failed to cancel processing. Please try again.",
          "danger",
        );
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const modal = new bootstrap.Modal(modalElement);

      const progressMessageEl = document.querySelector(".progress-message");
      const progressBarEl = document.querySelector(".progress-bar");

      if (progressMessageEl) progressMessageEl.textContent = message;

      if (progressBarEl) {
        progressBarEl.style.width = `${progress}%`;
        progressBarEl.setAttribute("aria-valuenow", progress);
      }

      // Reset step states
      document.querySelectorAll(".step").forEach((step) => {
        step.classList.remove("active", "complete", "error");
      });

      // Set initial step as active
      const initialStep = document.querySelector(".step-initializing");
      if (initialStep) initialStep.classList.add("active");

      // Initialize timing
      this.processingStartTime = Date.now();
      this.lastProgressUpdate = {
        time: this.processingStartTime,
        progress: 0,
      };

      // Start timer
      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();
      }, 1000);

      modal.show();
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) modal.hide();

      // Clear timer
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    }

    updateTimingInfo() {
      if (!this.processingStartTime) return;

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

      // Calculate estimated remaining time if we have progress data
      let estimatedText = "calculating...";
      const progressBar = document.querySelector(".progress-bar");
      if (!progressBar) return;

      const currentProgress = parseInt(
        progressBar.getAttribute("aria-valuenow"),
        10,
      );

      if (
        currentProgress > 5 &&
        this.lastProgressUpdate.progress !== currentProgress
      ) {
        // Calculate rate of progress
        const progressDelta =
          currentProgress - this.lastProgressUpdate.progress;
        const timeDelta = (now - this.lastProgressUpdate.time) / 1000; // in seconds

        if (progressDelta > 0 && timeDelta > 0) {
          const progressPerSecond = progressDelta / timeDelta;
          const remainingProgress = 100 - currentProgress;
          const estimatedRemainingSeconds = Math.ceil(
            remainingProgress / progressPerSecond,
          );

          // Format estimated time
          if (estimatedRemainingSeconds < 60) {
            estimatedText = `${estimatedRemainingSeconds}s`;
          } else if (estimatedRemainingSeconds < 3600) {
            const minutes = Math.floor(estimatedRemainingSeconds / 60);
            const seconds = estimatedRemainingSeconds % 60;
            estimatedText = `${minutes}m ${seconds}s`;
          } else {
            estimatedText = "> 1h";
          }

          // Update last progress point
          this.lastProgressUpdate = {
            time: now,
            progress: currentProgress,
          };
        }
      }

      // Update time display
      const elapsedTimeEl = document.querySelector(".elapsed-time");
      const estimatedTimeEl = document.querySelector(".estimated-time");

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      if (estimatedTimeEl)
        estimatedTimeEl.textContent = `Est. remaining: ${estimatedText}`;
    }

    updateModalContent(data) {
      const stage = data.stage || "unknown";
      const progress = data.progress || 0;
      const message = data.message || "";

      // Update progress bar
      const progressBar = document.querySelector(".progress-bar");
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
      }

      // Update message
      const progressMessageEl = document.querySelector(".progress-message");
      if (progressMessageEl) progressMessageEl.textContent = message;

      // Update step indicators
      this.updateStepIndicators(stage, progress);

      // Update stage information with icon
      const stageInfo = document.querySelector(".stage-info");
      if (stageInfo) {
        stageInfo.innerHTML = `
          <span class="badge ${this.constructor.getStageBadgeClass(stage)}">
            ${this.constructor.getStageIcon(stage)} 
            ${this.constructor.formatStageName(stage)}
          </span>
        `;
      }

      // Update stats information
      let statsText = "";
      if (stage === "processing_trips" && data.message) {
        const matches = data.message.match(/Processed (\d+) of (\d+) trips/);
        if (matches && matches.length === 3) {
          const [, processed, total] = matches;
          statsText = `<div class="mt-2">
            <div class="d-flex justify-content-between">
              <small>Trips Processed:</small>
              <small>${processed}/${total}</small>
            </div>
            <div class="progress mt-1" style="height: 5px;">
              <div class="progress-bar bg-info" style="width: ${
                (parseInt(processed, 10) / parseInt(total, 10)) * 100
              }%"></div>
            </div>
          </div>`;
        }
      }

      const statsInfoEl = document.querySelector(".stats-info");
      if (statsInfoEl) statsInfoEl.innerHTML = statsText;
    }

    updateStepIndicators(stage, progress) {
      // Reset all steps
      document.querySelectorAll(".step").forEach((step) => {
        step.classList.remove("active", "complete", "error");
      });

      // Determine which steps should be marked based on stage
      if (stage === "error") {
        // Mark the error step
        let errorStep;
        if (progress < 20) {
          errorStep = document.querySelector(".step-initializing");
        } else if (progress < 40) {
          errorStep = document.querySelector(".step-loading");
          document
            .querySelector(".step-initializing")
            ?.classList.add("complete");
        } else {
          errorStep = document.querySelector(".step-processing");
          document
            .querySelector(".step-initializing")
            ?.classList.add("complete");
          document.querySelector(".step-loading")?.classList.add("complete");
        }

        if (errorStep) errorStep.classList.add("error");
      } else if (stage === "complete") {
        // Mark all steps as complete
        document.querySelectorAll(".step").forEach((step) => {
          step.classList.add("complete");
        });
      } else {
        // Mark steps based on progress and stage
        if (stage === "initializing" || progress <= 10) {
          document.querySelector(".step-initializing")?.classList.add("active");
        } else if (
          stage === "loading_streets" ||
          stage === "indexing" ||
          (progress > 10 && progress <= 40)
        ) {
          document
            .querySelector(".step-initializing")
            ?.classList.add("complete");
          document.querySelector(".step-loading")?.classList.add("active");
        } else if (
          stage === "counting_trips" ||
          stage === "processing_trips" ||
          (progress > 40 && progress < 95)
        ) {
          document
            .querySelector(".step-initializing")
            ?.classList.add("complete");
          document.querySelector(".step-loading")?.classList.add("complete");
          document.querySelector(".step-processing")?.classList.add("active");
        } else if (stage === "finalizing" || progress >= 95) {
          document
            .querySelector(".step-initializing")
            ?.classList.add("complete");
          document.querySelector(".step-loading")?.classList.add("complete");
          document.querySelector(".step-processing")?.classList.add("complete");
          document.querySelector(".step-complete")?.classList.add("active");
        }
      }
    }

    static getStageIcon(stage) {
      const icons = {
        initializing: '<i class="fas fa-cog fa-spin"></i>',
        loading_streets: '<i class="fas fa-map"></i>',
        indexing: '<i class="fas fa-search"></i>',
        counting_trips: '<i class="fas fa-calculator"></i>',
        processing_trips: '<i class="fas fa-road"></i>',
        finalizing: '<i class="fas fa-check-circle"></i>',
        complete: '<i class="fas fa-check-circle"></i>',
        error: '<i class="fas fa-exclamation-circle"></i>',
      };
      return icons[stage] || '<i class="fas fa-question-circle"></i>';
    }

    static getStageBadgeClass(stage) {
      const badges = {
        initializing: "bg-secondary",
        loading_streets: "bg-info",
        indexing: "bg-info",
        counting_trips: "bg-primary",
        processing_trips: "bg-primary",
        finalizing: "bg-info",
        complete: "bg-success",
        error: "bg-danger",
      };
      return badges[stage] || "bg-secondary";
    }

    static formatStageName(stage) {
      const stageNames = {
        initializing: "Initializing",
        loading_streets: "Loading Streets",
        indexing: "Building Street Index",
        counting_trips: "Counting Trips",
        processing_trips: "Processing Trips",
        finalizing: "Finalizing Results",
        complete: "Completed",
        error: "Error",
      };
      return stageNames[stage] || stage;
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const data = await response.json();
        this.constructor.updateCoverageTable(data.areas);
      } catch (error) {
        console.error("Error loading coverage areas: %s", error);
        window.notificationManager.show(
          "Failed to load coverage areas. Please refresh the page.",
          "danger",
        );
      }
    }

    static updateCoverageTable(areas) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = "";

      if (!areas || areas.length === 0) {
        const row = document.createElement("tr");
        row.innerHTML =
          '<td colspan="7" class="text-center">No coverage areas found</td>';
        tableBody.appendChild(row);
        return;
      }

      areas.forEach((area) => {
        const row = document.createElement("tr");
        if (area.status === "processing") {
          row.classList.add("processing-row");
        }

        // Format dates
        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";

        // Convert meters to miles
        const totalLengthMiles = (area.total_length * 0.000621371).toFixed(2);
        const drivenLengthMiles = (area.driven_length * 0.000621371).toFixed(2);

        row.innerHTML = `
          <td>
            <a href="#" class="location-name-link text-info" data-location-id="${
              area._id
            }">
              ${area.location.display_name}
            </a>
          </td>
          <td>${totalLengthMiles} miles</td>
          <td>${drivenLengthMiles} miles</td>
          <td>
            <div class="progress" style="height: 20px;">
              <div class="progress-bar bg-success" role="progressbar"
                style="width: ${area.coverage_percentage.toFixed(1)}%;" 
                aria-valuenow="${area.coverage_percentage.toFixed(1)}" 
                aria-valuemin="0" aria-valuemax="100">
                ${area.coverage_percentage.toFixed(1)}%
              </div>
            </div>
          </td>
          <td>${area.total_segments || 0}</td>
          <td>${lastUpdated}</td>
          <td>
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success update-coverage-btn" data-location='${JSON.stringify(
                area.location,
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-danger delete-area-btn" data-location='${JSON.stringify(
                area.location,
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    async updateCoverageForArea(location) {
      if (!location) return;

      try {
        // Store the current location being processed
        this.currentProcessingLocation = location;

        // Capture the current location ID if we're viewing it in the dashboard
        const isUpdatingDisplayedLocation =
          this.selectedLocation &&
          this.selectedLocation.location &&
          this.selectedLocation.location.display_name === location.display_name;

        const lastLocationId = isUpdatingDisplayedLocation
          ? this.selectedLocation._id
          : null;

        this.showProgressModal("Requesting coverage update...");

        // Call the update endpoint
        const response = await fetch("/api/street_coverage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            location: location,
            update: true,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          this.hideProgressModal();
          showNotification(
            `Error updating coverage: ${data.detail || "Unknown error"}`,
            "error",
          );
          return;
        }

        if (data.task_id) {
          this.pollCoverageProgress(data.task_id);
        }

        // Reload data after processing completes
        await this.loadCoverageAreas();

        // If we were looking at this location's dashboard, refresh it
        if (lastLocationId) {
          await this.displayCoverageDashboard(lastLocationId);
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        showNotification(
          "An error occurred while updating coverage. Please try again.",
          "danger",
        );
      } finally {
        this.hideProgressModal();
        this.currentProcessingLocation = null;
      }
    }

    async deleteArea(location) {
      if (!location) return;

      let confirmed = false;

      if (window.confirmationDialog) {
        confirmed = await window.confirmationDialog.show({
          title: "Delete Coverage Area",
          message: `Are you sure you want to delete coverage for ${location.display_name}?`,
          confirmText: "Delete",
          confirmButtonClass: "btn-danger",
        });
      } else {
        confirmed = confirm(
          `Are you sure you want to delete coverage for ${location.display_name}?`,
        );
      }

      if (!confirmed) {
        return;
      }

      try {
        window.notificationManager.show(
          `Deleting coverage area for ${location.display_name}...`,
          "info",
        );

        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            location: location,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to delete coverage area");
        }

        await this.loadCoverageAreas();

        // Hide dashboard if we were viewing the deleted location
        if (
          this.selectedLocation &&
          this.selectedLocation.location_name === location.display_name
        ) {
          const dashboard = document.getElementById("coverage-dashboard");
          if (dashboard) dashboard.style.display = "none";
          this.selectedLocation = null;
        }

        window.notificationManager.show(
          `Coverage area deleted successfully`,
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
      setInterval(async () => {
        const processingRows = document.querySelectorAll(".processing-row");
        if (processingRows.length > 0) {
          await this.loadCoverageAreas();
        }
      }, 5000);
    }

    async pollCoverageProgress(taskId) {
      const maxRetries = 180; // Approximately 15 minutes (with 5-second intervals)
      let retries = 0;
      let lastProgress = -1;

      while (retries < maxRetries) {
        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (!response.ok) throw new Error("Failed to get coverage status");

          const data = await response.json();

          if (data.progress !== lastProgress) {
            this.updateModalContent(data);
            lastProgress = data.progress;
          }

          if (data.stage === "complete") {
            return data;
          } else if (data.stage === "error") {
            throw new Error(data.message || "Coverage calculation failed");
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
          retries++;
        } catch (error) {
          console.error("Error polling coverage progress:", error);
          throw error;
        }
      }
      throw new Error("Coverage calculation timed out");
    }

    async displayCoverageDashboard(locationId) {
      try {
        // Show loading indicator
        const dashboardLocationName = document.getElementById(
          "dashboard-location-name",
        );
        const coverageDashboard = document.getElementById("coverage-dashboard");

        if (dashboardLocationName)
          dashboardLocationName.textContent = "Loading...";
        if (coverageDashboard) coverageDashboard.style.display = "block";

        // Fetch the detailed coverage data
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to load coverage data");
        }

        // Store the selected location for later use
        this.selectedLocation = data.coverage;

        // Check if there's any street data or if reprocessing is needed
        const hasStreetData =
          data.coverage.streets_geojson &&
          data.coverage.streets_geojson.features &&
          data.coverage.streets_geojson.features.length > 0;

        const needsReprocessing = data.coverage.needs_reprocessing || false;
        const hasError = data.coverage.has_error || false;

        // Update the dashboard title and show appropriate status if needed
        let titleText = data.coverage.location_name;
        if (hasError) {
          titleText += " (Error)";
        } else if (needsReprocessing) {
          titleText += " (Needs Update)";
        }

        if (dashboardLocationName)
          dashboardLocationName.textContent = titleText;

        // Update the dashboard stats
        this.updateDashboardStats(data.coverage);

        if (needsReprocessing || !hasStreetData) {
          // Show a message if there's no street data or reprocessing is needed
          const mapContainer = document.getElementById("coverage-map");
          if (!mapContainer) return;

          const statusMessage = hasError
            ? `<h5><i class="fas fa-exclamation-circle me-2"></i>Error in coverage calculation</h5>
               <p>${
                 data.coverage.error_message ||
                 "An unknown error occurred during coverage calculation."
               }</p>`
            : `<h5><i class="fas fa-exclamation-triangle me-2"></i>No street data available</h5>
               <p class="mb-0">Street data for this location is missing. This may be because:</p>
               <ul>
                 <li>The coverage calculation is still processing</li>
                 <li>The coverage calculation encountered an error</li>
                 <li>The location doesn't have any mapped streets</li>
               </ul>`;

          mapContainer.innerHTML = `
            <div class="alert alert-warning">
              ${statusMessage}
              <p>Try updating the coverage for this location:</p>
              <button class="update-missing-data-btn btn btn-primary" data-location='${JSON.stringify(
                data.coverage.location || {},
              ).replace(/'/g, "&#39;")}'>
                <i class="fas fa-sync-alt me-1"></i> Update Coverage Data
              </button>
            </div>
          `;

          // Hide the chart container
          const chartContainer = document.getElementById("street-type-chart");
          if (chartContainer) {
            chartContainer.innerHTML =
              '<div class="alert alert-warning">No street data available</div>';
          }

          // Show a toast notification
          if (hasError) {
            window.notificationManager.show(
              `Error in coverage calculation for ${data.coverage.location_name}`,
              "danger",
            );
          } else {
            window.notificationManager.show(
              `No street data available for ${data.coverage.location_name}. Try updating the coverage.`,
              "warning",
            );
          }

          // Scroll to the dashboard
          if (coverageDashboard) {
            coverageDashboard.scrollIntoView({ behavior: "smooth" });
          }
          return;
        }

        // Show success toast
        window.notificationManager.show(
          `Loaded coverage data for ${data.coverage.location_name}`,
          "success",
        );

        // Initialize and populate the map
        this.initializeCoverageMap(data.coverage);

        // Initialize and populate the street type chart
        this.createStreetTypeChart(data.coverage.street_types);

        // Scroll to the dashboard
        if (coverageDashboard) {
          coverageDashboard.scrollIntoView({ behavior: "smooth" });
        }
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);

        const dashboardLocationName = document.getElementById(
          "dashboard-location-name",
        );
        const coverageMapContainer = document.getElementById("coverage-map");

        if (dashboardLocationName)
          dashboardLocationName.textContent = "Error loading data";

        if (coverageMapContainer) {
          coverageMapContainer.innerHTML = `<div class="alert alert-danger">
            <h5><i class="fas fa-exclamation-circle me-2"></i>Error loading coverage data</h5>
            <p>${error.message}</p>
            <p>Please try refreshing the page or select a different location.</p>
          </div>`;
        }

        window.notificationManager.show(
          `Error loading coverage data: ${error.message}`,
          "danger",
        );
      }
    }

    updateDashboardStats(coverage) {
      if (!coverage) return;

      // Set the location name
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name",
      );
      if (dashboardLocationName)
        dashboardLocationName.textContent = coverage.location_name;

      // Convert meters to miles for display
      const totalMiles = (coverage.total_length * 0.000621371).toFixed(2);
      const drivenMiles = (coverage.driven_length * 0.000621371).toFixed(2);

      // Update the coverage percentage bar
      const coveragePercentage = coverage.coverage_percentage.toFixed(1);
      const coverageBar = document.getElementById("coverage-percentage-bar");

      if (coverageBar) {
        coverageBar.style.width = `${coveragePercentage}%`;
        coverageBar.setAttribute("aria-valuenow", coveragePercentage);

        // Set bar color based on coverage level
        coverageBar.classList.remove("bg-success", "bg-warning", "bg-danger");

        if (parseFloat(coveragePercentage) < 25) {
          coverageBar.classList.add("bg-danger");
        } else if (parseFloat(coveragePercentage) < 75) {
          coverageBar.classList.add("bg-warning");
        } else {
          coverageBar.classList.add("bg-success");
        }
      }

      const coveragePercentageText = document.getElementById(
        "dashboard-coverage-percentage-text",
      );
      if (coveragePercentageText)
        coveragePercentageText.textContent = `${coveragePercentage}%`;

      // Update the stats
      const totalStreetsEl = document.getElementById("dashboard-total-streets");
      const totalLengthEl = document.getElementById("dashboard-total-length");
      const drivenLengthEl = document.getElementById("dashboard-driven-length");
      const lastUpdatedEl = document.getElementById("dashboard-last-updated");

      if (totalStreetsEl) totalStreetsEl.textContent = coverage.total_streets;
      if (totalLengthEl) totalLengthEl.textContent = `${totalMiles} miles`;
      if (drivenLengthEl) drivenLengthEl.textContent = `${drivenMiles} miles`;

      // Format the last updated date
      if (lastUpdatedEl) {
        const lastUpdated = coverage.last_updated
          ? new Date(coverage.last_updated).toLocaleString()
          : "Never";
        lastUpdatedEl.textContent = lastUpdated;
      }

      // Update street type coverage breakdown
      this.updateStreetTypeCoverage(coverage.street_types);
    }

    // Display coverage breakdown by street type
    updateStreetTypeCoverage(streetTypes) {
      const streetTypeCoverageEl = document.getElementById(
        "street-type-coverage",
      );
      if (!streetTypeCoverageEl) return;

      if (!streetTypes || !streetTypes.length) {
        streetTypeCoverageEl.innerHTML =
          '<div class="alert alert-info">No street type data available</div>';
        return;
      }

      // Sort street types by total length
      const sortedTypes = [...streetTypes].sort((a, b) => b.length - a.length);

      // Take top 6 types
      const topTypes = sortedTypes.slice(0, 6);

      // Generate HTML for each type
      let html = "";

      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage.toFixed(1);
        const totalMiles = (type.length * 0.000621371).toFixed(2);
        const coveredMiles = (type.covered_length * 0.000621371).toFixed(2);

        // Set progress bar color based on coverage
        let barColor = "bg-success";
        if (type.coverage_percentage < 25) {
          barColor = "bg-danger";
        } else if (type.coverage_percentage < 75) {
          barColor = "bg-warning";
        }

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between mb-1">
              <small><strong>${type.type}</strong></small>
              <small>${coveragePct}% (${coveredMiles}/${totalMiles} mi)</small>
            </div>
            <div class="progress" style="height: 8px;">
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

      // Clear the map container if it already has a map
      if (this.coverageMap) {
        this.coverageMap.remove();
        mapContainer.innerHTML = "";
      }

      // Initialize the map with dark mode styling
      this.coverageMap = L.map("coverage-map", {
        attributionControl: false,
        zoomControl: true,
        renderer: L.svg(), // Force SVG renderer for better export compatibility
      });

      // Add custom dark-themed map tiles
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution: "",
          subdomains: "abcd",
          maxZoom: 19,
        },
      ).addTo(this.coverageMap);

      // Add scale control
      L.control
        .scale({
          imperial: true,
          metric: false,
          position: "bottomleft",
        })
        .addTo(this.coverageMap);

      // Add attribution control
      L.control
        .attribution({
          position: "bottomright",
        })
        .addTo(this.coverageMap);

      // Add streets to the map
      this.addStreetsToMap(coverage.streets_geojson);

      // Handle zoom events to keep layers visible
      this.coverageMap.on("zoomend", () => {
        // Re-apply current filter when zoom ends
        this.setMapFilter(this.currentFilter || "all");
      });

      // Add hover effects for street info
      this.addMapHoverEffects();

      // Fit the map to the bounds of the streets
      this.fitMapToBounds();

      // Add coverage summary
      this.addCoverageSummary(coverage);
    }

    addStreetsToMap(geojson) {
      // Clear existing layers
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      } else {
        this.streetLayers = L.layerGroup().addTo(this.coverageMap);
      }

      // Store the GeoJSON for filtering
      this.streetsGeoJson = geojson;
      this.currentFilter = "all";

      // Define style functions
      const styleStreet = (feature) => {
        const isDriven = feature.properties.driven;
        const streetType = feature.properties.highway || "unknown";

        // Base styles
        const baseStyle = {
          weight: 3,
          opacity: 0.8,
          color: isDriven ? "#4caf50" : "#ff5252",
          className: isDriven ? "driven-street" : "undriven-street", // Add classes for export
        };

        // Adjust style based on street type
        switch (streetType) {
          case "motorway":
          case "trunk":
          case "primary":
            return { ...baseStyle, weight: 5 };
          case "secondary":
            return { ...baseStyle, weight: 4 };
          case "tertiary":
            return { ...baseStyle, weight: 3.5 };
          case "residential":
            return { ...baseStyle, weight: 3 };
          case "service":
          case "track":
            return { ...baseStyle, weight: 2, opacity: 0.7 };
          default:
            return { ...baseStyle, weight: 2.5 };
        }
      };

      // Add the GeoJSON layer
      const streetsLayer = L.geoJSON(geojson, {
        style: styleStreet,
        filter: () => true, // No filtering by default (show all)
        onEachFeature: (feature, layer) => {
          // Add street information to layer properties for hover display
          const props = feature.properties;
          const streetName = props.name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const length = (props.segment_length * 0.000621371).toFixed(2);
          const status = props.driven ? "Driven" : "Not Driven";

          // Store information for hover display
          layer.streetInfo = {
            name: streetName,
            type: streetType,
            length: length,
            status: status,
            driven: props.driven,
          };

          // Add popup with street info
          layer.bindPopup(`
            <div class="street-popup">
              <h5>${streetName}</h5>
              <p><strong>Type:</strong> ${streetType}</p>
              <p><strong>Length:</strong> ${length} miles</p>
              <p><strong>Status:</strong> <span class="${
                props.driven ? "text-success" : "text-danger"
              }">${status}</span></p>
            </div>
          `);
        },
      }).addTo(this.streetLayers);

      // Store the bounds for later use
      this.mapBounds = streetsLayer.getBounds();

      // Save a reference to the streets layer for better export
      this.streetsGeoJsonLayer = streetsLayer;
    }

    addMapHoverEffects() {
      if (!this.coverageMap) return;

      // Create info panel for street information
      const infoPanel = L.DomUtil.create("div", "map-info-panel");
      infoPanel.style.display = "none";

      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.appendChild(infoPanel);

      // Add mouseover and mouseout events to streets
      this.streetLayers.eachLayer((layer) => {
        // Store original style for reset
        if (!layer.originalStyle && layer.options) {
          layer.originalStyle = { ...layer.options };
        }

        layer.on("mouseover", (e) => {
          // Highlight the street
          e.target.setStyle({
            weight: e.target.options.weight + 2,
            opacity: 1,
          });

          // Show street info
          if (layer.streetInfo) {
            infoPanel.innerHTML = `
              <strong>${layer.streetInfo.name}</strong><br>
              Type: ${layer.streetInfo.type}<br>
              Length: ${layer.streetInfo.length} miles<br>
              Status: <span class="${
                layer.streetInfo.driven ? "text-success" : "text-danger"
              }">${layer.streetInfo.status}</span>
            `;
            infoPanel.style.display = "block";
          }
        });

        layer.on("mouseout", (e) => {
          // Reset style - instead of using resetStyle, manually apply original style
          if (layer.originalStyle) {
            e.target.setStyle(layer.originalStyle);
          }

          // Hide info panel
          infoPanel.style.display = "none";
        });

        // Update info panel position on mousemove
        layer.on("mousemove", (e) => {
          // Position the info panel near the cursor
          const mapContainer = document.getElementById("coverage-map");
          if (!mapContainer) return;

          const rect = mapContainer.getBoundingClientRect();
          const x = e.originalEvent.clientX - rect.left;
          const y = e.originalEvent.clientY - rect.top;

          infoPanel.style.left = `${x + 10}px`;
          infoPanel.style.top = `${y + 10}px`;
        });
      });

      // Add CSS for info panel
      const style = document.createElement("style");
      style.textContent = `
        .map-info-panel {
          position: absolute;
          z-index: 1000;
          background: rgba(40, 40, 40, 0.9);
          color: white;
          padding: 8px 12px;
          border-radius: 4px;
          font-size: 12px;
          pointer-events: none;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
          max-width: 200px;
        }
        .map-info-panel .text-success {
          color: #4caf50 !important;
        }
        .map-info-panel .text-danger {
          color: #ff5252 !important;
        }
      `;
      document.head.appendChild(style);
    }

    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;

      // Create a custom control
      const CoverageSummaryControl = L.Control.extend({
        options: {
          position: "topright",
        },

        onAdd: () => {
          const container = L.DomUtil.create(
            "div",
            "coverage-summary-control leaflet-bar",
          );

          const coveragePercentage = coverage.coverage_percentage.toFixed(1);
          const totalMiles = (coverage.total_length * 0.000621371).toFixed(2);
          const drivenMiles = (coverage.driven_length * 0.000621371).toFixed(2);

          container.innerHTML = `
            <div class="summary-content">
              <div class="summary-title">Coverage Summary</div>
              <div class="summary-percentage">${coveragePercentage}%</div>
              <div class="summary-progress">
                <div class="progress" style="height: 6px;">
                  <div class="progress-bar bg-success" role="progressbar" 
                    style="width: ${coveragePercentage}%"></div>
                </div>
              </div>
              <div class="summary-details">
                <div>${drivenMiles} / ${totalMiles} miles</div>
              </div>
            </div>
          `;

          return container;
        },
      });

      // Add the control to the map
      new CoverageSummaryControl().addTo(this.coverageMap);

      // Add CSS for the summary control
      const style = document.createElement("style");
      style.textContent = `
        .coverage-summary-control {
          background: rgba(40, 40, 40, 0.9);
          color: white;
          padding: 10px;
          border-radius: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          border: none !important;
          min-width: 150px;
        }
        .summary-title {
          font-size: 12px;
          font-weight: bold;
          margin-bottom: 5px;
        }
        .summary-percentage {
          font-size: 24px;
          font-weight: bold;
          margin-bottom: 5px;
        }
        .summary-progress {
          margin-bottom: 8px;
        }
        .summary-details {
          font-size: 11px;
          color: #ccc;
        }
      `;
      document.head.appendChild(style);
    }

    fitMapToBounds() {
      if (this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, {
          padding: [20, 20],
        });
      }
    }

    createStreetTypeChart(streetTypes) {
      if (!streetTypes || !streetTypes.length) return;

      // Limit to top 5 street types by length for better visualization
      const topTypes = streetTypes.slice(0, 5);

      // Prepare data for the chart
      const labels = topTypes.map((t) => this.formatStreetType(t.type));
      const totalLengths = topTypes.map((t) =>
        (t.length * 0.000621371).toFixed(2),
      );
      const drivenLengths = topTypes.map((t) =>
        (t.covered_length * 0.000621371).toFixed(2),
      );

      // Check if Chart.js is loaded
      if (typeof Chart === "undefined") {
        console.error("Chart.js is not loaded");
        const chartContainer = document.getElementById("street-type-chart");
        if (chartContainer) {
          chartContainer.innerHTML =
            '<div class="alert alert-warning">Chart.js is required to display this chart</div>';
        }
        return;
      }

      // Clear existing chart
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;

      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      // Define better colors
      const drivenColor = "rgba(76, 175, 80, 0.8)";
      const notDrivenColor = "rgba(255, 82, 82, 0.8)";

      // Create the chart
      new Chart(ctx, {
        type: "bar",
        data: {
          labels: labels,
          datasets: [
            {
              label: "Driven (miles)",
              data: drivenLengths,
              backgroundColor: drivenColor,
              borderColor: "rgba(56, 142, 60, 1)",
              borderWidth: 1,
            },
            {
              label: "Not Driven (miles)",
              data: totalLengths.map((total, i) =>
                (total - drivenLengths[i]).toFixed(2),
              ),
              backgroundColor: notDrivenColor,
              borderColor: "rgba(211, 47, 47, 1)",
              borderWidth: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              stacked: true,
              ticks: {
                color: "#e0e0e0",
                font: {
                  size: 10,
                },
              },
              grid: {
                color: "rgba(255, 255, 255, 0.05)",
              },
            },
            y: {
              stacked: true,
              ticks: {
                color: "#e0e0e0",
                font: {
                  size: 10,
                },
              },
              grid: {
                color: "rgba(255, 255, 255, 0.05)",
              },
              title: {
                display: true,
                text: "Miles",
                color: "#e0e0e0",
                font: {
                  size: 12,
                },
              },
            },
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: function (context) {
                  const label = context.dataset.label || "";
                  const value = context.raw;
                  const percentage =
                    context.datasetIndex === 0
                      ? (
                          (drivenLengths[context.dataIndex] /
                            totalLengths[context.dataIndex]) *
                          100
                        ).toFixed(1)
                      : (
                          (context.raw / totalLengths[context.dataIndex]) *
                          100
                        ).toFixed(1);
                  return `${label}: ${value} mi (${percentage}%)`;
                },
              },
            },
            legend: {
              position: "top",
              labels: {
                color: "#e0e0e0",
                usePointStyle: true,
                padding: 15,
                font: {
                  size: 11,
                },
              },
            },
            title: {
              display: false,
            },
          },
        },
      });
    }

    // Format street type for better display
    formatStreetType(type) {
      if (!type) return "Unknown";

      // Capitalize and clean up common street types
      switch (type.toLowerCase()) {
        case "residential":
          return "Residential";
        case "service":
          return "Service";
        case "motorway":
          return "Motorway";
        case "primary":
          return "Primary";
        case "secondary":
          return "Secondary";
        case "tertiary":
          return "Tertiary";
        case "unclassified":
          return "Unclassified";
        case "track":
          return "Track";
        case "footway":
          return "Footway";
        case "path":
          return "Path";
        case "cycleway":
          return "Cycleway";
        case "trunk":
          return "Trunk";
        case "living_street":
          return "Living Street";
        default:
          // Capitalize first letter of each word
          return type
            .split("_")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
      }
    }

    exportCoverageMap() {
      if (!this.coverageMap || typeof leafletImage === "undefined") {
        window.notificationManager.show(
          "Export functionality not available. Please take a screenshot instead.",
          "warning",
        );
        return;
      }

      // Create a timestamp for the filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const locationName = this.selectedLocation.location_name
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const filename = `coverage_map_${locationName}_${timestamp}.png`;

      try {
        // Show a notification to let the user know export is being processed
        window.notificationManager.show("Generating map image...", "info");

        // Re-apply the current filter to ensure layers are displayed
        this.setMapFilter(this.currentFilter || "all");

        // Make sure SVG path elements are properly rendered
        document
          .querySelectorAll(".leaflet-overlay-pane path")
          .forEach((path) => {
            path.setAttribute("stroke-opacity", "1");
            // Make sure the path has proper visibility
            path.style.display = "";
            path.style.visibility = "visible";
          });

        // Force leaflet to redraw first
        this.coverageMap.invalidateSize();

        // Add a small delay to ensure rendering completes
        setTimeout(() => {
          // Options for leaflet-image
          const options = {
            quality: 1.0,
            svgRenderer: true,
            includeOverlayPanes: true,
          };

          // Use leaflet-image to create a canvas with the map
          leafletImage(
            this.coverageMap,
            (err, canvas) => {
              if (err) {
                console.error("Error generating map image: %s", err);
                window.notificationManager.show(
                  "Failed to generate map image",
                  "danger",
                );
                return;
              }

              // Create download link
              const link = document.createElement("a");
              link.download = filename;
              link.href = canvas.toDataURL("image/png");

              // Notify success
              window.notificationManager.show(
                "Map image generated successfully",
                "success",
              );

              // Trigger download
              link.click();
            },
            options,
          );
        }, 600);
      } catch (error) {
        console.error("Error exporting map: %s", error);
        window.notificationManager.show(
          `Error exporting map: ${error.message}`,
          "danger",
        );
      }
    }

    setMapFilter(filterType) {
      if (!this.coverageMap || !this.streetsGeoJson) return;

      this.currentFilter = filterType;

      // Remove existing layers
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      }

      // Define style functions
      const styleStreet = (feature) => {
        const isDriven = feature.properties.driven;
        return {
          color: isDriven ? "#4caf50" : "#ff5252",
          weight: 3,
          opacity: 0.8,
          className: isDriven ? "driven-street" : "undriven-street", // Add classes for export
        };
      };

      // Define filter function based on filter type
      const filterFunc = (feature) => {
        if (filterType === "all") return true;
        if (filterType === "driven") return feature.properties.driven;
        if (filterType === "undriven") return !feature.properties.driven;
        return true;
      };

      // Add the filtered GeoJSON layer
      const streetsLayer = L.geoJSON(this.streetsGeoJson, {
        style: styleStreet,
        filter: filterFunc,
        onEachFeature: (feature, layer) => {
          // Add popup with street info
          const props = feature.properties;
          const streetName = props.name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const length = (props.segment_length * 0.000621371).toFixed(2);
          const status = props.driven ? "Driven" : "Not Driven";

          layer.bindPopup(`
            <strong>${streetName}</strong><br>
            Type: ${streetType}<br>
            Length: ${length} miles<br>
            Status: <span class="${
              props.driven ? "text-success" : "text-danger"
            }">${status}</span>
          `);
        },
      }).addTo(this.streetLayers);

      // Store the reference to the current layer for export
      this.streetsGeoJsonLayer = streetsLayer;
    }

    toggleFilterButtonState(clickedButton) {
      // Remove active class from all buttons
      document.querySelectorAll(".map-controls .btn").forEach((btn) => {
        btn.classList.remove("active");
      });

      // Add active class to clicked button
      clickedButton.classList.add("active");
    }

    minimizeModal() {
      const modal = document.getElementById("taskProgressModal");
      modal.style.display = "none";
    }

    reopenModal() {
      const modal = document.getElementById("taskProgressModal");
      modal.style.display = "block";
    }

    updateProgress() {
      const progressElement = document.getElementById("progress-status");
      if (progressElement) {
        // Fetch and update progress data
        const progressData = this.getProgressData();
        progressElement.innerText = `Progress: ${progressData}%`;
      }
    }

    getProgressData() {
      // Placeholder for fetching real progress data
      return Math.floor(Math.random() * 100); // Simulated progress
    }
  }

  // Initialize the coverage manager when the DOM is loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized");
  });
})();
