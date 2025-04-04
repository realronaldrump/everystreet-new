/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */
"use strict";

// Add CSS styles for activity indicator and responsive tables
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .activity-indicator.pulsing {
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
    .detailed-stage-info {
      font-style: italic;
      color: #6c757d;
      margin-top: 0.5rem;
      font-size: 0.8rem;
    }
    .unit-toggle {
      font-size: 0.75rem;
      padding: 0.15rem 0.5rem;
      margin-top: 0.5rem;
    }
    .step-indicator {
      display: flex;
      align-items: center;
      margin-bottom: 5px;
      font-size: 0.8rem;
      opacity: 0.6;
      transition: opacity 0.3s ease-in-out;
    }
    .step-indicator.active {
      font-weight: bold;
      opacity: 1;
      color: var(--bs-info); /* Or your theme's active color */
    }
    .step-indicator.complete {
      opacity: 1;
      color: var(--bs-success); /* Or your theme's success color */
    }
    .step-indicator.error {
      opacity: 1;
      color: var(--bs-danger); /* Or your theme's danger color */
    }
    .step-indicator .step-icon {
      width: 1.2em; /* Ensure icons align */
      text-align: center;
      margin-right: 5px;
    }
    .step-indicator.complete .step-icon::before {
      content: "\\f058"; /* FontAwesome check-circle */
      font-family: "Font Awesome 5 Free";
      font-weight: 900;
    }
     .step-indicator.active .step-icon::before {
      content: "\\f110"; /* FontAwesome spinner */
      font-family: "Font Awesome 5 Free";
      font-weight: 900;
      display: inline-block;
      animation: fa-spin 2s infinite linear;
    }
     .step-indicator.error .step-icon::before {
      content: "\\f06a"; /* FontAwesome exclamation-circle */
      font-family: "Font Awesome 5 Free";
      font-weight: 900;
    }

    .connection-status {
        position: fixed;
        bottom: 10px;
        right: 10px;
        z-index: 1050; /* Ensure it's above most elements */
    }

    #coverage-areas-table tbody tr td {
        vertical-align: middle;
    }

    /* Responsive Table Styles */
    @media screen and (max-width: 768px) {
      #coverage-areas-table thead {
        display: none;
      }
      #coverage-areas-table tbody, #coverage-areas-table tr, #coverage-areas-table td {
        display: block;
        width: 100%;
      }
      #coverage-areas-table tr {
        margin-bottom: 1rem;
        border: 1px solid #dee2e6;
        border-radius: 0.25rem;
      }
      #coverage-areas-table td {
        text-align: right;
        padding-left: 50%; /* Adjust as needed */
        position: relative;
        border-bottom: 1px solid #eee;
      }
      #coverage-areas-table td::before {
        content: attr(data-label);
        position: absolute;
        left: 10px;
        width: calc(50% - 20px); /* Adjust as needed */
        padding-right: 10px;
        white-space: nowrap;
        text-align: left;
        font-weight: bold;
      }
      #coverage-areas-table td:last-child {
        border-bottom: 0;
      }
      #coverage-areas-table td[data-label="Actions"] .btn-group {
        width: 100%;
        display: flex;
        justify-content: flex-end; /* Align buttons to the right */
      }
      #coverage-areas-table td[data-label="Actions"] .btn {
         flex-grow: 1; /* Make buttons fill space if needed */
         margin: 2px;
      }
    }

     /* Dashboard Chart Styling */
     #street-type-chart {
        height: 300px; /* Or adjust as needed */
        width: 100%;
     }

     /* Map Info Panel */
    .map-info-panel {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 1000;
        background: rgba(40, 40, 40, 0.85);
        color: #eee;
        padding: 10px 15px;
        border-radius: 5px;
        max-width: 250px;
        font-size: 0.85rem;
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        display: none; /* Hidden by default */
        border: 1px solid #555;
    }
  `;
  document.head.appendChild(style);
})();

(() => {
  class CoverageManager {
    constructor() {
      this.locationData = null;
      this.validatedLocation = null;
      this.currentProcessingLocation = null;
      this.task_id = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.tooltips = [];
      this.useMiles = true; // Default to miles in the US
      this.coverageMap = null;
      this.streetTypeChartInstance = null;
      this.selectedLocation = null;
      this.streets = null;
      this.coverageSummaryControl = null;
      this.drawnStreetLayers = []; // Track street layers for filtering

      // Check for notification manager
      if (typeof window.notificationManager === "undefined") {
        console.warn(
          "notificationManager not found, fallbacks will use console.log",
        );
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
        window.confirmationDialog = {
          show: async (options) => {
            return confirm(options.message || "Are you sure?");
          },
        };
      }

      document.addEventListener("DOMContentLoaded", () => {
        this.setupAutoRefresh();
        this.checkForInterruptedTasks();
        this.setupConnectionMonitoring();
        this.initTooltips(); // Initialize tooltips after DOM is ready
      });

      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    setupConnectionMonitoring() {
      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        let statusBar = document.querySelector(".connection-status");

        if (!statusBar) {
          statusBar = document.createElement("div");
          statusBar.className = "connection-status";
          document.querySelector("#alerts-container").appendChild(statusBar);
        }

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

        // Auto-hide after 5 seconds if connected
        if (isOnline) {
          setTimeout(() => {
            const currentStatusBar =
              document.querySelector(".connection-status");
            if (currentStatusBar) {
              const bsAlert =
                bootstrap.Alert.getOrCreateInstance(currentStatusBar);
              if (bsAlert) {
                bsAlert.close(); // Use Bootstrap's close method
              } else {
                currentStatusBar.remove(); // Fallback removal
              }
            }
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
          try {
            tooltip.dispose();
          } catch (e) {
            /* ignore errors during disposal */
          }
        }
      });
      this.tooltips = [];

      // Initialize tooltips on elements with data-bs-toggle="tooltip"
      const tooltipTriggerList = document.querySelectorAll(
        '[data-bs-toggle="tooltip"]',
      );
      this.tooltips = [...tooltipTriggerList]
        .map((tooltipTriggerEl) => {
          try {
            return new bootstrap.Tooltip(tooltipTriggerEl);
          } catch (e) {
            console.warn("Failed to initialize tooltip", e);
            return null;
          }
        })
        .filter((t) => t !== null); // Filter out any failed initializations
    }

    enhanceResponsiveTables() {
      const tables = document.querySelectorAll("#coverage-areas-table");
      tables.forEach((table) => {
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
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          if (now - savedTime < 30 * 60 * 1000) {
            const location = progressData.location;
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

            notification
              .querySelector(".resume-task")
              .addEventListener("click", () => {
                this.resumeInterruptedTask(progressData);
                const bsAlert =
                  bootstrap.Alert.getOrCreateInstance(notification);
                if (bsAlert) bsAlert.close();
                else notification.remove();
              });
            notification
              .querySelector(".discard-task")
              .addEventListener("click", () => {
                localStorage.removeItem("coverageProcessingState");
                const bsAlert =
                  bootstrap.Alert.getOrCreateInstance(notification);
                if (bsAlert) bsAlert.close();
                else notification.remove();
              });

            document
              .querySelector("#alerts-container")
              .appendChild(notification);
          } else {
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

      // Always restart as a full update for simplicity and robustness after interruption
      window.notificationManager.show(
        "Restarting interrupted task as a full update...",
        "info",
      );
      this.updateCoverageForArea(savedData.location, "full");
    }

    saveProcessingState() {
      if (this.currentProcessingLocation && this.task_id) {
        // Only save if a task is actively being processed
        const progressBar = document.querySelector(".progress-bar");
        const saveData = {
          location: this.currentProcessingLocation,
          taskId: this.task_id,
          stage:
            document
              .querySelector("#taskProgressModal .stage-info .badge")
              ?.textContent.trim() || "Processing", // Get stage from badge
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

      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;
          const locationInputEl = document.getElementById("location-input");
          locationInputEl.classList.remove("is-invalid", "is-valid");
        });

      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          this.loadCoverageAreas();
          this.currentProcessingLocation = null;
          if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
          }
          localStorage.removeItem("coverageProcessingState");
          window.removeEventListener("beforeunload", this.saveProcessingState); // Remove specific listener
        });

      // Add listener specifically for saving state
      window.addEventListener(
        "beforeunload",
        this.saveProcessingState.bind(this),
      );

      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const target = e.target.closest("button[data-location]");
          if (!target) return;
          e.preventDefault();
          const locationStr = target.dataset.location;
          if (!locationStr) return;
          try {
            const location = JSON.parse(locationStr);
            if (target.classList.contains("update-coverage-btn"))
              this.updateCoverageForArea(location, "full");
            else if (target.classList.contains("update-incremental-btn"))
              this.updateCoverageForArea(location, "incremental");
            else if (target.classList.contains("delete-area-btn"))
              this.deleteArea(location);
            else if (target.classList.contains("cancel-processing"))
              this.cancelProcessing(location);
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

      document.addEventListener("click", (e) => {
        const locationLink = e.target.closest(".location-name-link");
        if (locationLink) {
          e.preventDefault();
          const locationId = locationLink.dataset.locationId;
          if (locationId) this.displayCoverageDashboard(locationId);
          else console.error("Location ID missing from link:", locationLink);
        }

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

      document
        .getElementById("export-coverage-map")
        ?.addEventListener("click", () => {
          if (this.coverageMap) this.exportCoverageMap();
          else
            window.notificationManager.show(
              "No map is currently displayed to export.",
              "warning",
            );
        });

      document
        .getElementById("show-all-streets")
        ?.addEventListener("click", (e) => this.setMapFilter("all"));
      document
        .getElementById("show-driven-streets")
        ?.addEventListener("click", (e) => this.setMapFilter("driven"));
      document
        .getElementById("show-undriven-streets")
        ?.addEventListener("click", (e) => this.setMapFilter("undriven"));
    }

    async validateLocation() {
      const locationInputEl = document.getElementById("location-input");
      const locationInput = locationInputEl?.value.trim();
      locationInputEl.classList.remove("is-invalid", "is-valid");

      if (!locationInput) {
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
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.detail || `HTTP error! status: ${response.status}`,
          );
        if (!data || !data.osm_id) {
          locationInputEl.classList.add("is-invalid");
          window.notificationManager.show(
            "Location not found or invalid. Please check input.",
            "warning",
          );
          this.validatedLocation = null;
          document.getElementById("add-coverage-area").disabled = true;
          return;
        }
        locationInputEl.classList.add("is-valid");
        this.validatedLocation = data;
        document.getElementById("add-coverage-area").disabled = false;
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
        document.getElementById("add-coverage-area").disabled = true;
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
      addButton.disabled = true;
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      try {
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok)
          throw new Error("Failed to fetch current areas");
        const { areas } = await currentAreasResponse.json();
        const exists = areas.some(
          (area) =>
            area.location?.display_name === this.validatedLocation.display_name,
        );
        if (exists) {
          window.notificationManager.show(
            "This area is already tracked.",
            "warning",
          );
          return;
        }

        // Optimistic UI update removed for robustness, rely on loadCoverageAreas

        const processingLocation = { ...this.validatedLocation }; // Clone validated data
        this.currentProcessingLocation = processingLocation;
        this.task_id = null; // Reset task ID

        this.showProgressModal(
          `Starting processing for ${processingLocation.display_name}...`,
          0,
        );

        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(processingLocation),
        });
        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal();
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`,
          );
        }

        window.notificationManager.show("Area processing started.", "info");

        if (taskData?.task_id) {
          this.task_id = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          let pollingSuccessful = false;

          try {
            await this.pollCoverageProgress(taskData.task_id);
            pollingSuccessful = true;
            // Final success notification handled by pollCoverageProgress/updateModalContent
            // Modal stays open until closed by user or page navigation
          } catch (pollError) {
            const errorMessage =
              typeof pollError === "object"
                ? pollError.message || JSON.stringify(pollError)
                : String(pollError);
            window.notificationManager.show(
              `Processing failed: ${errorMessage}`,
              "danger",
            );
            // Modal updated to error state by pollCoverageProgress
          } finally {
            this.activeTaskIds.delete(taskData.task_id);
            this.task_id = null; // Clear task ID
            // Don't clear currentProcessingLocation here, modal might still be open
            await this.loadCoverageAreas(); // Refresh table after polling finishes
          }
        } else {
          this.hideProgressModal();
          window.notificationManager.show(
            "Processing started, but no task ID for progress.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid");
        }
        this.validatedLocation = null;
      } catch (error) {
        const errorMessage =
          typeof error === "object"
            ? error.message || JSON.stringify(error)
            : String(error);
        console.error("Error adding coverage area:", error);
        window.notificationManager.show(
          `Failed to add area: ${errorMessage}`,
          "danger",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } finally {
        addButton.disabled = true; // Keep disabled until next validation
        addButton.innerHTML = originalButtonText;
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel || !locationToCancel.display_name) {
        window.notificationManager.show(
          "No processing context to cancel.",
          "warning",
        );
        return;
      }

      const confirmed = await window.confirmationDialog.show({
        title: "Cancel Processing",
        message: `Cancel processing for <strong>${locationToCancel.display_name}</strong>?`,
        confirmText: "Yes, Cancel",
        cancelText: "No",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      window.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info",
      );

      try {
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToCancel),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.detail ||
              `Failed to send cancel request (HTTP ${response.status})`,
          );

        window.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        window.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
      } finally {
        // Clear context even on failure to cancel, as the task might still finish/error out
        this.currentProcessingLocation = null;
        this.task_id = null;
      }
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      this.processingStartTime = new Date();
      this.lastActivityTime = new Date();

      const modalProgressBar = modalElement.querySelector(".progress-bar");
      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        modalProgressBar.className =
          "progress-bar progress-bar-striped progress-bar-animated"; // Reset classes
      }

      const progressMessage = modalElement.querySelector(".progress-message");
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.classList.remove("text-danger");
      }

      // Ensure dynamic elements exist
      const dynamicElementsContainer = modalElement.querySelector(
        ".dynamic-modal-elements",
      );
      if (
        dynamicElementsContainer &&
        !dynamicElementsContainer.querySelector(".step-indicator-container")
      ) {
        dynamicElementsContainer.innerHTML = `
              <div class="row">
                  <div class="col-md-8">
                      <div class="stage-info mb-2"></div>
                      <div class="detailed-stage-info text-muted mb-2 small">Initializing...</div>
                      <div class="stats-info mb-2"></div>
                  </div>
                  <div class="col-md-4">
                      <div class="step-indicator-container border-start ps-3">
                          <div class="step-indicator step-initializing"><span class="step-icon"></span> Initializing</div>
                          <div class="step-indicator step-preprocessing"><span class="step-icon"></span> Preprocessing</div>
                          <div class="step-indicator step-indexing"><span class="step-icon"></span> Indexing</div>
                          <div class="step-indicator step-calculating"><span class="step-icon"></span> Calculating</div>
                          <div class="step-indicator step-complete"><span class="step-icon"></span> Complete</div>
                      </div>
                      <div class="activity-indicator-container mt-2 pt-2 border-top">
                          <div class="d-flex align-items-center justify-content-between">
                              <small class="activity-indicator pulsing"><i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active</small>
                              <small class="last-update-time text-muted"></small>
                          </div>
                          <div class="timing-info mt-1">
                            <small class="elapsed-time text-muted"></small>
                          </div>
                           <button type="button" class="btn btn-sm btn-outline-secondary unit-toggle mt-2">Switch Units</button>
                      </div>
                  </div>
              </div>
          `;
      }

      if (!modalElement.classList.contains("show")) {
        const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
          backdrop: "static",
          keyboard: false,
        });
        bsModal.show();
      }

      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = setInterval(() => this.updateTimingInfo(), 1000);
      this.updateTimingInfo(); // Initial update
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      try {
        const modal = bootstrap.Modal.getInstance(modalElement);
        if (modal) modal.hide();
        else modalElement.classList.remove("show"); // Fallback
      } catch (error) {
        console.error("Error hiding modal:", error);
        modalElement.classList.remove("show"); // Force hide
      }

      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      localStorage.removeItem("coverageProcessingState");
      window.removeEventListener(
        "beforeunload",
        this.saveProcessingState.bind(this),
      );
      // Don't clear currentProcessingLocation here, might be needed by caller
      // this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
    }

    updateTimingInfo() {
      if (!this.processingStartTime) return;

      const now = Date.now();
      const elapsedMs = now - this.processingStartTime;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      let elapsedText = `${elapsedSeconds}s`;
      if (elapsedSeconds >= 60) {
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        elapsedText = `${minutes}m ${seconds}s`;
      }

      const elapsedTimeEl = document.querySelector(
        "#taskProgressModal .elapsed-time",
      );
      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
    }

    // --- THIS IS THE CORRECTED updateModalContent ---
    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return; // Safely exit if modal doesn't exist

      // Extract properties from data
      const {
        stage = "unknown",
        progress = 0,
        message = "Processing...",
        metrics = {},
        time_elapsed = 0,
        time_remaining = null,
      } = data;

      // --- Progress Bar Updates ---
      const progressBar = modalElement.querySelector(".progress-bar");
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
      }

      // --- Stage/Step Indicators ---
      this.updateStepIndicators(stage, progress);

      // --- Progress Message ---
      const progressMessage = modalElement.querySelector(".progress-message");
      if (progressMessage) {
        progressMessage.textContent = message || "Processing...";
      }

      // --- Stage Info Badge ---
      const stageInfo = modalElement.querySelector(".stage-info");
      if (stageInfo) {
        const stageIcon = CoverageManager.getStageIcon(stage);
        const stageBadgeClass = CoverageManager.getStageBadgeClass(stage);
        const stageName = CoverageManager.formatStageName(stage);
        stageInfo.innerHTML = `<span class="badge ${stageBadgeClass}">${stageIcon} ${stageName}</span>`;
      }

      // --- Timer Updates ---
      if (time_elapsed !== undefined && time_elapsed !== null) {
        const elapsedTimeEl = modalElement.querySelector(".elapsed-time");
        if (elapsedTimeEl) {
          const formattedElapsed = this.formatTime(time_elapsed);
          elapsedTimeEl.textContent = `Elapsed: ${formattedElapsed}`;
        }
      }

      if (time_remaining !== undefined && time_remaining !== null) {
        const remainingTimeEl = modalElement.querySelector(".estimated-time");
        if (remainingTimeEl) {
          const formattedRemaining = this.formatTime(time_remaining);
          remainingTimeEl.textContent = `Est. remaining: ${formattedRemaining}`;
        }
      }

      // --- Stats Info Updates ---
      const statsInfoEl = modalElement.querySelector(".stats-info");
      if (!statsInfoEl) return;

      // Remove local distanceInUserUnits definition - using class method instead

      // --- Unit Toggle (Unchanged, seems ok) ---
      const unitToggleEl = modalElement.querySelector(".unit-toggle");
      if (unitToggleEl) {
        unitToggleEl.textContent = this.useMiles
          ? "Switch to km"
          : "Switch to mi";
        unitToggleEl.onclick = () => {
          this.useMiles = !this.useMiles;
          this.updateModalContent(data); // Re-render with new units
        };
      }

      // --- Update Stats Area using Metrics ---
      let statsHtml =
        '<div class="text-muted small">Waiting for details...</div>'; // Default

      if (Object.keys(metrics).length > 0) {
        // Only show stats if metrics object has data
        statsHtml = '<div class="mt-1">'; // Start container

        // Indexing Stage Stats
        if (metrics.rtree_items !== undefined && stage === "indexing") {
          statsHtml += `
                  <div class="d-flex justify-content-between"><small>Streets Indexed:</small><small class="text-info">${metrics.rtree_items.toLocaleString()}</small></div>
                  <div class="d-flex justify-content-between"><small>Driveable Length:</small><small>${this.distanceInUserUnits(metrics.driveable_length_m || 0)}</small></div>
                  <div class="d-flex justify-content-between"><small>Initial Coverage:</small><small>${this.distanceInUserUnits(metrics.covered_length_m || 0)} (${metrics.coverage_percentage?.toFixed(1) || 0}%)</small></div>
              `;
        }

        // Trip Processing Stage Stats
        else if (
          metrics.total_trips_to_process !== undefined &&
          stage === "processing_trips"
        ) {
          const processed = metrics.processed_trips || 0;
          const total = metrics.total_trips_to_process || 0;
          const tripsProgress =
            total > 0 ? Math.min(100, (processed / total) * 100) : 0; // Cap at 100%
          const newlyFound = metrics.newly_covered_segments || 0;
          const coveragePercent =
            metrics.coverage_percentage?.toFixed(1) || "N/A";

          statsHtml += `
                  <div class="d-flex justify-content-between">
                      <small>Trip Progress:</small>
                      <small class="text-info">${processed.toLocaleString()}/${total.toLocaleString()} (${tripsProgress.toFixed(1)}%)</small>
                  </div>
                  <div class="progress mt-1 mb-2" style="height: 5px;">
                      <div class="progress-bar bg-info" style="width: ${tripsProgress}%"></div>
                  </div>
                  ${
                    newlyFound > 0
                      ? `
                  <div class="d-flex justify-content-between">
                      <small>New Segments Found:</small>
                      <small class="text-success">+${newlyFound.toLocaleString()}</small>
                  </div>`
                      : ""
                  }
                  <div class="d-flex justify-content-between">
                      <small>Est. Coverage:</small>
                      <small>${coveragePercent}%</small>
                  </div>
              `;
        }

        // Finalizing / Complete Stages Stats
        else if (
          metrics.coverage_percentage !== undefined &&
          (stage === "finalizing" ||
            stage === "generating_geojson" ||
            stage === "complete_stats" ||
            stage === "complete")
        ) {
          const newlyCoveredCount = metrics.newly_covered_segments || 0; // From metrics if available
          const totalCoveredCount = metrics.total_covered_segments || 0;
          const totalSegments =
            metrics.total_segments || metrics.rtree_items || 0; // Use total_segments if available
          const coveragePercent =
            metrics.coverage_percentage?.toFixed(1) || "0.0";
          const driveableLength = metrics.driveable_length_m || 0;
          const coveredLength = metrics.covered_length_m || 0;

          if (newlyCoveredCount > 0) {
            statsHtml += `<div class="d-flex justify-content-between"><small>New Segments Covered:</small><small class="text-success">+${newlyCoveredCount.toLocaleString()}</small></div>`;
          }
          statsHtml += `
                  <div class="d-flex justify-content-between"><small>Total Covered:</small><small>${totalCoveredCount.toLocaleString()} / ${totalSegments.toLocaleString()} segs</small></div>
                  <div class="d-flex justify-content-between"><small>Final Coverage:</small><small class="fw-bold text-${parseFloat(coveragePercent) >= 80 ? "success" : parseFloat(coveragePercent) >= 50 ? "primary" : "warning"}">${coveragePercent}%</small></div>
                  <div class="d-flex justify-content-between"><small>Distance Covered:</small><small>${this.distanceInUserUnits(coveredLength)} / ${this.distanceInUserUnits(driveableLength)}</small></div>
              `;
        }
        // Fallback if metrics exist but don't match expected stage structure
        else if (Object.keys(metrics).length > 0) {
          statsHtml +=
            '<div class="text-muted small">Processing details available...</div>';
        }

        statsHtml += "</div>"; // Close container
      }

      statsInfoEl.innerHTML = statsHtml;

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

        // Stop activity indicator pulsing/spinning
        if (activityIndicatorEl) {
          activityIndicatorEl.classList.remove("pulsing");
          if (stage === "complete") {
            activityIndicatorEl.innerHTML =
              '<i class="fas fa-check text-success me-1"></i>Finished';
          } else {
            // Error
            activityIndicatorEl.innerHTML =
              '<i class="fas fa-times text-danger me-1"></i>Failed';
          }
        }
      }
    }
    // --- END OF CORRECTED updateModalContent ---

    // --- THIS IS THE CORRECTED updateStepIndicators ---
    updateStepIndicators(stage, progress) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const steps = {
        initializing: modalElement.querySelector(".step-initializing"),
        preprocessing: modalElement.querySelector(".step-preprocessing"),
        indexing: modalElement.querySelector(".step-indexing"),
        // Rename 'calculating' step to reflect trip processing better
        processing_trips: modalElement.querySelector(".step-calculating"), // Link calculating UI step to processing_trips backend stage
        complete: modalElement.querySelector(".step-complete"), // Represents finalizing/generating GeoJSON/complete
      };

      // Reset all steps first
      Object.values(steps).forEach((step) => {
        if (step) step.classList.remove("active", "complete", "error");
      });

      // Determine state based on stage
      if (stage === "error") {
        // Mark the step where the error likely occurred as 'error'
        // Mark preceding steps as 'complete'
        if (progress < 5) {
          // Error during initializing
          if (steps.initializing) steps.initializing.classList.add("error");
        } else if (progress < 25) {
          // Error during preprocessing
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing) steps.preprocessing.classList.add("error");
        } else if (progress < 50) {
          // Error during indexing
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("error");
        } else if (progress < 95) {
          // Error during trip processing (stage: processing_trips)
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.processing_trips)
            steps.processing_trips.classList.add("error");
        } else {
          // Error during finalizing, generating_geojson, complete_stats, or other late stage
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.processing_trips)
            steps.processing_trips.classList.add("complete");
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
          if (steps.processing_trips)
            steps.processing_trips.classList.add("active");
        } else if (
          stage === "finalizing" ||
          stage === "generating_geojson" ||
          stage === "complete_stats"
        ) {
          if (steps.initializing) steps.initializing.classList.add("complete");
          if (steps.preprocessing)
            steps.preprocessing.classList.add("complete");
          if (steps.indexing) steps.indexing.classList.add("complete");
          if (steps.processing_trips)
            steps.processing_trips.classList.add("complete");
          if (steps.complete) steps.complete.classList.add("active");
        } else {
          // Default or unknown stage
          if (steps.initializing) steps.initializing.classList.add("active");
        }
      }
    }
    // --- END OF CORRECTED updateStepIndicators ---

    static getStageIcon(stage) {
      const icons = {
        initializing: '<i class="fas fa-cog"></i>', // Removed spin for static view
        preprocessing: '<i class="fas fa-map-marked-alt"></i>',
        indexing: '<i class="fas fa-project-diagram"></i>',
        processing_trips: '<i class="fas fa-route"></i>', // Changed icon
        calculating: '<i class="fas fa-cogs"></i>', // Keep generic calculating if needed
        finalizing: '<i class="fas fa-chart-line"></i>',
        complete_stats: '<i class="fas fa-check-double"></i>', // Differentiate from final complete
        generating_geojson: '<i class="fas fa-file-code"></i>', // Removed spin
        complete: '<i class="fas fa-check-circle"></i>',
        error: '<i class="fas fa-exclamation-circle"></i>',
        warning: '<i class="fas fa-exclamation-triangle"></i>',
      };
      return icons[stage] || '<i class="fas fa-question-circle"></i>';
    }

    static getStageBadgeClass(stage) {
      const badges = {
        initializing: "bg-secondary",
        preprocessing: "bg-info text-dark", // Dark text for light blue
        indexing: "bg-primary",
        processing_trips: "bg-primary",
        calculating: "bg-primary", // Keep if used
        finalizing: "bg-info text-dark",
        complete_stats: "bg-info text-dark",
        generating_geojson: "bg-info text-dark",
        complete: "bg-success",
        error: "bg-danger",
        warning: "bg-warning text-dark", // Dark text for yellow
      };
      return badges[stage] || "bg-secondary";
    }

    static formatStageName(stage) {
      const stageNames = {
        initializing: "Initializing",
        preprocessing: "Fetching Streets",
        indexing: "Indexing Streets",
        processing_trips: "Processing Trips",
        calculating: "Calculating", // Generic fallback if used
        finalizing: "Finalizing Stats",
        complete_stats: "Stats Complete",
        generating_geojson: "Generating Map",
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
        this.constructor.updateCoverageTable(data.areas);
        this.enhanceResponsiveTables();
        this.initTooltips();
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        window.notificationManager.show(
          `Failed to load areas: ${error.message}. Refresh?`,
          "danger",
        );
      }
    }

    static updateCoverageTable(areas) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;
      tableBody.innerHTML = "";

      if (!areas || areas.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="7" class="text-center fst-italic text-muted">No areas defined.</td></tr>';
        return;
      }

      areas.sort((a, b) =>
        a.location.display_name.localeCompare(b.location.display_name),
      );

      areas.forEach((area) => {
        const row = document.createElement("tr");
        const status = area.status || "unknown";
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

        if (isProcessing) row.classList.add("processing-row", "table-info");
        else if (hasError) row.classList.add("table-danger");
        else if (isCanceled) row.classList.add("table-warning");

        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        // Use _m fields directly from backend stats
        const totalLengthM = area.total_length_m || area.total_length || 0;
        const drivenLengthM = area.driven_length_m || area.driven_length || 0;
        const totalMiles = (totalLengthM * 0.000621371).toFixed(2);
        const drivenMiles = (drivenLengthM * 0.000621371).toFixed(2);
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0";

        let progressBarColor = "bg-success";
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if (parseFloat(coveragePercentage) < 25)
          progressBarColor = "bg-danger";
        else if (parseFloat(coveragePercentage) < 75)
          progressBarColor = "bg-warning";

        const escapedLocation = JSON.stringify(area.location || {}).replace(
          /'/g,
          "'",
        ); // Ensure escaping apostrophes if needed

        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${area._id}">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${hasError ? `<div class="text-danger small" title="${area.last_error || ""}"><i class="fas fa-exclamation-circle me-1"></i>Error</div>` : ""}
            ${isCanceled ? `<div class="text-warning small"><i class="fas fa-ban me-1"></i>Canceled</div>` : ""}
            ${isProcessing ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>${this.formatStageName(status)}...</div>` : ""}
          </td>
          <td data-label="Total Length" class="text-end">${totalMiles} mi</td>
          <td data-label="Driven Length" class="text-end">${drivenMiles} mi</td>
          <td data-label="Coverage">
            <div class="progress" style="height: 20px;" title="${coveragePercentage}%">
              <div class="progress-bar ${progressBarColor}" role="progressbar" style="width: ${coveragePercentage}%;" aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100">
                ${coveragePercentage}%
              </div>
            </div>
          </td>
          <td data-label="Segments" class="text-end">${area.total_segments?.toLocaleString() || 0}</td>
          <td data-label="Last Updated">${lastUpdated}</td>
          <td data-label="Actions">
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success update-coverage-btn" title="Full Update (Recalculate All)" data-location='${escapedLocation}' ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip" data-bs-title="Full update - recalculates all coverage data"><i class="fas fa-sync-alt"></i></button>
              <button class="btn btn-sm btn-info update-incremental-btn" title="Quick Update (New Trips Only)" data-location='${escapedLocation}' ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip" data-bs-title="Quick update - only processes new trips"><i class="fas fa-bolt"></i></button>
              <button class="btn btn-sm btn-danger delete-area-btn" title="Delete Area" data-location='${escapedLocation}' ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip" data-bs-title="Remove this area and all its coverage data"><i class="fas fa-trash-alt"></i></button>
              ${isProcessing ? `<button class="btn btn-sm btn-warning cancel-processing" title="Cancel Processing" data-location='${escapedLocation}' data-bs-toggle="tooltip" data-bs-title="Stop the current processing operation"><i class="fas fa-stop-circle"></i></button>` : ""}
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    async updateCoverageForArea(location, mode = "full") {
      if (!location || !location.display_name) {
        window.notificationManager.show(
          "Invalid location data for update.",
          "warning",
        );
        return;
      }

      const displayName = location.display_name;

      // Check if already processing this location
      const currentArea = Array.from(
        document.querySelectorAll("#coverage-areas-table tbody tr"),
      ).find((row) => {
        const link = row.querySelector(".location-name-link");
        return (
          link &&
          link.textContent.trim() === displayName &&
          row.classList.contains("processing-row")
        );
      });
      if (currentArea) {
        window.notificationManager.show(
          `Update already in progress for ${displayName}.`,
          "info",
        );
        return;
      }

      const processingLocation = { ...location }; // Clone location
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
        `Requesting coverage update (${mode}) for ${displayName}...`,
      );

      const endpoint =
        mode === "incremental"
          ? "/api/street_coverage/incremental"
          : "/api/street_coverage";
      const payload = { ...processingLocation }; // Use the cloned data

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to start update (HTTP ${response.status})`,
          );
        }

        if (data.task_id) {
          this.task_id = data.task_id;
          this.activeTaskIds.add(data.task_id);
          let pollingSuccessful = false;

          try {
            await this.pollCoverageProgress(data.task_id);
            pollingSuccessful = true;
            // Modal stays open, success handled visually within modal
          } catch (pollError) {
            const errorMessage =
              typeof pollError === "object"
                ? pollError.message || JSON.stringify(pollError)
                : String(pollError);
            window.notificationManager.show(
              `Update for ${displayName} failed: ${errorMessage}`,
              "danger",
            );
            // Modal shows error state via pollCoverageProgress
          } finally {
            this.activeTaskIds.delete(data.task_id);
            this.task_id = null;
            // Don't clear currentProcessingLocation here - let modal close handle it
            await this.loadCoverageAreas(); // Refresh table regardless of poll outcome
            if (pollingSuccessful && displayedLocationId) {
              await this.displayCoverageDashboard(displayedLocationId); // Refresh dashboard if successful
            }
          }
        } else {
          this.hideProgressModal(); // Hide if no task ID
          window.notificationManager.show(
            "Update started, but no task ID for progress.",
            "warning",
          );
          await this.loadCoverageAreas();
        }
      } catch (error) {
        const errorMessage =
          typeof error === "object"
            ? error.message || JSON.stringify(error)
            : String(error);
        console.error("Error updating coverage:", error);
        window.notificationManager.show(
          `Coverage update failed: ${errorMessage}`,
          "danger",
        );
        this.hideProgressModal(); // Hide on initial error
        await this.loadCoverageAreas();
        // Don't clear currentProcessingLocation here
      }
      // No 'finally' block to automatically hide modal, it stays until user interaction or completion/error display
    }

    async isSameLocation(loc1, loc2) {
      if (!loc1 || !loc2) return false;
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
        message: `Delete all data for <strong>${location.display_name}</strong>? Cannot be undone.`,
        confirmText: "Delete",
        confirmButtonClass: "btn-danger",
      });
      if (!confirmed) return;

      try {
        window.notificationManager.show(
          `Deleting ${location.display_name}...`,
          "info",
        );
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(location),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`,
          );

        await this.loadCoverageAreas();
        if (
          this.selectedLocation &&
          (await this.isSameLocation(this.selectedLocation.location, location))
        ) {
          document.getElementById("coverage-dashboard").style.display = "none";
          this.selectedLocation = null;
          this.coverageMap = null;
        }
        window.notificationManager.show(
          `Area '${location.display_name}' deleted.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        window.notificationManager.show(
          `Error deleting area: ${error.message}`,
          "danger",
        );
      }
    }

    setupAutoRefresh() {
      setInterval(async () => {
        // Only refresh if there's an active processing row *and* the modal isn't open
        const isProcessing = document.querySelector(".processing-row");
        const modalElement = document.getElementById("taskProgressModal");
        const isModalOpen =
          modalElement && modalElement.classList.contains("show");

        if (isProcessing && !isModalOpen) {
          console.debug(
            "Auto-refreshing coverage areas list due to processing row.",
          );
          await this.loadCoverageAreas();
        }
      }, 10000); // Check every 10 seconds
    }

    // --- THIS IS THE CORRECTED pollCoverageProgress ---
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
              let responseText = "";
              try {
                responseText = await response.text();
              } catch (e) {}
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
    // --- END OF CORRECTED pollCoverageProgress ---

    async displayCoverageDashboard(locationId) {
      const dashboardContainer = document.getElementById("coverage-dashboard");
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name",
      );
      const mapContainer = document.getElementById("coverage-map");
      const chartContainer = document.getElementById("street-type-chart");
      const statsContainer = document.getElementById("dashboard-stats"); // Added for stats section

      if (
        !dashboardContainer ||
        !dashboardLocationName ||
        !mapContainer ||
        !chartContainer ||
        !statsContainer
      ) {
        console.error("Dashboard elements not found.");
        return;
      }

      dashboardContainer.style.display = "block";
      dashboardLocationName.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2"></span> Loading...';
      mapContainer.innerHTML = `<div class="d-flex align-items-center justify-content-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Loading Map...</div>`;
      chartContainer.innerHTML = "";
      statsContainer.innerHTML = `<div class="d-flex align-items-center justify-content-center p-4 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Loading Stats...</div>`;

      try {
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "Failed to load coverage data");

        this.selectedLocation = data.coverage;
        const coverage = data.coverage;
        const hasStreetData = coverage.streets_geojson?.features?.length > 0;
        const needsReprocessing = coverage.needs_reprocessing || false;
        const hasError = coverage.has_error || false;
        const status = coverage.status || "unknown";

        // --- Update Title ---
        let titleText = coverage.location_name || "Coverage Details";
        if (hasError)
          titleText += ' <span class="badge bg-danger ms-2">Error</span>';
        else if (needsReprocessing)
          titleText +=
            ' <span class="badge bg-warning text-dark ms-2">Needs Update</span>';
        else if (
          [
            "processing",
            "preprocessing",
            "calculating",
            "indexing",
            "finalizing",
            "generating_geojson",
            "complete_stats",
          ].includes(status)
        )
          titleText +=
            ' <span class="badge bg-info text-dark ms-2">Processing...</span>';
        else if (status === "completed" && !hasStreetData)
          titleText +=
            ' <span class="badge bg-secondary ms-2">No Map Data</span>';
        else if (status === "completed")
          titleText += ' <span class="badge bg-success ms-2">Completed</span>';
        dashboardLocationName.innerHTML = titleText;

        // --- Update Stats ---
        statsContainer.innerHTML = ""; // Clear loading message
        this.updateDashboardStats(coverage); // This will populate the stats container

        // --- Handle Map/Chart based on data ---
        if (needsReprocessing || !hasStreetData || hasError) {
          let statusMessage;
          if (hasError) {
            statusMessage = `<div class="alert alert-danger"><h5><i class="fas fa-exclamation-circle me-2"></i>Error in Last Calculation</h5><p>${coverage.error_message || "An unexpected error occurred."}</p><hr><p class="mb-1">Try running an update:</p><button class="update-missing-data-btn btn btn-sm btn-primary" data-location='${JSON.stringify(coverage.location || {}).replace(/'/g, "'")}'>Update Now</button></div>`;
          } else if (status === "completed" && !hasStreetData) {
            statusMessage = `<div class="alert alert-info"><h5><i class="fas fa-spinner fa-spin me-2"></i>Finalizing Map Data</h5><p>Coverage statistics calculated. Generating detailed map data...</p><div class="progress mt-2"><div class="progress-bar progress-bar-striped progress-bar-animated" style="width: 100%"></div></div></div>`;
            setTimeout(() => this.displayCoverageDashboard(locationId), 8000);
          } else {
            // needsReprocessing or other non-complete status without error
            statusMessage = `<div class="alert alert-warning"><h5><i class="fas fa-exclamation-triangle me-2"></i>Map Data Not Available</h5><p>Please update the coverage data to generate the map:</p><button class="update-missing-data-btn btn btn-sm btn-primary" data-location='${JSON.stringify(coverage.location || {}).replace(/'/g, "'")}'>Update Now</button></div>`;
          }
          mapContainer.innerHTML = statusMessage;
          chartContainer.innerHTML =
            '<div class="alert alert-secondary small p-2">Chart requires map data.</div>';
        } else {
          // --- Success Path ---
          window.notificationManager.show(
            `Loaded map for ${coverage.location_name}`,
            "success",
          );
          this.initializeCoverageMap(coverage);
          this.createStreetTypeChart(coverage.street_types);
        }

        dashboardContainer.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        this.initTooltips(); // Re-init after potential DOM changes
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
        chartContainer.innerHTML = "";
        statsContainer.innerHTML = ""; // Clear stats on error too
        window.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
      }
    }

    // --- THIS IS THE CORRECTED updateDashboardStats ---
    updateDashboardStats(coverage) {
      if (!coverage) return;

      // Add console.log to debug coverage data
      console.log("Coverage data:", {
        coverage_percentage: coverage.coverage_percentage,
        driven_length_m: coverage.driven_length_m,
        covered_length_m: coverage.covered_length_m,
        driveable_length_m: coverage.driveable_length_m,
        total_length_m: coverage.total_length_m,
        status: coverage.status,
      });

      const statsContainer = document.getElementById("dashboard-stats"); // Get the container
      if (!statsContainer) return; // Exit if container not found

      // Use metric fields with '_m' suffix from the coverage object
      const totalLength = coverage.total_length_m || 0;
      // If driven_length_m is 0 or undefined, use covered_length_m instead
      const drivenLength =
        coverage.driven_length_m || coverage.covered_length_m || 0;
      const driveableLength = coverage.driveable_length_m || 0; // Get driveable length
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";
      const totalSegments = coverage.total_segments?.toLocaleString() || "0";
      const coveredSegments =
        coverage.covered_segments?.toLocaleString() || "0"; // Get covered segments count

      // Use unit conversion helper
      const totalDist = this.distanceInUserUnits(totalLength);
      const drivenDist = this.distanceInUserUnits(drivenLength);
      const driveableDist = this.distanceInUserUnits(driveableLength); // Convert driveable length
      const lastUpdated = coverage.last_updated
        ? new Date(coverage.last_updated).toLocaleString()
        : "Never";

      let barColor = "bg-success";
      if (coverage.status === "error" || coverage.status === "canceled")
        barColor = "bg-secondary";
      else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
      else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";

      // Build the HTML for the stats section
      statsContainer.innerHTML = `
            <div class="mb-3">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <h5 class="mb-0">Coverage: ${coveragePercentage}%</h5>
                    <small class="text-muted">Last Updated: ${lastUpdated}</small>
                </div>
                <div class="progress" style="height: 20px;" title="${coveragePercentage}% Covered">
                    <div id="coverage-percentage-bar" class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePercentage}%;"
                         aria-valuenow="${coveragePercentage}" aria-valuemin="0" aria-valuemax="100">${coveragePercentage}%</div>
                </div>
            </div>
            <div class="row g-2 mb-3">
                <div class="col-6 col-md-3">
                    <div class="stat-card p-2 border rounded text-center">
                        <div class="stat-value fs-5 fw-bold">${drivenDist}</div>
                        <div class="stat-label text-muted small">Driven</div>
                    </div>
                </div>
                <div class="col-6 col-md-3">
                    <div class="stat-card p-2 border rounded text-center">
                        <div class="stat-value fs-5 fw-bold">${driveableDist}</div>
                        <div class="stat-label text-muted small">Driveable</div>
                    </div>
                </div>
                <div class="col-6 col-md-3">
                    <div class="stat-card p-2 border rounded text-center">
                        <div class="stat-value fs-5 fw-bold">${coveredSegments}</div>
                        <div class="stat-label text-muted small">Segments Covered</div>
                    </div>
                </div>
                 <div class="col-6 col-md-3">
                    <div class="stat-card p-2 border rounded text-center">
                        <div class="stat-value fs-5 fw-bold">${totalSegments}</div>
                        <div class="stat-label text-muted small">Total Segments</div>
                    </div>
                </div>
            </div>
             <h6>Street Type Breakdown</h6>
             <div id="street-type-coverage">
                <!-- Street type details will be populated here -->
                <div class="text-muted small">Loading street types...</div>
             </div>
        `;

      // Now call the function to populate the street type breakdown section
      this.updateStreetTypeCoverage(coverage.street_types);
    }
    // --- END OF CORRECTED updateDashboardStats ---

    // --- THIS IS THE CORRECTED updateStreetTypeCoverage ---
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

      // Sort by total driveable length
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.driveable_length_m || 0) - (a.driveable_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6); // Show top 6

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        // Use metric fields and unit conversion
        const coveredDist = this.distanceInUserUnits(
          type.covered_length_m || 0,
        );
        const driveableDist = this.distanceInUserUnits(
          type.driveable_length_m || 0,
        ); // Use driveable for denominator display

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

      // Add a summary for 'Other' types if more than 6 exist
      if (sortedTypes.length > 6) {
        const otherTypes = sortedTypes.slice(6);
        const otherCovered = otherTypes.reduce(
          (sum, t) => sum + (t.covered_length_m || 0),
          0,
        );
        const otherDriveable = otherTypes.reduce(
          (sum, t) => sum + (t.driveable_length_m || 0),
          0,
        );
        const otherPct =
          otherDriveable > 0
            ? ((otherCovered / otherDriveable) * 100).toFixed(1)
            : "0.0";
        let otherBarColor = "bg-success";
        if (parseFloat(otherPct) < 25) otherBarColor = "bg-danger";
        else if (parseFloat(otherPct) < 75) otherBarColor = "bg-warning";

        html += `
              <div class="street-type-item mb-2">
                <div class="d-flex justify-content-between mb-1">
                  <small><strong>Other Types</strong></small>
                  <small>${otherPct}% (${this.distanceInUserUnits(otherCovered)} / ${this.distanceInUserUnits(otherDriveable)})</small>
                </div>
                <div class="progress" style="height: 8px;" title="Other Types: ${otherPct}% Covered">
                  <div class="progress-bar ${otherBarColor}" role="progressbar" style="width: ${otherPct}%"
                       aria-valuenow="${otherPct}" aria-valuemin="0" aria-valuemax="100"></div>
                </div>
              </div>
           `;
      }

      streetTypeCoverageEl.innerHTML = html;
    }
    // --- END OF CORRECTED updateStreetTypeCoverage ---

    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }
      mapContainer.innerHTML = ""; // Ensure empty

      this.coverageMap = L.map("coverage-map", {
        attributionControl: false,
        zoomControl: true,
        renderer: L.svg(),
      });

      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '© <a href="https://osm.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: "abcd",
          maxZoom: 20,
          minZoom: 5,
        },
      ).addTo(this.coverageMap);

      this.addStreetsToMap(coverage.streets_geojson);
      this.addMapHoverEffects(); // Add hover effects after adding streets
      this.fitMapToBounds();
      this.addCoverageSummary(coverage);

      this.coverageMap.off("zoomend").on("zoomend", () => {
        this.setMapFilter(this.currentFilter || "all"); // Re-apply filter on zoom
      });

      // Add the info panel div if it doesn't exist
      if (!document.querySelector(".map-info-panel")) {
        const infoPanelDiv = document.createElement("div");
        infoPanelDiv.className = "map-info-panel";
        mapContainer.appendChild(infoPanelDiv); // Append to map container
      }
      // Add click listener to map to potentially hide info panel
      this.coverageMap.on("click", (e) => {
        // If the click was not on a feature layer, hide the panel
        if (e.originalEvent.target === this.coverageMap._container) {
          const infoPanel = document.querySelector(".map-info-panel");
          if (infoPanel) infoPanel.style.display = "none";
          if (this.highlightedLayer) {
            try {
              this.highlightedLayer.setStyle(
                this.highlightedLayer.originalStyle,
              );
            } catch (e) {}
            this.highlightedLayer = null;
          }
        }
      });
    }

    styleStreet(feature) {
      const isDriven = feature.properties.driven;
      const isUndriveable = feature.properties.undriveable;
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

      let color, className;
      if (isUndriveable) {
        color = "#607d8b";
        className = "undriveable-street";
      } // Greyish-blue
      else if (isDriven) {
        color = "#4caf50";
        className = "driven-street";
      } // Green
      else {
        color = "#ff5252";
        className = "undriven-street";
      } // Red

      return {
        color,
        weight,
        opacity: 0.8,
        className,
        dashArray: isUndriveable ? "4, 4" : null,
      };
    }

    addStreetsToMap(geojson) {
      if (!this.coverageMap) return;
      if (this.streetLayers) this.streetLayers.clearLayers();
      else this.streetLayers = L.layerGroup().addTo(this.coverageMap);

      this.streetsGeoJson = geojson;
      this.currentFilter = "all"; // Reset filter

      const streetsLayer = L.geoJSON(geojson, {
        style: (feature) => this.styleStreet(feature),
        filter: () => true, // Show all initially
        onEachFeature: (feature, layer) => {
          const props = feature.properties;
          const streetName = props.street_name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const lengthMiles = (props.segment_length * 0.000621371).toFixed(3);
          const status = props.driven ? "Driven" : "Not Driven";
          const segmentId = props.segment_id || "N/A";

          layer.originalStyle = { ...layer.options };
          layer.featureProperties = props; // Store properties on the layer

          const popupContent = document.createElement("div");
          popupContent.className = "street-popup";
          popupContent.innerHTML = `
                    <h6>${streetName}</h6><hr class="my-1">
                    <small>
                      <strong>Type:</strong> ${this.formatStreetType(streetType)}<br>
                      <strong>Length:</strong> ${lengthMiles} mi<br>
                      <strong>Status:</strong> <span class="${props.driven ? "text-success" : "text-danger"}">${status}</span><br>
                      ${props.undriveable ? '<strong>Marked as:</strong> <span class="text-warning">Undriveable</span><br>' : ""}
                      <strong>ID:</strong> ${segmentId}
                    </small>
                    <div class="street-actions mt-2 d-flex gap-2 flex-wrap">
                      ${props.driven ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn">Mark Undriven</button>` : `<button class="btn btn-sm btn-outline-success mark-driven-btn">Mark Driven</button>`}
                      ${props.undriveable ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn">Mark Driveable</button>` : `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn">Mark Undriveable</button>`}
                    </div>`;

          // Attach event listeners to buttons within the popup
          const self = this;
          popupContent
            .querySelector(".mark-driven-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "driven"),
            );
          popupContent
            .querySelector(".mark-undriven-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "undriven"),
            );
          popupContent
            .querySelector(".mark-undriveable-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "undriveable"),
            );
          popupContent
            .querySelector(".mark-driveable-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "driveable"),
            );

          layer.bindPopup(popupContent, { closeButton: false, minWidth: 220 });

          layer.on("click", (e) => this.handleStreetClick(e.target)); // Use a dedicated handler
        },
      }).addTo(this.streetLayers);

      this.mapBounds = streetsLayer.getBounds();
      this.streetsGeoJsonLayer = streetsLayer;
    }

    handleStreetClick(clickedLayer) {
      const infoPanel = document.querySelector(".map-info-panel");
      const props = clickedLayer.featureProperties;
      const streetName = props.street_name || "Unnamed Street";
      const streetType = props.highway || "unknown";
      const lengthMiles = (props.segment_length * 0.000621371).toFixed(3);
      const status = props.driven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      // Reset previously highlighted layer
      if (this.highlightedLayer && this.highlightedLayer !== clickedLayer) {
        try {
          this.highlightedLayer.setStyle(this.highlightedLayer.originalStyle);
        } catch (e) {}
      }

      // Toggle highlight
      if (this.highlightedLayer === clickedLayer) {
        clickedLayer.setStyle(clickedLayer.originalStyle);
        this.highlightedLayer = null;
        if (infoPanel) infoPanel.style.display = "none";
      } else {
        const highlightStyle = {
          ...clickedLayer.originalStyle,
          weight: (clickedLayer.originalStyle.weight || 3) + 2,
          opacity: 1,
        };
        clickedLayer.setStyle(highlightStyle);
        clickedLayer.bringToFront();
        this.highlightedLayer = clickedLayer;

        if (infoPanel) {
          infoPanel.innerHTML = `
                  <strong class="d-block mb-1">${streetName}</strong>
                  <div class="d-flex justify-content-between small"><span>Type:</span><span class="text-info">${this.formatStreetType(streetType)}</span></div>
                  <div class="d-flex justify-content-between small"><span>Length:</span><span class="text-info">${lengthMiles} mi</span></div>
                  <div class="d-flex justify-content-between small"><span>Status:</span><span class="${props.driven ? "text-success" : "text-danger"}"><i class="fas fa-${props.driven ? "check-circle" : "times-circle"} me-1"></i>${status}</span></div>
                  ${props.undriveable ? `<div class="d-flex justify-content-between small"><span>Special:</span><span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span></div>` : ""}
                  <div class="d-flex justify-content-between small"><span>ID:</span><span class="text-muted">${segmentId}</span></div>
                  <div class="mt-2 d-flex gap-1 flex-wrap"> <!-- Reduced gap -->
                    ${props.driven ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn-panel">Undriven</button>` : `<button class="btn btn-sm btn-outline-success mark-driven-btn-panel">Driven</button>`}
                    ${props.undriveable ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn-panel">Driveable</button>` : `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn-panel">Undriveable</button>`}
                  </div>`;
          infoPanel.style.display = "block";

          // Re-attach listeners to panel buttons
          const self = this;
          infoPanel
            .querySelector(".mark-driven-btn-panel")
            ?.addEventListener("click", () =>
              self.markStreetSegment(clickedLayer, "driven"),
            );
          infoPanel
            .querySelector(".mark-undriven-btn-panel")
            ?.addEventListener("click", () =>
              self.markStreetSegment(clickedLayer, "undriven"),
            );
          infoPanel
            .querySelector(".mark-undriveable-btn-panel")
            ?.addEventListener("click", () =>
              self.markStreetSegment(clickedLayer, "undriveable"),
            );
          infoPanel
            .querySelector(".mark-driveable-btn-panel")
            ?.addEventListener("click", () =>
              self.markStreetSegment(clickedLayer, "driveable"),
            );
        }
      }
    }

    addMapHoverEffects() {
      // Hover effects can be complex with many features. Consider simplifying or skipping if performance is an issue.
      // Basic idea:
      // this.streetLayers.eachLayer(layer => {
      //     layer.on('mouseover', (e) => { if (e.target !== this.highlightedLayer) e.target.setStyle({ weight: e.target.originalStyle.weight + 1 }); });
      //     layer.on('mouseout', (e) => { if (e.target !== this.highlightedLayer) e.target.setStyle(e.target.originalStyle); });
      // });
    }

    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;
      if (this.coverageSummaryControl)
        this.coverageMap.removeControl(this.coverageSummaryControl);

      const CoverageSummaryControl = L.Control.extend({
        options: { position: "topright" },
        onAdd: () => {
          const container = L.DomUtil.create(
            "div",
            "coverage-summary-control leaflet-bar",
          );
          const coveragePercentage =
            coverage.coverage_percentage?.toFixed(1) || "0.0";
          const totalDist = this.distanceInUserUnits(
            coverage.driveable_length_m || 0,
          ); // Use driveable length
          // If driven_length_m is 0 or undefined, use covered_length_m instead
          const drivenDist = this.distanceInUserUnits(
            coverage.driven_length_m || coverage.covered_length_m || 0,
          );
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
              <div class="summary-details"><div>${drivenDist} / ${totalDist}</div></div>
            </div>`;
          return container;
        },
      });

      this.coverageSummaryControl = new CoverageSummaryControl().addTo(
        this.coverageMap,
      );
      // CSS for summary control added via initial style block
    }

    async markStreetSegment(layer, action) {
      const props = layer.featureProperties;
      if (
        !props ||
        !props.segment_id ||
        !this.selectedLocation ||
        !this.selectedLocation._id
      ) {
        window.notificationManager.show(
          "Cannot mark segment: Missing ID or location context.",
          "danger",
        );
        return;
      }

      const locationId = this.selectedLocation._id;
      const segmentId = props.segment_id;
      const endpoints = {
        driven: "/api/street_segments/mark_driven",
        undriven: "/api/street_segments/mark_undriven",
        undriveable: "/api/street_segments/mark_undriveable",
        driveable: "/api/street_segments/mark_driveable",
      };
      if (!endpoints[action]) {
        window.notificationManager.show("Invalid mark action.", "danger");
        return;
      }

      const streetName = props.street_name || "Unnamed Street";
      try {
        window.notificationManager.show(
          `Marking ${streetName} as ${action}...`,
          "info",
        );

        const response = await fetch(endpoints[action], {
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
            errorData.detail || `Failed request (HTTP ${response.status})`,
          );
        }
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");

        // Update layer properties locally
        if (action === "driven") {
          props.driven = true;
          props.undriveable = false;
        } else if (action === "undriven") props.driven = false;
        else if (action === "undriveable") {
          props.undriveable = true;
          props.driven = false;
        } else if (action === "driveable") props.undriveable = false;

        // Update style and popup/panel
        const newStyle = this.styleStreet({ properties: props });
        layer.setStyle(newStyle);
        layer.originalStyle = { ...newStyle };

        if (layer.getPopup()?.isOpen()) this.coverageMap.closePopup();
        if (this.highlightedLayer === layer) this.handleStreetClick(layer); // Re-render panel

        window.notificationManager.show(
          `Marked ${streetName} as ${action}.`,
          "success",
        );

        await this.refreshCoverageStats(); // Refresh stats after successful mark
      } catch (error) {
        console.error(`Error marking segment as ${action}:`, error);
        window.notificationManager.show(
          `Failed to mark as ${action}: ${error.message}`,
          "danger",
        );
      }
    }

    async refreshCoverageStats() {
      if (!this.selectedLocation || !this.selectedLocation._id) return;
      try {
        const locationId = this.selectedLocation._id;
        const response = await fetch(
          `/api/coverage_areas/${locationId}/refresh_stats`,
          { method: "POST" },
        );
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.detail ||
              `Failed to refresh stats (HTTP ${response.status})`,
          );
        }
        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");

        // Update the stored selectedLocation data
        this.selectedLocation = data.coverage;
        // Update UI elements
        this.updateDashboardStats(data.coverage);
        this.addCoverageSummary(data.coverage);
        // Optionally update chart if it exists
        if (this.streetTypeChartInstance) {
          this.createStreetTypeChart(data.coverage.street_types);
        }

        window.notificationManager.show(
          "Coverage statistics refreshed.",
          "info",
        );
      } catch (error) {
        console.error("Error refreshing coverage stats:", error);
        window.notificationManager.show(
          `Error refreshing stats: ${error.message}`,
          "warning",
        );
        // Re-throw if needed by caller, but usually just log and inform user
        // throw error;
      }
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds?.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, { padding: [30, 30] });
      } else if (this.coverageMap) {
        this.coverageMap.setView([40, -95], 4); // Default US view
        console.warn("Map bounds invalid, setting default view.");
      }
    }

    // --- THIS IS THE CORRECTED createStreetTypeChart ---
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
    // --- END OF CORRECTED createStreetTypeChart ---

    formatStreetType(type) {
      if (!type) return "Unknown";
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }

    exportCoverageMap() {
      if (!this.coverageMap || typeof leafletImage === "undefined") {
        window.notificationManager.show(
          "Map export requires leaflet-image library.",
          "warning",
        );
        return;
      }
      if (
        !this.selectedLocation ||
        !this.selectedLocation.location?.display_name
      ) {
        // Check nested location name
        window.notificationManager.show(
          "Cannot export map: Location name missing.",
          "warning",
        );
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const locationName = this.selectedLocation.location.display_name
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const filename = `coverage_map_${locationName}_${timestamp}.png`;

      window.notificationManager.show("Generating map image...", "info");
      this.setMapFilter(this.currentFilter || "all"); // Ensure correct layers are visible

      this.coverageMap.invalidateSize();
      setTimeout(() => {
        leafletImage(
          this.coverageMap,
          (err, canvas) => {
            if (err) {
              console.error("Error generating map image:", err);
              window.notificationManager.show(
                `Map export failed: ${err.message || err}`,
                "danger",
              );
              return;
            }
            try {
              const link = document.createElement("a");
              link.download = filename;
              link.href = canvas.toDataURL("image/png");
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              window.notificationManager.show(
                "Map download started.",
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
          { preferCanvas: true },
        ); // Prefer canvas for reliability
      }, 1000); // Increased delay
    }

    setMapFilter(filterType) {
      if (!this.coverageMap || !this.streetsGeoJson || !this.streetLayers)
        return;

      this.currentFilter = filterType;
      this.streetLayers.clearLayers(); // Clear previous layers

      // Update button states
      document.querySelectorAll(".map-controls .btn").forEach((btn) => {
        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
        );
        btn.classList.add("btn-outline-secondary");
      });
      const activeBtn = document.getElementById(
        {
          all: "show-all-streets",
          driven: "show-driven-streets",
          undriven: "show-undriven-streets",
        }[filterType],
      );

      if (activeBtn) {
        activeBtn.classList.add("active");
        activeBtn.classList.remove("btn-outline-secondary");
        if (filterType === "driven") activeBtn.classList.add("btn-success");
        else if (filterType === "undriven")
          activeBtn.classList.add("btn-danger");
        else activeBtn.classList.add("btn-primary");
      }

      const filterFunc = (feature) => {
        if (filterType === "driven")
          return (
            feature.properties.driven === true &&
            !feature.properties.undriveable
          ); // Only driven & driveable
        if (filterType === "undriven")
          return (
            feature.properties.driven === false &&
            !feature.properties.undriveable
          ); // Only undriven & driveable
        return true; // 'all' shows everything including undriveable
      };

      // Create and add the new filtered layer
      const filteredLayer = L.geoJSON(this.streetsGeoJson, {
        style: (feature) => this.styleStreet(feature),
        filter: filterFunc,
        onEachFeature: (feature, layer) => {
          // Re-bind popups and properties for the filtered layer
          layer.featureProperties = feature.properties; // Store properties
          const props = feature.properties;
          const streetName = props.street_name || "Unnamed Street";
          const streetType = props.highway || "unknown";
          const lengthMiles = (props.segment_length * 0.000621371).toFixed(3);
          const status = props.driven ? "Driven" : "Not Driven";
          const segmentId = props.segment_id || "N/A";

          const popupContent = document.createElement("div");
          popupContent.className = "street-popup";
          popupContent.innerHTML = `
                    <h6>${streetName}</h6><hr class="my-1">
                    <small>
                      <strong>Type:</strong> ${this.formatStreetType(streetType)}<br>
                      <strong>Length:</strong> ${lengthMiles} mi<br>
                      <strong>Status:</strong> <span class="${props.driven ? "text-success" : "text-danger"}">${status}</span><br>
                      ${props.undriveable ? '<strong>Marked as:</strong> <span class="text-warning">Undriveable</span><br>' : ""}
                      <strong>ID:</strong> ${segmentId}
                    </small>
                    <div class="street-actions mt-2 d-flex gap-1 flex-wrap"> <!-- Reduced gap -->
                      ${props.driven ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn">Undriven</button>` : `<button class="btn btn-sm btn-outline-success mark-driven-btn">Driven</button>`}
                      ${props.undriveable ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn">Driveable</button>` : `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn">Undriveable</button>`}
                    </div>`;

          const self = this;
          popupContent
            .querySelector(".mark-driven-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "driven"),
            );
          popupContent
            .querySelector(".mark-undriven-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "undriven"),
            );
          popupContent
            .querySelector(".mark-undriveable-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "undriveable"),
            );
          popupContent
            .querySelector(".mark-driveable-btn")
            ?.addEventListener("click", () =>
              self.markStreetSegment(layer, "driveable"),
            );

          layer.bindPopup(popupContent, { closeButton: false, minWidth: 220 });
          layer.on("click", (e) => this.handleStreetClick(e.target));
        },
      }).addTo(this.streetLayers);

      this.streetsGeoJsonLayer = filteredLayer; // Update reference
      this.addMapHoverEffects(); // Re-apply hover effects
    }

    // toggleFilterButtonState method is now integrated into setMapFilter

    // Add distanceInUserUnits as a class method so it's available everywhere
    distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number") return "N/A"; // Handle non-numeric input
      if (this.useMiles) {
        return (meters * 0.000621371).toFixed(fixed) + " mi";
      } else {
        return (meters / 1000).toFixed(fixed) + " km";
      }
    }
  } // End of CoverageManager class

  // Initialize on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      console.error(
        "Leaflet or Chart.js not loaded. Coverage Manager initialization aborted.",
      );
      const errorDiv = document.getElementById("coverage-manager-error");
      if (errorDiv)
        errorDiv.innerHTML =
          '<div class="alert alert-danger">Required libraries failed to load. Map/chart functionality unavailable.</div>';
      return;
    }
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized.");
  });
})(); // IIFE
