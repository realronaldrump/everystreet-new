/* global bootstrap, notificationManager, confirmationDialog */

(() => {
  "use strict";

  class CoverageManager {
    constructor() {
      this.validatedLocation = null;
      this.taskProgressModal = new bootstrap.Modal(document.getElementById("taskProgressModal"));
      this.setupEventListeners();
      this.loadCoverageAreas();
      this.setupAutoRefresh(); // Set up auto-refresh
    }

    setupEventListeners() {
      document.getElementById("validate-location")?.addEventListener("click", () => this.validateLocation());
      document.getElementById("add-coverage-area")?.addEventListener("click", () => this.addCoverageArea());

      // Disable "Add Area" button on location input change
      document.getElementById("location-input")?.addEventListener("input", () => {
        document.getElementById("add-coverage-area").disabled = true;
        this.validatedLocation = null;
      });

      // Refresh data when modal is closed
      document.getElementById("taskProgressModal")?.addEventListener("hidden.bs.modal", () => {
        this.loadCoverageAreas();
      });

      // Event delegation for action buttons within the table
      document.querySelector("#coverage-areas-table tbody")?.addEventListener("click", (event) => {
        const updateBtn = event.target.closest(".update-coverage");
        const viewBtn = event.target.closest(".view-on-map");
        const deleteBtn = event.target.closest(".delete-area");

        if (updateBtn) {
          const location = JSON.parse(updateBtn.dataset.location);
          this.updateCoverageForArea(location);
        } else if (viewBtn) {
          const location = JSON.parse(viewBtn.dataset.location);
          this.viewAreaOnMap(location);
        } else if (deleteBtn) {
          const location = JSON.parse(deleteBtn.dataset.location);
          this.deleteArea(location);
        }
      });
    }


    async validateLocation() {
      const locInput = document.getElementById("location-input");
      const locType = document.getElementById("location-type");
      if (!locInput?.value || !locType?.value) {
        notificationManager.show("Please enter a location and select a location type.", "danger");
        return;
      }

      try {
        const response = await fetch("/api/validate_location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: locInput.value, locationType: locType.value }),
        });

        if (!response.ok) throw new Error("Failed to validate location");
        const data = await response.json();

        if (!data) {
          notificationManager.show("Location not found. Please check your input.", "warning");
          return;
        }

        this.validatedLocation = data;
        document.getElementById("add-coverage-area").disabled = false;
        notificationManager.show("Location validated successfully!", "success");
      } catch (error) {
        console.error("Error validating location:", error);
        notificationManager.show("Failed to validate location. Please try again.", "danger");
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
          (area) => area.location.display_name === this.validatedLocation.display_name
        );

        if (exists) {
          notificationManager.show("This area is already being tracked.", "warning");
          return;
        }

        // Add new area to the list and update table (before starting processing)
        const newArea = {
          location: this.validatedLocation,
          total_length: 0,
          driven_length: 0,
          coverage_percentage: 0,
          total_segments: 0,
          last_updated: null, // null indicates processing status
          status: "processing", // Add a status field
        };
        this.updateCoverageTable([...areas, newArea]);

        this.showProgressModal("Starting background processing...");
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: this.validatedLocation.display_name,
            location_type: document.getElementById("location-type").value,
          }),
        });

        if (!preprocessResponse.ok) throw new Error("Failed to start preprocessing");
        const taskData = await preprocessResponse.json();

        if (taskData?.task_id) {
            this.activeTaskIds = this.activeTaskIds || new Set();
            this.activeTaskIds.add(taskData.task_id)
        }

        notificationManager.show(
          "Coverage area processing started. You can check the status in the table.",
          "success"
        );

        document.getElementById("location-input").value = "";
        document.getElementById("add-coverage-area").disabled = true;
        this.validatedLocation = null;
      } catch (error) {
        console.error("Error adding coverage area:", error);
        notificationManager.show("Failed to add coverage area. Please try again.", "danger");
      } finally {
        this.hideProgressModal();
      }
    }


    static async pollCoverageProgress(taskId) {
      const maxRetries = 180; // 15 minutes (with 5-second intervals)
      let retries = 0;
      let lastProgress = -1;

      const updateModalContent = (data) => {
        const progressBar = document.querySelector("#taskProgressModal .progress-bar");
        const messageEl = document.querySelector("#taskProgressModal .progress-message");
        const detailsEl = document.querySelector("#taskProgressModal .progress-details");

        if (progressBar && messageEl) {
          progressBar.style.width = `${data.progress}%`;
          progressBar.setAttribute("aria-valuenow", data.progress);
          messageEl.textContent = data.message || "Processing...";

          if (detailsEl && data.processed_trips !== undefined) {
            detailsEl.innerHTML = `
              <div class="mt-2">
                <small>
                  Processed: ${data.processed_trips} / ${data.total_trips} trips<br>
                  Covered segments: ${data.covered_segments || 0}<br>
                  Total length: ${((data.total_length || 0) * 0.000621371).toFixed(2)} miles
                </small>
              </div>
            `;
          }
        }
      };

      while (retries < maxRetries) {
        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (!response.ok) throw new Error("Failed to get coverage status");

          const data = await response.json();

          if (data.progress !== lastProgress) {
            updateModalContent(data);
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
          throw error; // Re-throw to be caught by the caller
        }
      }
      throw new Error("Coverage calculation timed out");
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");
      const detailsEl = modal.querySelector(".progress-details");

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      messageEl.textContent = message;
      if (detailsEl) detailsEl.innerHTML = "";

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
        notificationManager.show("Failed to load coverage areas. Please refresh the page.", "danger");
      }
    }

    updateCoverageTable(areas) {
      const tbody = document.querySelector("#coverage-areas-table tbody");
      if (!tbody) return;

      tbody.innerHTML = ""; // Clear existing rows
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
                  ? `<button class="btn btn-secondary" disabled><i class="fas fa-spinner fa-spin"></i></button>`
                  : `<button class="btn btn-primary update-coverage" data-location='${JSON.stringify(
                      area.location
                    )}' title="Update Coverage"><i class="fas fa-sync-alt"></i></button>
                    <button class="btn btn-info view-on-map" data-location='${JSON.stringify(
                      area.location
                    )}' title="View on Map"><i class="fas fa-map-marked-alt"></i></button>
                    <button class="btn btn-danger delete-area" data-location='${JSON.stringify(
                      area.location
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
        this.showProgressModal("Updating coverage...");
        const response = await fetch("/api/street_coverage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location }),
        });

        if (!response.ok) throw new Error("Failed to start coverage update");
        const data = await response.json();

        await this.pollCoverageProgress(data.task_id);
        await this.loadCoverageAreas(); // Reload after polling
        notificationManager.show("Coverage updated successfully!", "success");
      } catch (error) {
        console.error("Error updating coverage:", error);
        notificationManager.show("Failed to update coverage. Please try again.", "danger");
      } finally {
        this.hideProgressModal();
      }
    }

    static viewAreaOnMap(location) {
      localStorage.setItem("selectedLocation", JSON.stringify(location));
      window.location.href = "/";
    }

    async deleteArea(location) {
        const confirmed = await confirmationDialog.show({
            message: `Are you sure you want to delete the coverage area for ${location.display_name}?`,
            confirmButtonClass: 'btn-danger'
        });

      if (!confirmed) {
        return;
      }

      try {
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location }),
        });

        if (!response.ok) throw new Error("Failed to delete coverage area");

        await this.loadCoverageAreas();
        notificationManager.show("Coverage area deleted successfully!", "success");
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        notificationManager.show("Failed to delete coverage area. Please try again.", "danger");
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
  }


  // Initialize on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", () => {
    window.coverageManager = new CoverageManager();
  });
})();