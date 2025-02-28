/* global bootstrap, notificationManager, confirmationDialog */
"use strict";

(() => {
  class CoverageManager {
    constructor() {
      this.validatedLocation = null;
      this.taskProgressModal = new bootstrap.Modal(
        document.getElementById("taskProgressModal"),
      );
      this.activeTaskIds = new Set();
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.setupEventListeners();
      this.loadCoverageAreas();
      this.setupAutoRefresh(); // Set up auto-refresh if any area is still processing
    }

    setupEventListeners() {
      document
        .getElementById("validate-location")
        ?.addEventListener("click", () => this.validateLocation());
      document
        .getElementById("add-coverage-area")
        ?.addEventListener("click", () => this.addCoverageArea());
      document
        .getElementById("cancel-processing")
        ?.addEventListener("click", () => this.cancelProcessing());

      // Disable "Add Area" button when location input changes.
      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          document.getElementById("add-coverage-area").disabled = true;
          this.validatedLocation = null;
        });

      // Refresh coverage areas when the modal is closed.
      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          this.loadCoverageAreas();
        });

      // Event delegation for action buttons in the table.
      document
        .querySelector("#coverage-areas-table tbody")
        ?.addEventListener("click", (event) => {
          const updateBtn = event.target.closest(".update-coverage");
          const viewBtn = event.target.closest(".view-on-map");
          const deleteBtn = event.target.closest(".delete-area");
          const cancelBtn = event.target.closest(".cancel-processing");

          if (updateBtn) {
            const location = JSON.parse(updateBtn.dataset.location);
            this.updateCoverageForArea(location);
          } else if (viewBtn) {
            const location = JSON.parse(viewBtn.dataset.location);
            this.viewAreaOnMap(location);
          } else if (deleteBtn) {
            const location = JSON.parse(deleteBtn.dataset.location);
            this.deleteArea(location);
          } else if (cancelBtn) {
            const location = JSON.parse(cancelBtn.dataset.location);
            this.cancelProcessing(location);
          }
        });
    }

    async validateLocation() {
      const locInput = document.getElementById("location-input");
      const locType = document.getElementById("location-type");
      if (!locInput?.value || !locType?.value) {
        notificationManager.show(
          "Please enter a location and select a location type.",
          "danger",
        );
        return;
      }

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: locInput.value,
            locationType: locType.value,
          }),
        });

        if (!response.ok) throw new Error("Failed to validate location");
        const data = await response.json();

        if (!data) {
          notificationManager.show(
            "Location not found. Please check your input.",
            "warning",
          );
          return;
        }

        this.validatedLocation = data;
        document.getElementById("add-coverage-area").disabled = false;
        notificationManager.show("Location validated successfully!", "success");
      } catch (error) {
        console.error("Error validating location:", error);
        notificationManager.show(
          "Failed to validate location. Please try again.",
          "danger",
        );
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation) {
        notificationManager.show("Please validate a location first.", "danger");
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
          notificationManager.show(
            "This area is already being tracked.",
            "warning",
          );
          return;
        }

        // Add the new area immediately to the table, marked as "processing".
        const newArea = {
          location: this.validatedLocation,
          total_length: 0,
          driven_length: 0,
          coverage_percentage: 0,
          total_segments: 0,
          last_updated: null, // Indicates that processing is underway.
          status: "processing",
        };
        this.updateCoverageTable([...areas, newArea]);

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

        notificationManager.show(
          "Coverage area processing started. You can check the status in the table.",
          "success",
        );

        // Reset input and validated state.
        document.getElementById("location-input").value = "";
        document.getElementById("add-coverage-area").disabled = true;
        this.validatedLocation = null;
      } catch (error) {
        console.error("Error adding coverage area:", error);
        notificationManager.show(
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
        notificationManager.show("No active processing to cancel.", "warning");
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: locationToCancel }),
        });

        if (!response.ok) throw new Error("Failed to cancel processing");

        notificationManager.show(
          "Processing cancelled successfully.",
          "success",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        notificationManager.show(
          "Failed to cancel processing. Please try again.",
          "danger",
        );
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");
      const stageInfoEl = modal.querySelector(".stage-info");
      const statsInfoEl = modal.querySelector(".stats-info");
      const timeInfoEl = modal.querySelector(".time-info");

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      messageEl.textContent = message;

      // Clear previous details.
      stageInfoEl.innerHTML = "";
      statsInfoEl.innerHTML = "";
      timeInfoEl.innerHTML = "";

      this.processingStartTime = Date.now();
      this.taskProgressModal.show();
    }

    hideProgressModal() {
      this.taskProgressModal.hide();
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) throw new Error("Failed to fetch coverage areas");
        const data = await response.json();
        this.updateCoverageTable(data.areas);
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        notificationManager.show(
          "Failed to load coverage areas. Please refresh the page.",
          "danger",
        );
      }
    }

    updateCoverageTable(areas) {
      const tbody = document.querySelector("#coverage-areas-table tbody");
      if (!tbody) return;

      tbody.innerHTML = ""; // Clear current rows.
      areas.forEach((area) => {
        const row = document.createElement("tr");
        const isProcessing = area.status === "processing";
        const hasError = area.status === "error";

        if (isProcessing) row.classList.add("processing-row");

        row.innerHTML = `
          <td>${area.location.display_name || "Unknown"}</td>
          <td>${(area.total_length * 0.000621371).toFixed(2)} miles</td>
          <td>${(area.driven_length * 0.000621371).toFixed(2)} miles</td>
          <td>
            ${
              isProcessing
                ? `<div class="d-flex align-items-center">
                     <div class="spinner-border spinner-border-sm me-2"></div>
                     <span>Processing...</span>
                   </div>`
                : hasError
                  ? `<div class="text-danger">
                     <i class="fas fa-exclamation-circle me-1"></i>
                     Error: ${area.last_error || "Unknown error"}
                   </div>`
                  : `<div class="progress" style="height: 20px;">
                     <div class="progress-bar bg-success" role="progressbar"
                          style="width: ${area.coverage_percentage}%;"
                          aria-valuenow="${area.coverage_percentage}"
                          aria-valuemin="0"
                          aria-valuemax="100">
                       ${area.coverage_percentage.toFixed(1)}%
                     </div>
                   </div>`
            }
          </td>
          <td>${area.total_segments || 0}</td>
          <td>${area.last_updated ? new Date(area.last_updated).toLocaleString() : "Never"}</td>
          <td>
            <div class="btn-group btn-group-sm">
              ${
                isProcessing
                  ? `<button class="btn btn-danger cancel-processing" data-location='${JSON.stringify(
                      area.location,
                    )}' title="Cancel Processing"><i class="fas fa-stop-circle"></i></button>`
                  : `<button class="btn btn-primary update-coverage" data-location='${JSON.stringify(
                      area.location,
                    )}' title="Update Coverage"><i class="fas fa-sync-alt"></i></button>
                     <button class="btn btn-info view-on-map" data-location='${JSON.stringify(
                       area.location,
                     )}' title="View on Map"><i class="fas fa-map-marked-alt"></i></button>
                     <button class="btn btn-danger delete-area" data-location='${JSON.stringify(
                       area.location,
                     )}' title="Delete Area"><i class="fas fa-trash"></i></button>`
              }
            </div>
          </td>
        `;
        tbody.appendChild(row);
      });
    }

    async updateCoverageForArea(location) {
      try {
        this.currentProcessingLocation = location;
        this.showProgressModal("Updating coverage...", 5);
        const response = await fetch("/api/street_coverage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location }),
        });

        if (!response.ok) throw new Error("Failed to start coverage update");
        const data = await response.json();

        await this.pollCoverageProgress(data.task_id);
        await this.loadCoverageAreas();
        notificationManager.show("Coverage updated successfully!", "success");
      } catch (error) {
        console.error("Error updating coverage:", error);
        notificationManager.show(
          "Failed to update coverage. Please try again.",
          "danger",
        );
      } finally {
        this.currentProcessingLocation = null;
        this.processingStartTime = null;
        this.hideProgressModal();
      }
    }

    viewAreaOnMap(location) {
      localStorage.setItem("selectedLocation", JSON.stringify(location));
      window.location.href = "/";
    }

    async deleteArea(location) {
      const confirmed = await confirmationDialog.show({
        message: `Are you sure you want to delete the coverage area for ${location.display_name}?`,
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location }),
        });

        if (!response.ok) throw new Error("Failed to delete coverage area");

        await this.loadCoverageAreas();
        notificationManager.show(
          "Coverage area deleted successfully!",
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        notificationManager.show(
          "Failed to delete coverage area. Please try again.",
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

    updateModalContent(data) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");
      const stageInfoEl = modal.querySelector(".stage-info");
      const statsInfoEl = modal.querySelector(".stats-info");
      const timeInfoEl = modal.querySelector(".time-info");

      // Update progress bar and message.
      progressBar.style.width = `${data.progress}%`;
      progressBar.setAttribute("aria-valuenow", data.progress);
      messageEl.textContent = data.message || "Processing...";

      // Display the current stage with an appropriate icon.
      const stageIcon = this.getStageIcon(data.stage);
      stageInfoEl.innerHTML = `
        <span class="text-info">
          <i class="${stageIcon}"></i>
          ${this.formatStageName(data.stage)}
        </span>
      `;

      // Show additional statistics if available.
      if (data.processed_trips !== undefined) {
        statsInfoEl.innerHTML = `
          <div class="mt-2">
            <div class="mb-1">
              <i class="fas fa-route"></i> Trips: ${data.processed_trips} / ${data.total_trips}
            </div>
            <div class="mb-1">
              <i class="fas fa-road"></i> Covered Segments: ${data.covered_segments || 0}
            </div>
            <div>
              <i class="fas fa-ruler"></i> Total Length: ${((data.total_length || 0) * 0.000621371).toFixed(2)} miles
            </div>
          </div>
        `;
      }

      // Update elapsed time.
      if (this.processingStartTime) {
        const elapsedSeconds = Math.floor(
          (Date.now() - this.processingStartTime) / 1000,
        );
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        timeInfoEl.innerHTML = `
          <small>
            <i class="fas fa-clock"></i> Time Elapsed: ${minutes}m ${seconds}s
          </small>
        `;
      }
    }

    getStageIcon(stage) {
      const icons = {
        initializing: "fas fa-cog fa-spin",
        loading_streets: "fas fa-map-marked-alt",
        indexing: "fas fa-database",
        counting_trips: "fas fa-calculator",
        processing_trips: "fas fa-route",
        finalizing: "fas fa-check-circle",
        complete: "fas fa-flag-checkered",
        error: "fas fa-exclamation-triangle",
      };
      return icons[stage] || "fas fa-circle-notch fa-spin";
    }

    formatStageName(stage) {
      return stage
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    }

    // Note: Removed the static qualifier so that we can use instance properties.
    async pollCoverageProgress(taskId) {
      const maxRetries = 180; // Approximately 15 minutes (with 5-second intervals).
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
  }

  // Initialize the CoverageManager when the DOM is fully loaded.
  document.addEventListener("DOMContentLoaded", () => {
    window.coverageManager = new CoverageManager();
  });
})();
