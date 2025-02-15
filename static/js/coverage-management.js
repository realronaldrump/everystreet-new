/* global bootstrap, notificationManager */
(() => {
  "use strict";

  class CoverageManager {
    constructor() {
      this.toastManager = new ToastManager();
      this.validatedLocation = null;
      this.taskProgressModal = new bootstrap.Modal(document.getElementById("taskProgressModal"));
      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    setupEventListeners() {
      document.getElementById("validate-location")?.addEventListener("click", () => this.validateLocation());
      document.getElementById("add-coverage-area")?.addEventListener("click", () => this.addCoverageArea());
      
      // Location input change handler
      document.getElementById("location-input")?.addEventListener("input", () => {
        document.getElementById("add-coverage-area").disabled = true;
        this.validatedLocation = null;
      });
    }

    async validateLocation() {
      const locInput = document.getElementById("location-input");
      const locType = document.getElementById("location-type");
      if (!locInput || !locType || !locInput.value || !locType.value) {
        this.toastManager.show("Error", "Please enter a location and select a location type.", "danger");
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
          this.toastManager.show("Warning", "Location not found. Please check your input.", "warning");
          return;
        }

        this.validatedLocation = data;
        document.getElementById("add-coverage-area").disabled = false;
        this.toastManager.show("Success", "Location validated successfully!", "success");
      } catch (error) {
        console.error("Error validating location:", error);
        this.toastManager.show("Error", "Failed to validate location. Please try again.", "danger");
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation) {
        this.toastManager.show("Error", "Please validate a location first.", "danger");
        return;
      }

      try {
        // First preprocess streets
        this.showProgressModal("Preprocessing streets...");
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: this.validatedLocation.display_name,
            location_type: document.getElementById("location-type").value,
          }),
        });

        if (!preprocessResponse.ok) throw new Error("Failed to preprocess streets");

        // Then calculate coverage
        this.updateProgressModal("Calculating coverage...", 50);
        const coverageResponse = await fetch("/api/street_coverage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location: this.validatedLocation }),
        });

        if (!coverageResponse.ok) throw new Error("Failed to start coverage calculation");
        const coverageData = await coverageResponse.json();

        if (!coverageData.task_id) throw new Error("No task ID received");

        // Poll for coverage calculation completion
        await this.pollCoverageProgress(coverageData.task_id);

        // Reload the coverage areas table
        await this.loadCoverageAreas();
        this.toastManager.show("Success", "Coverage area added successfully!", "success");
      } catch (error) {
        console.error("Error adding coverage area:", error);
        this.toastManager.show("Error", "Failed to add coverage area. Please try again.", "danger");
      } finally {
        this.hideProgressModal();
      }
    }

    async pollCoverageProgress(taskId) {
      const maxRetries = 60; // 5 minutes maximum (with 5-second intervals)
      let retries = 0;

      while (retries < maxRetries) {
        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);
          if (!response.ok) throw new Error("Failed to get coverage status");
          
          const data = await response.json();
          if (data.stage === "complete") {
            return data;
          } else if (data.stage === "error") {
            throw new Error(data.message || "Coverage calculation failed");
          }

          this.updateProgressModal(data.message || "Processing...", data.progress || 0);
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds between polls
          retries++;
        } catch (error) {
          console.error("Error polling coverage progress:", error);
          throw error;
        }
      }
      throw new Error("Coverage calculation timed out");
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      messageEl.textContent = message;

      this.taskProgressModal.show();
    }

    updateProgressModal(message, progress) {
      const modal = document.getElementById("taskProgressModal");
      const progressBar = modal.querySelector(".progress-bar");
      const messageEl = modal.querySelector(".progress-message");

      progressBar.style.width = `${progress}%`;
      progressBar.setAttribute("aria-valuenow", progress);
      messageEl.textContent = message;
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
        this.toastManager.show("Error", "Failed to load coverage areas. Please refresh the page.", "danger");
      }
    }

    updateCoverageTable(areas) {
      const tbody = document.querySelector("#coverage-areas-table tbody");
      if (!tbody) return;

      tbody.innerHTML = "";
      areas.forEach(area => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${area.location.display_name || "Unknown"}</td>
          <td>${(area.total_length * 0.000621371).toFixed(2)} miles</td>
          <td>${(area.driven_length * 0.000621371).toFixed(2)} miles</td>
          <td>
            <div class="progress" style="height: 20px;">
              <div class="progress-bar bg-success" role="progressbar" 
                   style="width: ${area.coverage_percentage}%;" 
                   aria-valuenow="${area.coverage_percentage}" 
                   aria-valuemin="0" 
                   aria-valuemax="100">
                ${area.coverage_percentage.toFixed(1)}%
              </div>
            </div>
          </td>
          <td>${area.total_segments}</td>
          <td>${area.last_updated ? new Date(area.last_updated).toLocaleString() : "Never"}</td>
          <td>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-primary update-coverage" data-location='${JSON.stringify(area.location)}'>
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-info view-on-map" data-location='${JSON.stringify(area.location)}'>
                <i class="fas fa-map-marked-alt"></i>
              </button>
            </div>
          </td>
        `;

        // Add event listeners for the action buttons
        const updateBtn = row.querySelector(".update-coverage");
        const viewBtn = row.querySelector(".view-on-map");

        updateBtn?.addEventListener("click", (e) => {
          const location = JSON.parse(e.currentTarget.dataset.location);
          this.updateCoverageForArea(location);
        });

        viewBtn?.addEventListener("click", (e) => {
          const location = JSON.parse(e.currentTarget.dataset.location);
          this.viewAreaOnMap(location);
        });

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
        await this.loadCoverageAreas();
        this.toastManager.show("Success", "Coverage updated successfully!", "success");
      } catch (error) {
        console.error("Error updating coverage:", error);
        this.toastManager.show("Error", "Failed to update coverage. Please try again.", "danger");
      } finally {
        this.hideProgressModal();
      }
    }

    viewAreaOnMap(location) {
      // Store the location in localStorage and redirect to the map page
      localStorage.setItem("selectedLocation", JSON.stringify(location));
      window.location.href = "/";
    }
  }

  class ToastManager {
    constructor() {
      this.container = document.querySelector(".toast-container");
      this.template = document.getElementById("toast-template");
    }

    show(title, message, type = "info") {
      if (!this.container || !this.template) {
        console.error("Toast container or template not found");
        return;
      }

      const toast = this.template.content.cloneNode(true).querySelector(".toast");
      toast.querySelector(".toast-title").textContent = title;
      toast.querySelector(".toast-body").textContent = message;

      const icon = toast.querySelector(".toast-icon");
      icon.className = `rounded me-2 toast-icon bg-${type}`;

      this.container.appendChild(toast);
      const bsToast = new bootstrap.Toast(toast);
      bsToast.show();

      toast.addEventListener("hidden.bs.toast", () => {
        toast.remove();
      });
    }
  }

  // Initialize the coverage manager when the DOM is loaded
  document.addEventListener("DOMContentLoaded", () => {
    window.coverageManager = new CoverageManager();
  });
})(); 