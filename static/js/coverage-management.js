/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */

"use strict";

const STATUS = window.STATUS || {
  INITIALIZING: "initializing",
  PREPROCESSING: "preprocessing",
  LOADING_STREETS: "loading_streets",
  INDEXING: "indexing",
  COUNTING_TRIPS: "counting_trips",
  PROCESSING_TRIPS: "processing_trips",
  CALCULATING: "calculating",
  FINALIZING: "finalizing",
  GENERATING_GEOJSON: "generating_geojson",
  COMPLETE_STATS: "complete_stats",
  COMPLETE: "complete",
  COMPLETED: "completed",
  ERROR: "error",
  WARNING: "warning",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
  POLLING_CHECK: "polling_check",
};

(() => {
  const style = document.createElement("style");
  style.id = "coverage-manager-dynamic-styles";
  style.textContent = `
    .activity-indicator.pulsing { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    .detailed-stage-info { font-style: italic; color: #adb5bd; font-size: 0.9em; margin-top: 5px; }
    .stats-info { font-size: 0.9em; }
    .stats-info small { color: #ced4da; }
    .stats-info .text-info { color: #3db9d5 !important; }
    .stats-info .text-success { color: #4caf50 !important; }
    .stats-info .text-primary { color: #59a6ff !important; }

    .leaflet-popup-content-wrapper { background-color: rgba(51, 51, 51, 0.95); color: #eee; box-shadow: 0 3px 14px rgba(0, 0, 0, 0.5); border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.2); }
    .leaflet-popup-tip { background: rgba(51, 51, 51, 0.95); box-shadow: none; }
    .leaflet-popup-content { margin: 10px 15px; line-height: 1.5; }
    .leaflet-popup-content h6 { margin-bottom: 8px; color: #59a6ff; font-size: 1.1em; }
    .leaflet-popup-content hr { border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 8px 0; }
    .leaflet-popup-content small { font-size: 0.9em; color: #ced4da; }
    .leaflet-popup-content .street-actions button { font-size: 0.75rem; padding: 0.2rem 0.5rem; }
    .leaflet-popup-content .text-success { color: #4caf50 !important; }
    .leaflet-popup-content .text-danger { color: #ff5252 !important; }
    .leaflet-popup-content .text-warning { color: #ffc107 !important; }
    .leaflet-popup-content .text-info { color: #17a2b8 !important; }

    .map-info-panel { position: absolute; top: 10px; left: 10px; z-index: 1000; background: rgba(40, 40, 40, 0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); max-width: 250px; border-left: 3px solid #007bff; display: none; }
    .map-info-panel strong { color: #fff; }
    .map-info-panel .text-success { color: #4caf50 !important; }
    .map-info-panel .text-danger { color: #ff5252 !important; }
    .map-info-panel .text-info { color: #17a2b8 !important; }
    .map-info-panel .text-warning { color: #ffc107 !important; }
    .map-info-panel .text-muted { color: #adb5bd !important; }
    .map-info-panel hr.panel-divider { border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 5px 0; }

    .coverage-summary-control { background: rgba(40, 40, 40, 0.9); color: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1) !important; min-width: 150px; }
    .summary-title { font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #ccc; text-transform: uppercase; letter-spacing: 0.5px;}
    .summary-percentage { font-size: 24px; font-weight: bold; margin-bottom: 5px; color: #fff; }
    .summary-progress { margin-bottom: 8px; }
    .summary-details { font-size: 11px; color: #ccc; text-align: right; }

    .street-highlighted {  }
  `;
  if (!document.getElementById(style.id)) {
    document.head.appendChild(style);
  }
})();

(() => {
  class CoverageManager {
    constructor() {
      this.map = null;
      this.coverageMap = null;
      this.streetLayers = null;
      this.tripsLayerGroup = null;
      this.streetsGeoJson = null;
      this.streetsGeoJsonLayer = null;
      this.mapBounds = null;
      this.highlightedLayer = null;
      this.hoverHighlightLayer = null;

      this.selectedLocation = null;
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.activeTaskIds = new Set();
      this.validatedLocation = null;
      this.currentFilter = "all";
      this.lastActivityTime = null;
      this.showTripsActive = false;
      this.loadTripsDebounceTimer = null;

      this.tooltips = [];
      this.mapInfoPanel = null;
      this.coverageSummaryControl = null;
      this.streetTypeChartInstance = null;

      this.notificationManager = window.notificationManager || {
        show: (message, type = "info") =>
          console.log(`[${type.toUpperCase()}] ${message}`),
      };
      this.confirmationDialog = window.confirmationDialog || {
        show: async (options) => confirm(options.message || "Are you sure?"),
      };

      this.setupAutoRefresh();
      this.checkForInterruptedTasks();
      this.setupConnectionMonitoring();
      this.initTooltips();
      this.createMapInfoPanel();
      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      return (meters * 0.000621371).toFixed(fixed) + " mi";
    }

    setupConnectionMonitoring() {
      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        const alertsContainer = document.querySelector("#alerts-container");
        if (!alertsContainer) return;

        alertsContainer
          .querySelectorAll(".connection-status")
          .forEach((el) => el.remove());

        const statusBar = document.createElement("div");
        statusBar.className = `connection-status alert alert-dismissible fade show ${
          isOnline ? "alert-success" : "alert-danger"
        }`;
        statusBar.innerHTML = `
          <i class="fas ${isOnline ? "fa-wifi" : "fa-exclamation-triangle"} me-2"></i>
          <strong>${isOnline ? "Connected" : "Offline"}</strong> ${
            isOnline ? "" : "- Changes cannot be saved while offline."
          }
          <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);

        if (isOnline) {
          setTimeout(() => {
            const bsAlert = bootstrap.Alert.getOrCreateInstance(statusBar);
            if (bsAlert) {
              bsAlert.close();
            } else {
              statusBar.remove();
            }
          }, 5000);
        }
      };

      window.addEventListener("online", handleConnectionChange);
      window.addEventListener("offline", handleConnectionChange);
      handleConnectionChange();
    }

    initTooltips() {
      this.tooltips.forEach((tooltip) => {
        if (tooltip && typeof tooltip.dispose === "function") {
          tooltip.dispose();
        }
      });
      this.tooltips = [];

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

    setupAutoRefresh() {
      setInterval(async () => {
        const isProcessingRow = document.querySelector(".processing-row");
        const isModalProcessing =
          this.currentProcessingLocation &&
          document
            .getElementById("taskProgressModal")
            ?.classList.contains("show");

        if (isProcessingRow || isModalProcessing) {
          await this.loadCoverageAreas();
        }
      }, 10000);
    }

    setupEventListeners() {
      document
        .getElementById("validate-location")
        ?.addEventListener("click", () => this.validateLocation());

      document
        .getElementById("add-coverage-area")
        ?.addEventListener("click", () => this.addCoverageArea());

      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;
          const locationInput = document.getElementById("location-input");
          locationInput?.classList.remove("is-invalid", "is-valid");
        });

      document
        .getElementById("cancel-processing")
        ?.addEventListener("click", () =>
          this.cancelProcessing(this.currentProcessingLocation),
        );

      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          if (
            this.currentProcessingLocation &&
            this.currentProcessingLocation.status !== STATUS.CANCELED &&
            this.currentProcessingLocation.status !== STATUS.ERROR
          ) {
            this.loadCoverageAreas();
          }
          this.clearProcessingContext();
        });

      window.addEventListener("beforeunload", () => {
        if (this.currentProcessingLocation) {
          this.saveProcessingState();
        }
      });

      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const targetButton = e.target.closest("button[data-action]");
          const targetLink = e.target.closest("a.location-name-link");

          if (targetButton) {
            e.preventDefault();
            const action = targetButton.dataset.action;
            const locationId = targetButton.dataset.locationId;
            const locationStr = targetButton.dataset.location;

            if (!locationId && !locationStr) {
              console.error("Action button missing location identifier.");
              this.notificationManager.show(
                "Action failed: Missing location identifier.",
                "danger",
              );
              return;
            }

            let locationData = null;
            if (locationStr) {
              try {
                locationData = JSON.parse(locationStr);
              } catch (parseError) {
                console.error(
                  "Failed to parse location data from button:",
                  parseError,
                );
                this.notificationManager.show(
                  "Action failed: Invalid location data.",
                  "danger",
                );
                return;
              }
            }

            switch (action) {
              case "update-full":
                if (locationId) this.updateCoverageForArea(locationId, "full");
                break;
              case "update-incremental":
                if (locationId)
                  this.updateCoverageForArea(locationId, "incremental");
                break;
              case "delete":
                if (locationData) this.deleteArea(locationData);
                break;
              case "cancel":
                if (locationData) this.cancelProcessing(locationData);
                break;
              default:
                console.warn("Unknown table action:", action);
            }
          } else if (targetLink) {
            e.preventDefault();
            const locationId = targetLink.dataset.locationId;
            if (locationId) {
              this.displayCoverageDashboard(locationId);
            } else {
              console.error("Location ID missing from link:", targetLink);
            }
          }
        });

      document.addEventListener("click", (e) => {
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          const locationId = updateMissingDataBtn.dataset.locationId;
          if (locationId) {
            this.updateCoverageForArea(locationId, "full");
          } else {
            console.error("Missing location ID on update button.");
            this.notificationManager.show(
              "Failed to initiate update: Missing location ID.",
              "danger",
            );
          }
        }

        const filterButton = e.target.closest(
          ".map-controls button[data-filter]",
        );
        if (filterButton) {
          this.setMapFilter(filterButton.dataset.filter);
        }

        const exportButton = e.target.closest("#export-coverage-map");
        if (exportButton) {
          this.exportCoverageMap();
        }

        const tripToggle = e.target.closest("#toggle-trip-overlay");
        if (tripToggle) {
          this.showTripsActive = tripToggle.checked;
          console.log("Trip overlay toggle changed:", this.showTripsActive);
          if (this.showTripsActive) {
            this.ensureTripsLayerGroup();
            this.loadTripsForView();
          } else {
            this.clearTripOverlay();
          }
        }
      });
    }

    checkForInterruptedTasks() {
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          if (now - savedTime < 60 * 60 * 1000) {
            const location = progressData.location;
            const taskId = progressData.taskId;

            if (!location || !location.display_name || !taskId) {
              console.warn(
                "Incomplete saved progress data found.",
                progressData,
              );
              localStorage.removeItem("coverageProcessingState");
              return;
            }

            const notification = document.createElement("div");
            notification.className =
              "alert alert-info alert-dismissible fade show mt-3";
            notification.innerHTML = `
              <h5><i class="fas fa-info-circle me-2"></i>Interrupted Task Found</h5>
              <p>A processing task for <strong>${
                location.display_name
              }</strong> (Task ID: ${taskId.substring(0, 8)}...) was interrupted.</p>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-primary resume-task">Check Status / Resume</button>
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

            document.querySelector("#alerts-container")?.prepend(notification);
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
      const location = savedData.location;
      const taskId = savedData.taskId;

      if (!location || !location.display_name || !taskId) {
        this.notificationManager.show(
          "Cannot resume task: Incomplete data.",
          "warning",
        );
        localStorage.removeItem("coverageProcessingState");
        return;
      }

      this.currentProcessingLocation = location;
      this.task_id = taskId;
      this.showProgressModal(
        `Checking status for ${location.display_name}...`,
        savedData.progress || 0,
      );
      this.activeTaskIds.add(taskId);

      this.pollCoverageProgress(taskId)
        .then(async (finalData) => {
          if (finalData?.stage !== STATUS.ERROR) {
            this.notificationManager.show(
              `Task for ${location.display_name} completed.`,
              "success",
            );
          }
          await this.loadCoverageAreas();
          if (this.selectedLocation?._id === location._id) {
            await this.displayCoverageDashboard(this.selectedLocation._id);
          }
        })
        .catch(async (pollError) => {
          this.notificationManager.show(
            `Failed to resume task for ${location.display_name}: ${pollError.message || pollError}`,
            "danger",
          );
          await this.loadCoverageAreas();
        })
        .finally(() => {
          this.activeTaskIds.delete(taskId);
        });
    }

    saveProcessingState() {
      if (this.currentProcessingLocation && this.task_id) {
        const progressBar = document.querySelector(
          "#taskProgressModal .progress-bar",
        );
        const progressMessageEl = document.querySelector(
          "#taskProgressModal .progress-message",
        );
        const saveData = {
          location: this.currentProcessingLocation,
          taskId: this.task_id,
          stage: progressMessageEl?.dataset.stage || STATUS.UNKNOWN,
          progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0"),
          timestamp: new Date().toISOString(),
        };
        localStorage.setItem(
          "coverageProcessingState",
          JSON.stringify(saveData),
        );
        console.log("Saved processing state:", saveData);
      } else {
        localStorage.removeItem("coverageProcessingState");
      }
    }

    clearProcessingContext() {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      localStorage.removeItem("coverageProcessingState");
      window.removeEventListener("beforeunload", this.saveProcessingState);

      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.task_id = null;
      this.lastActivityTime = null;
      console.log("Processing context cleared.");
    }

    async validateLocation() {
      const locationInputEl = document.getElementById("location-input");
      const locationTypeEl = document.getElementById("location-type");
      const validateButton = document.getElementById("validate-location");
      const addButton = document.getElementById("add-coverage-area");

      if (
        !locationInputEl ||
        !locationTypeEl ||
        !validateButton ||
        !addButton
      ) {
        console.error("Validation form elements not found.");
        return;
      }

      const locationInput = locationInputEl.value.trim();
      const locType = locationTypeEl.value;

      locationInputEl.classList.remove("is-invalid", "is-valid");
      addButton.disabled = true;
      this.validatedLocation = null;

      if (!locationInput) {
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show("Please enter a location.", "warning");
        return;
      }
      if (!locType) {
        this.notificationManager.show(
          "Please select a location type.",
          "warning",
        );
        return;
      }

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

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Validation request failed (HTTP ${response.status})`,
          );
        }

        if (!data || !data.osm_id || !data.display_name) {
          locationInputEl.classList.add("is-invalid");
          this.notificationManager.show(
            "Location not found or invalid response. Check input.",
            "warning",
          );
        } else {
          locationInputEl.classList.add("is-valid");
          this.validatedLocation = data;
          addButton.disabled = false;
          this.notificationManager.show(
            `Location validated: ${data.display_name}`,
            "success",
          );
        }
      } catch (error) {
        console.error("Error validating location:", error);
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show(
          `Validation failed: ${error.message}.`,
          "danger",
        );
      } finally {
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonText;
      }
    }

    async addCoverageArea() {
      if (!this.validatedLocation || !this.validatedLocation.display_name) {
        this.notificationManager.show(
          "Please validate a location first.",
          "warning",
        );
        return;
      }

      const addButton = document.getElementById("add-coverage-area");
      if (!addButton) return;

      const originalButtonText = addButton.innerHTML;
      addButton.disabled = true;
      addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

      const locationToAdd = { ...this.validatedLocation };

      try {
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok)
          throw new Error("Failed to fetch current coverage areas");
        const { areas } = await currentAreasResponse.json();
        const exists = areas.some(
          (area) => area.location?.display_name === locationToAdd.display_name,
        );

        if (exists) {
          this.notificationManager.show(
            "This area is already tracked.",
            "warning",
          );
          addButton.innerHTML = originalButtonText;
          return;
        }

        this.currentProcessingLocation = locationToAdd;
        this.task_id = null;
        this.showProgressModal(
          `Starting processing for ${locationToAdd.display_name}...`,
          0,
        );
        window.addEventListener("beforeunload", this.saveProcessingState);

        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToAdd),
        });

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal();
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`,
          );
        }

        this.notificationManager.show(
          "Coverage area processing started.",
          "info",
        );

        if (taskData?.task_id) {
          this.task_id = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState();
          await this.pollCoverageProgress(taskData.task_id);
          this.notificationManager.show(
            `Processing for ${locationToAdd.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas();
        } else {
          this.hideProgressModal();
          this.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid", "is-invalid");
        }
        this.validatedLocation = null;
      } catch (error) {
        console.error("Error adding coverage area:", error);
        this.notificationManager.show(
          `Failed to add coverage area: ${error.message}`,
          "danger",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } finally {
        addButton.disabled = true;
        addButton.innerHTML = originalButtonText;
      }
    }

    async updateCoverageForArea(locationId, mode = "full") {
      if (!locationId) {
        this.notificationManager.show(
          "Invalid location ID provided for update.",
          "warning",
        );
        return;
      }

      let locationData;
      try {
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();
        if (!data.success || !data.coverage || !data.coverage.location) {
          throw new Error(
            data.error || "Failed to fetch location details for update.",
          );
        }
        locationData = data.coverage.location;
        if (!locationData.display_name)
          throw new Error("Location details missing display name.");
      } catch (fetchError) {
        this.notificationManager.show(
          `Failed to start update: ${fetchError.message}`,
          "danger",
        );
        return;
      }

      if (
        this.currentProcessingLocation?.display_name ===
        locationData.display_name
      ) {
        this.notificationManager.show(
          `Update already in progress for ${locationData.display_name}.`,
          "info",
        );
        this.showProgressModal(
          `Update already running for ${locationData.display_name}...`,
        );
        return;
      }

      const processingLocation = { ...locationData };

      try {
        this.currentProcessingLocation = processingLocation;
        this.task_id = null;
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id === locationId;
        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${processingLocation.display_name}...`,
        );
        window.addEventListener("beforeunload", this.saveProcessingState);

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";

        const payload = { ...processingLocation };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          if (response.status === 422 && data.detail) {
            const errorMsg = Array.isArray(data.detail)
              ? data.detail
                  .map((err) => `${err.loc?.join(".")}: ${err.msg}`)
                  .join("; ")
              : data.detail;
            throw new Error(`Validation error: ${errorMsg}`);
          }
          throw new Error(
            data.detail || `Failed to start update (HTTP ${response.status})`,
          );
        }

        if (data.task_id) {
          this.task_id = data.task_id;
          this.activeTaskIds.add(data.task_id);
          this.saveProcessingState();
          await this.pollCoverageProgress(data.task_id);
          this.notificationManager.show(
            `Coverage update for ${processingLocation.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas();
          if (isUpdatingDisplayedLocation) {
            await this.displayCoverageDashboard(locationId);
          }
        } else {
          this.hideProgressModal();
          this.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas();
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        this.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      }
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;

      if (!locationToCancel || !locationToCancel.display_name) {
        this.notificationManager.show(
          "No active processing context found to cancel.",
          "warning",
        );
        return;
      }

      const confirmed = await this.confirmationDialog.show({
        title: "Cancel Processing",
        message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>? This cannot be undone.`,
        confirmText: "Yes, Cancel",
        cancelText: "No, Continue",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      this.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info",
      );

      try {
        const payload = { display_name: locationToCancel.display_name };
        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Failed to send cancel request (HTTP ${response.status})`,
          );
        }

        this.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success",
        );
        this.hideProgressModal();
        await this.loadCoverageAreas();
      } catch (error) {
        console.error("Error cancelling processing:", error);
        this.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
      } finally {
        if (
          this.currentProcessingLocation?.display_name ===
          locationToCancel.display_name
        ) {
        }
      }
    }

    async deleteArea(location) {
      if (!location || !location.display_name) {
        this.notificationManager.show(
          "Invalid location data for deletion.",
          "warning",
        );
        return;
      }

      const confirmed = await this.confirmationDialog.show({
        title: "Delete Coverage Area",
        message: `Are you sure you want to delete <strong>${location.display_name}</strong>?<br><br>This will permanently delete all associated street data, statistics, and history. This action cannot be undone.`,
        confirmText: "Delete Permanently",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        this.notificationManager.show(
          `Deleting coverage area: ${location.display_name}...`,
          "info",
        );

        const payload = { display_name: location.display_name };
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`,
          );
        }

        await this.loadCoverageAreas();

        if (
          this.selectedLocation?.location?.display_name ===
          location.display_name
        ) {
          const dashboard = document.getElementById("coverage-dashboard");
          if (dashboard) dashboard.style.display = "none";
          this.selectedLocation = null;
          if (this.coverageMap) {
            this.coverageMap.remove();
            this.coverageMap = null;
          }
          this.clearDashboardUI();
        }

        this.notificationManager.show(
          `Coverage area '${location.display_name}' deleted.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        let detailMessage = error.message;

        let errorResponse = error.cause || error;

        try {
          if (errorResponse && typeof errorResponse.json === "function") {
            const errorData = await errorResponse.json();
            if (errorData && errorData.detail) {
              if (Array.isArray(errorData.detail)) {
                detailMessage = errorData.detail
                  .map((err) => `${err.loc?.join(".") || "field"}: ${err.msg}`)
                  .join("; ");
              } else {
                detailMessage = errorData.detail;
              }
            }
          } else if (error.message.includes("Failed to fetch")) {
            detailMessage = "Network error or failed to connect to the server.";
          } else {
            detailMessage = error.message || "An unknown error occurred.";
          }
        } catch (parseError) {
          console.warn(
            "Could not parse error response body or unexpected error structure:",
            parseError,
            error,
          );
          detailMessage =
            error.message || "Failed to process the error response.";
        }

        this.notificationManager.show(
          `Error deleting coverage area '${location.display_name}': ${detailMessage}`,
          "danger",
        );
      }
    }

    async loadCoverageAreas() {
      try {
        const response = await fetch("/api/coverage_areas");
        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            errorDetail = (await response.json()).detail || errorDetail;
          } catch (e) {}
          throw new Error(`Failed to fetch coverage areas (${errorDetail})`);
        }

        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");

        CoverageManager.updateCoverageTable(data.areas, this);
        this.enhanceResponsiveTables();
        this.initTooltips();
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        this.notificationManager.show(
          `Failed to load coverage areas: ${error.message}.`,
          "danger",
        );
        const tableBody = document.querySelector("#coverage-areas-table tbody");
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error loading data: ${error.message}</td></tr>`;
        }
      }
    }

    async pollCoverageProgress(taskId) {
      const maxRetries = 360;
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;

      console.log(`Starting polling for task ${taskId}`);

      while (retries < maxRetries) {
        if (!this.activeTaskIds.has(taskId)) {
          console.log(
            `Polling stopped for task ${taskId} as it's no longer active.`,
          );
          throw new Error("Polling canceled");
        }

        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);

          if (response.status === 404) {
            throw new Error("Task not found (expired or invalid).");
          }
          if (!response.ok) {
            let errorDetail = `HTTP error ${response.status}`;
            try {
              errorDetail = (await response.json()).detail || errorDetail;
            } catch (e) {}
            throw new Error(`Failed to get task status: ${errorDetail}`);
          }

          let data;
          try {
            data = await response.json();
            if (!data || typeof data !== "object" || !data.stage) {
              if (response.ok) {
                console.warn(
                  `Task ${taskId}: Received incomplete/invalid data structure despite HTTP OK status.`,
                );
              }
              throw new Error("Invalid data format received from server.");
            }
          } catch (jsonError) {
            throw new Error(
              `Error processing server response: ${jsonError.message}`,
            );
          }

          this.updateModalContent(data);
          this.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date();
          this.saveProcessingState();

          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            console.log(`Task ${taskId} completed successfully.`);
            this.updateModalContent({ ...data, progress: 100 });
            this.updateStepIndicators(STATUS.COMPLETE, 100);
            this.activeTaskIds.delete(taskId);
            return data;
          } else if (data.stage === STATUS.ERROR) {
            console.error(
              `Task ${taskId} failed with error: ${data.error || data.message || "Unknown error"}`,
            );
            this.activeTaskIds.delete(taskId);
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            );
          } else if (data.stage === STATUS.CANCELED) {
            console.log(`Task ${taskId} was canceled.`);
            this.activeTaskIds.delete(taskId);
            throw new Error("Task was canceled");
          }

          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              console.warn(
                `Task ${taskId} seems stalled at stage: ${data.stage}`,
              );
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
          retries++;
        } catch (error) {
          console.error(
            `Error polling coverage progress for task ${taskId}:`,
            error,
          );
          this.updateModalContent({
            stage: STATUS.ERROR,
            progress: this.currentProcessingLocation?.progress || 0,
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {},
          });
          this.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId);
          throw error;
        }
      }

      this.updateModalContent({
        stage: STATUS.ERROR,
        progress: this.currentProcessingLocation?.progress || 99,
        message: "Polling timed out waiting for completion.",
        error: "Polling timed out",
        metrics: {},
      });
      this.updateStepIndicators(
        STATUS.ERROR,
        this.currentProcessingLocation?.progress || 99,
      );
      this.activeTaskIds.delete(taskId);
      throw new Error("Coverage calculation polling timed out");
    }

    static updateCoverageTable(areas, instance) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = "";

      if (!areas || areas.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="7" class="text-center fst-italic text-muted py-4">No coverage areas defined yet.</td></tr>';
        return;
      }

      areas.sort((a, b) =>
        (a.location?.display_name || "").localeCompare(
          b.location?.display_name || "",
        ),
      );

      areas.forEach((area) => {
        const row = document.createElement("tr");
        const status = area.status || STATUS.UNKNOWN;
        const isProcessing = [
          STATUS.PROCESSING_TRIPS,
          STATUS.PREPROCESSING,
          STATUS.CALCULATING,
          STATUS.INDEXING,
          STATUS.FINALIZING,
          STATUS.GENERATING_GEOJSON,
          STATUS.COMPLETE_STATS,
          STATUS.INITIALIZING,
          STATUS.LOADING_STREETS,
          STATUS.COUNTING_TRIPS,
        ].includes(status);
        const hasError = status === STATUS.ERROR;
        const isCanceled = status === STATUS.CANCELED;

        row.className = isProcessing
          ? "processing-row table-info"
          : hasError
            ? "table-danger"
            : isCanceled
              ? "table-warning"
              : "";

        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        const totalLengthMiles = instance.distanceInUserUnits(
          area.total_length,
        );
        const drivenLengthMiles = instance.distanceInUserUnits(
          area.driven_length,
        );
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0";

        let progressBarColor = "bg-success";
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if (area.coverage_percentage < 25) progressBarColor = "bg-danger";
        else if (area.coverage_percentage < 75) progressBarColor = "bg-warning";

        const escapedLocation = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;");
        const locationId = area._id;

        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${locationId}">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${hasError ? `<div class="text-danger small" title="${area.last_error || ""}"><i class="fas fa-exclamation-circle me-1"></i>Error</div>` : ""}
            ${isCanceled ? `<div class="text-warning small"><i class="fas fa-ban me-1"></i>Canceled</div>` : ""}
            ${isProcessing ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>${this.formatStageName(status)}...</div>` : ""}
          </td>
          <td data-label="Total Length" class="text-end">${totalLengthMiles}</td>
          <td data-label="Driven Length" class="text-end">${drivenLengthMiles}</td>
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
          <td data-label="Segments" class="text-end">${area.total_segments?.toLocaleString() || 0}</td>
          <td data-label="Last Updated">${lastUpdated}</td>
          <td data-label="Actions">
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success" data-action="update-full" data-location-id="${locationId}" title="Full Update (Recalculate All)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-info" data-action="update-incremental" data-location-id="${locationId}" title="Quick Update (New Trips Only)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-location='${escapedLocation}' title="Delete Area" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-trash-alt"></i>
              </button>
              ${isProcessing ? `<button class="btn btn-sm btn-warning" data-action="cancel" data-location='${escapedLocation}' title="Cancel Processing" data-bs-toggle="tooltip"><i class="fas fa-stop-circle"></i></button>` : ""}
            </div>
          </td>
        `;
        tableBody.appendChild(row);
      });
    }

    showProgressModal(message = "Processing...", progress = 0) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const modalTitle = modalElement.querySelector(".modal-title");
      const modalProgressBar = modalElement.querySelector(".progress-bar");
      const progressMessage = modalElement.querySelector(".progress-message");
      const progressDetails = modalElement.querySelector(".progress-details");
      const cancelBtn = document.getElementById("cancel-processing");

      if (!progressDetails) {
        console.error("Progress details container not found in modal.");
        return;
      }

      if (modalTitle)
        modalTitle.textContent = this.currentProcessingLocation?.display_name
          ? `Processing: ${this.currentProcessingLocation.display_name}`
          : "Processing Coverage";
      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        modalProgressBar.className =
          "progress-bar progress-bar-striped progress-bar-animated bg-primary";
      }
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.className = "progress-message";
        progressMessage.removeAttribute("data-stage");
      }
      progressDetails.querySelector(".stage-info").innerHTML = "";
      progressDetails.querySelector(".stats-info").innerHTML = "";
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = "";

      if (cancelBtn) cancelBtn.disabled = false;

      if (this.progressTimer) clearInterval(this.progressTimer);
      this.processingStartTime = Date.now();
      this.lastActivityTime = Date.now();
      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();
        this.updateActivityIndicator();
      }, 1000);
      this.updateTimingInfo();
      this.updateActivityIndicator();

      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static",
        keyboard: false,
      });
      bsModal.show();
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;
      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) {
        modal.hide();
      } else {
        modalElement.style.display = "none";
        modalElement.classList.remove("show");
        document.body.classList.remove("modal-open");
        const backdrop = document.querySelector(".modal-backdrop");
        if (backdrop) backdrop.remove();
        this.clearProcessingContext();
      }
    }

    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement || !this.currentProcessingLocation) return;

      const {
        stage = STATUS.UNKNOWN,
        progress = 0,
        metrics = {},
        message = "Processing...",
        error = null,
      } = data || {};

      const progressBar = modalElement.querySelector(".progress-bar");
      const progressMessageEl = modalElement.querySelector(".progress-message");
      const stageInfoEl = modalElement.querySelector(".stage-info");
      const statsInfoEl = modalElement.querySelector(".stats-info");
      const cancelBtn = document.getElementById("cancel-processing");

      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        progressBar.className = "progress-bar";
        if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
          progressBar.classList.add("bg-success");
        } else if (stage === STATUS.ERROR) {
          progressBar.classList.add("bg-danger");
        } else {
          progressBar.classList.add(
            "progress-bar-striped",
            "progress-bar-animated",
            "bg-primary",
          );
        }
      }

      if (progressMessageEl) {
        progressMessageEl.textContent = error ? `Error: ${error}` : message;
        progressMessageEl.dataset.stage = stage;
        progressMessageEl.className = "progress-message";
        if (stage === STATUS.ERROR)
          progressMessageEl.classList.add("text-danger");
        if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED)
          progressMessageEl.classList.add("text-success");
      }

      if (stageInfoEl) {
        const stageName = CoverageManager.formatStageName(stage);
        const stageIcon = CoverageManager.getStageIcon(stage);
        stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
        stageInfoEl.className = `stage-info mb-2 text-${CoverageManager.getStageTextClass(stage)}`;
      }

      if (statsInfoEl) {
        statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
      }

      if (cancelBtn) {
        cancelBtn.disabled = [
          STATUS.COMPLETE,
          STATUS.COMPLETED,
          STATUS.ERROR,
          STATUS.CANCELED,
        ].includes(stage);
      }

      if (
        [
          STATUS.COMPLETE,
          STATUS.COMPLETED,
          STATUS.ERROR,
          STATUS.CANCELED,
        ].includes(stage)
      ) {
        if (this.progressTimer) {
          clearInterval(this.progressTimer);
          this.progressTimer = null;
          this.updateTimingInfo();
          const estimatedTimeEl = modalElement.querySelector(".estimated-time");
          if (estimatedTimeEl) estimatedTimeEl.textContent = "";
        }
        this.updateActivityIndicator(false);
      }
    }

    updateStepIndicators(stage, progress) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const steps = {
        initializing: modalElement.querySelector(".step-initializing"),
        preprocessing: modalElement.querySelector(".step-preprocessing"),
        indexing: modalElement.querySelector(".step-indexing"),
        calculating: modalElement.querySelector(".step-calculating"),
        complete: modalElement.querySelector(".step-complete"),
      };

      Object.values(steps).forEach((step) => {
        if (step) step.classList.remove("active", "complete", "error");
      });

      const markComplete = (stepKey) => {
        if (steps[stepKey]) steps[stepKey].classList.add("complete");
      };
      const markActive = (stepKey) => {
        if (steps[stepKey]) steps[stepKey].classList.add("active");
      };
      const markError = (stepKey) => {
        if (steps[stepKey]) steps[stepKey].classList.add("error");
      };

      if (stage === STATUS.ERROR) {
        if ([STATUS.INITIALIZING].includes(stage) || progress < 5) {
          markError("initializing");
        } else if (
          [STATUS.PREPROCESSING, STATUS.LOADING_STREETS].includes(stage) ||
          progress < 50
        ) {
          markComplete("initializing");
          markError("preprocessing");
        } else if ([STATUS.INDEXING].includes(stage) || progress < 60) {
          markComplete("initializing");
          markComplete("preprocessing");
          markError("indexing");
        } else if (
          [
            STATUS.PROCESSING_TRIPS,
            STATUS.CALCULATING,
            STATUS.COUNTING_TRIPS,
          ].includes(stage) ||
          progress < 90
        ) {
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markError("calculating");
        } else {
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markComplete("calculating");
          markError("complete");
        }
      } else if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
        Object.keys(steps).forEach(markComplete);
      } else {
        if ([STATUS.INITIALIZING].includes(stage)) {
          markActive("initializing");
        } else if (
          [STATUS.PREPROCESSING, STATUS.LOADING_STREETS].includes(stage)
        ) {
          markComplete("initializing");
          markActive("preprocessing");
        } else if ([STATUS.INDEXING].includes(stage)) {
          markComplete("initializing");
          markComplete("preprocessing");
          markActive("indexing");
        } else if (
          [
            STATUS.PROCESSING_TRIPS,
            STATUS.CALCULATING,
            STATUS.COUNTING_TRIPS,
          ].includes(stage)
        ) {
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markActive("calculating");
        } else if (
          [
            STATUS.FINALIZING,
            STATUS.GENERATING_GEOJSON,
            STATUS.COMPLETE_STATS,
          ].includes(stage)
        ) {
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markComplete("calculating");
          markActive("complete");
        } else {
          markActive("initializing");
        }
      }
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
      const estimatedTimeEl = document.querySelector(
        "#taskProgressModal .estimated-time",
      );

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      if (estimatedTimeEl) estimatedTimeEl.textContent = "";
    }

    updateActivityIndicator(isActive = null) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const activityIndicator = modalElement.querySelector(
        ".activity-indicator",
      );
      const lastUpdateEl = modalElement.querySelector(".last-update-time");

      if (!activityIndicator || !lastUpdateEl) return;

      const now = new Date();
      let currentlyActive;

      if (isActive !== null) {
        currentlyActive = isActive;
      } else {
        currentlyActive =
          this.lastActivityTime && now - this.lastActivityTime < 10000;
      }

      if (currentlyActive) {
        activityIndicator.classList.add("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
      } else {
        activityIndicator.classList.remove("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle';
      }

      if (this.lastActivityTime) {
        lastUpdateEl.textContent = `Last update: ${this.formatTimeAgo(this.lastActivityTime)}`;
      } else {
        lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
      }
    }

    formatTimeAgo(date) {
      if (!date) return "never";
      const seconds = Math.floor((new Date() - date) / 1000);

      if (seconds < 5) return "just now";
      if (seconds < 60) return `${seconds}s ago`;

      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;

      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;

      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    }

    formatMetricStats(stage, metrics) {
      if (!metrics || Object.keys(metrics).length === 0) {
        return '<div class="text-muted small">Calculating...</div>';
      }

      let statsHtml = '<div class="mt-1">';

      const addStat = (
        label,
        value,
        unit = "",
        icon = null,
        colorClass = "text-primary",
      ) => {
        if (value !== undefined && value !== null) {
          const iconHtml = icon ? `<i class="${icon} me-1"></i>` : "";
          statsHtml += `
            <div class="d-flex justify-content-between">
              <small>${iconHtml}${label}:</small>
              <small class="${colorClass}">${value.toLocaleString()}${unit}</small>
            </div>`;
        }
      };

      if (
        [
          STATUS.INDEXING,
          STATUS.PREPROCESSING,
          STATUS.LOADING_STREETS,
        ].includes(stage)
      ) {
        addStat("Streets Found", metrics.total_segments, "", "fas fa-road");
        addStat(
          "Total Length",
          this.distanceInUserUnits(metrics.total_length_m || 0),
          "",
          "fas fa-ruler-horizontal",
        );
        addStat(
          "Driveable Length",
          this.distanceInUserUnits(metrics.driveable_length_m || 0),
          "",
          "fas fa-car",
        );
      } else if (
        [
          STATUS.PROCESSING_TRIPS,
          STATUS.CALCULATING,
          STATUS.COUNTING_TRIPS,
        ].includes(stage)
      ) {
        const processed = metrics.processed_trips || 0;
        const total = metrics.total_trips_to_process || 0;
        const tripsProgress =
          total > 0 ? ((processed / total) * 100).toFixed(1) : 0;
        addStat(
          "Trips Processed",
          `${processed}/${total} (${tripsProgress}%)`,
          "",
          "fas fa-route",
        );
        addStat(
          "New Segments Covered",
          metrics.newly_covered_segments,
          "",
          "fas fa-plus-circle",
          "text-success",
        );
        addStat(
          "Current Coverage",
          metrics.coverage_percentage?.toFixed(1),
          "%",
          "fas fa-check-double",
          "text-success",
        );
        addStat(
          "Distance Covered",
          this.distanceInUserUnits(metrics.covered_length_m || 0),
          "",
          "fas fa-road",
        );
      } else if (
        [
          STATUS.FINALIZING,
          STATUS.GENERATING_GEOJSON,
          STATUS.COMPLETE_STATS,
          STATUS.COMPLETE,
          STATUS.COMPLETED,
        ].includes(stage)
      ) {
        addStat("Total Segments", metrics.total_segments, "", "fas fa-road");
        addStat(
          "Segments Covered",
          metrics.total_covered_segments,
          "",
          "fas fa-check-circle",
          "text-success",
        );
        addStat(
          "Final Coverage",
          metrics.coverage_percentage?.toFixed(1),
          "%",
          "fas fa-check-double",
          "text-success",
        );
        addStat(
          "Total Driveable",
          this.distanceInUserUnits(metrics.driveable_length_m || 0),
          "",
          "fas fa-car",
        );
        addStat(
          "Distance Covered",
          this.distanceInUserUnits(metrics.covered_length_m || 0),
          "",
          "fas fa-road",
          "text-success",
        );
      } else {
        statsHtml += '<div class="text-muted small">Processing...</div>';
      }

      statsHtml += "</div>";
      return statsHtml;
    }

    async displayCoverageDashboard(locationId) {
      const dashboardContainer = document.getElementById("coverage-dashboard");
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name",
      );
      const mapContainer = document.getElementById("coverage-map");
      const chartContainer = document.getElementById("street-type-chart");
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      const streetTypeCoverageEl = document.getElementById(
        "street-type-coverage",
      );

      if (
        !dashboardContainer ||
        !dashboardLocationName ||
        !mapContainer ||
        !chartContainer ||
        !statsContainer ||
        !streetTypeCoverageEl
      ) {
        console.error("Dashboard elements not found in the DOM.");
        this.notificationManager.show(
          "UI Error: Dashboard components missing.",
          "danger",
        );
        return;
      }

      dashboardContainer.style.display = "block";
      dashboardLocationName.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span> Loading...';
      mapContainer.innerHTML = CoverageManager.createLoadingIndicator(
        "Loading map data...",
      );
      chartContainer.innerHTML = CoverageManager.createLoadingIndicator(
        "Loading chart data...",
      );
      statsContainer.innerHTML = CoverageManager.createLoadingIndicator(
        "Loading statistics...",
      );
      streetTypeCoverageEl.innerHTML = CoverageManager.createLoadingIndicator(
        "Loading breakdown...",
      );

      dashboardContainer.scrollIntoView({ behavior: "smooth", block: "start" });

      try {
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            errorDetail = (await response.json()).detail || errorDetail;
          } catch (e) {}
          throw new Error(`Failed to load coverage data (${errorDetail})`);
        }

        const data = await response.json();
        if (!data.success || !data.coverage) {
          throw new Error(
            data.error || "Failed to load coverage data from API",
          );
        }

        this.selectedLocation = data.coverage;
        const coverage = data.coverage;

        const locationName = coverage.location_name || "Coverage Details";
        dashboardLocationName.textContent = locationName;

        this.updateDashboardStats(coverage);

        const hasStreetData = coverage.streets_geojson?.features?.length > 0;
        const needsReprocessing = coverage.needs_reprocessing || false;
        const hasError = coverage.has_error || false;
        const status = coverage.status || STATUS.UNKNOWN;
        const isCurrentlyProcessing = [
          STATUS.PROCESSING_TRIPS,
          STATUS.PREPROCESSING,
          STATUS.CALCULATING,
          STATUS.INDEXING,
          STATUS.FINALIZING,
          STATUS.GENERATING_GEOJSON,
          STATUS.COMPLETE_STATS,
          STATUS.INITIALIZING,
          STATUS.LOADING_STREETS,
          STATUS.COUNTING_TRIPS,
        ].includes(status);

        if (
          hasError ||
          needsReprocessing ||
          isCurrentlyProcessing ||
          !hasStreetData
        ) {
          let statusMessageHtml;
          let chartMessageHtml =
            '<div class="alert alert-secondary small p-2">Chart requires map data.</div>';
          let notificationType = "info";
          let notificationMessage = `Map data unavailable for ${locationName}.`;

          if (hasError) {
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Error in Last Calculation",
              coverage.error_message || "An unexpected error occurred.",
              "danger",
              locationId,
            );
            notificationType = "danger";
            notificationMessage = `Error loading map for ${locationName}.`;
          } else if (isCurrentlyProcessing) {
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Processing in Progress",
              `Coverage data for ${locationName} is currently being processed (Status: ${CoverageManager.formatStageName(status)}). The map will be available once complete.`,
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Chart data will be available after processing.</div>';
            notificationMessage = `Processing map data for ${locationName}...`;
            setTimeout(() => this.displayCoverageDashboard(locationId), 15000);
          } else if (status === STATUS.COMPLETED && !hasStreetData) {
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Finalizing Map Data",
              "Coverage statistics calculated. Generating detailed map data...",
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Generating chart data...</div>';
            notificationMessage = `Finalizing map data for ${locationName}.`;
            setTimeout(() => this.displayCoverageDashboard(locationId), 10000);
          } else {
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Map Data Not Available",
              "Please update the coverage data to generate the map.",
              "warning",
              locationId,
            );
            notificationType = "warning";
            notificationMessage = `Map data needs to be generated for ${locationName}.`;
          }

          mapContainer.innerHTML = statusMessageHtml;
          chartContainer.innerHTML = chartMessageHtml;
          this.notificationManager.show(notificationMessage, notificationType);
        } else {
          this.notificationManager.show(
            `Loaded coverage map for ${locationName}`,
            "success",
          );

          this.initializeCoverageMap(coverage);
          this.createStreetTypeChart(coverage.street_types);
          this.updateStreetTypeCoverage(coverage.street_types);

          this.fitMapToBounds();
        }

        this.initTooltips();
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger p-4"><strong>Error:</strong> ${error.message}</div>`;
        chartContainer.innerHTML = "";
        statsContainer.innerHTML = `<div class="text-danger p-2">Failed to load stats.</div>`;
        streetTypeCoverageEl.innerHTML = `<div class="text-danger p-2">Failed to load breakdown.</div>`;
        this.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
      }
    }

    updateDashboardStats(coverage) {
      if (!coverage) return;
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (!statsContainer) return;

      const totalLengthM = coverage.total_length || 0;
      const drivenLengthM = coverage.driven_length || 0;
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";
      const totalSegments = coverage.total_segments || 0;
      const lastUpdated = coverage.last_updated
        ? new Date(coverage.last_updated).toLocaleString()
        : "Never";

      let barColor = "bg-success";
      if (
        coverage.status === STATUS.ERROR ||
        coverage.status === STATUS.CANCELED
      )
        barColor = "bg-secondary";
      else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
      else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";

      statsContainer.innerHTML = `
        <div class="progress mb-3" style="height: 25px">
          <div id="coverage-percentage-bar"
               class="progress-bar ${barColor}"
               role="progressbar"
               style="width: ${coveragePercentage}%"
               aria-valuenow="${coveragePercentage}"
               aria-valuemin="0"
               aria-valuemax="100">
            <span id="dashboard-coverage-percentage-text">${coveragePercentage}%</span>
          </div>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small>Total Segments:</small>
          <small id="dashboard-total-segments">${totalSegments.toLocaleString()}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small>Total Length:</small>
          <small id="dashboard-total-length">${this.distanceInUserUnits(totalLengthM)}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small>Driven Length:</small>
          <small id="dashboard-driven-length">${this.distanceInUserUnits(drivenLengthM)}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small>Last Updated:</small>
          <small id="dashboard-last-updated">${lastUpdated}</small>
        </div>
      `;

      this.updateStreetTypeCoverage(coverage.street_types);

      if (this.coverageMap) {
        this.addCoverageSummary(coverage);
      }
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

      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.total_length_m || 0) - (a.total_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6);

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        const coveredDist = this.distanceInUserUnits(
          type.covered_length_m || 0,
        );
        const driveableDist = this.distanceInUserUnits(
          type.driveable_length_m || 0,
        );

        let barColor = "bg-success";
        if (type.coverage_percentage < 25) barColor = "bg-danger";
        else if (type.coverage_percentage < 75) barColor = "bg-warning";

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between mb-1">
              <small><strong>${CoverageManager.formatStreetType(type.type)}</strong></small>
              <small>${coveragePct}% (${coveredDist} / ${driveableDist})</small>
            </div>
            <div class="progress" style="height: 8px;" title="${CoverageManager.formatStreetType(type.type)}: ${coveragePct}% Covered">
              <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%"
                   aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
          </div>
        `;
      });
      streetTypeCoverageEl.innerHTML = html;
    }

    clearDashboardUI() {
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      document.querySelector(
        ".dashboard-stats-card .stats-container",
      ).innerHTML = "";
      document.getElementById("street-type-chart").innerHTML = "";
      document.getElementById("street-type-coverage").innerHTML = "";

      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = "";
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }

      this.selectedLocation = null;
      this.streetsGeoJson = null;
      this.streetsGeoJsonLayer = null;
      this.highlightedLayer = null;
      this.hoverHighlightLayer = null;
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }
    }

    static createLoadingIndicator(message = "Loading...") {
      return `
        <div class="d-flex flex-column align-items-center justify-content-center p-4 text-center text-muted">
          <div class="spinner-border spinner-border-sm text-secondary mb-2" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <small>${message}</small>
        </div>`;
    }

    static createAlertMessage(
      title,
      message,
      type = "info",
      locationId = null,
    ) {
      const iconClass =
        type === "danger"
          ? "fa-exclamation-circle"
          : type === "warning"
            ? "fa-exclamation-triangle"
            : "fa-info-circle";
      const buttonHtml = locationId
        ? `
        <hr>
        <p class="mb-1 small">Try running an update:</p>
        <button class="update-missing-data-btn btn btn-sm btn-primary" data-location-id="${locationId}">
          <i class="fas fa-sync-alt me-1"></i> Update Coverage Now
        </button>`
        : "";

      return `
        <div class="alert alert-${type} m-3">
          <h5 class="alert-heading h6"><i class="fas ${iconClass} me-2"></i>${title}</h5>
          <p class="small mb-0">${message}</p>
          ${buttonHtml}
        </div>`;
    }

    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }

      mapContainer.innerHTML = "";

      this.coverageMap = L.map("coverage-map", {
        attributionControl: false,
        zoomControl: true,
      });

      this.coverageMap.createPane("streetPane");
      this.coverageMap.getPane("streetPane").style.zIndex = 450;
      this.coverageMap.createPane("tripsPane");
      this.coverageMap.getPane("tripsPane").style.zIndex = 460;

      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: "abcd",
          maxZoom: 20,
          minZoom: 5,
        },
      ).addTo(this.coverageMap);

      L.control.attribution({ prefix: false }).addTo(this.coverageMap);

      if (coverage.streets_geojson) {
        this.addStreetsToMap(coverage.streets_geojson);
      } else {
        console.warn("No streets_geojson data found in coverage object.");
        this.mapBounds = null;
      }

      this.addCoverageSummary(coverage);

      this.coverageMap.on("click", () => {
        this.clearHighlight();
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
      });

      setTimeout(() => this.coverageMap?.invalidateSize(), 100);

      this.coverageMap.on("moveend zoomend", () => {
        if (this.showTripsActive) {
          clearTimeout(this.loadTripsDebounceTimer);
          this.loadTripsDebounceTimer = setTimeout(() => {
            console.log("Map move/zoom ended, reloading trips for view.");
            this.loadTripsForView();
          }, 500);
        }
      });
    }

    styleStreet(feature, isHover = false, isHighlight = false) {
      const props = feature.properties;
      const isDriven = props.driven;
      const isUndriveable = props.undriveable;
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";

      const baseWeight = 3;
      let weight = baseWeight;
      if (["motorway", "trunk", "primary"].includes(streetType))
        weight = baseWeight + 2;
      else if (streetType === "secondary") weight = baseWeight + 1.5;
      else if (streetType === "tertiary") weight = baseWeight + 1;
      else if (["residential", "unclassified"].includes(streetType))
        weight = baseWeight;
      else if (
        ["service", "track", "path", "living_street"].includes(streetType)
      )
        weight = baseWeight - 0.5;
      else weight = baseWeight - 1;

      let color;
      let opacity = 0.75;
      let dashArray = null;

      if (isUndriveable) {
        color = "#607d8b";
        opacity = 0.6;
        dashArray = "4, 4";
      } else if (isDriven) {
        color = "#4caf50";
      } else {
        color = "#ff5252";
      }

      if (isHighlight) {
        weight += 2;
        opacity = 1;
        color = "#ffff00";
      } else if (isHover) {
        weight += 1.5;
        opacity = 0.95;
      }

      return {
        color: color,
        weight: weight,
        opacity: opacity,
        dashArray: dashArray,
      };
    }

    addStreetsToMap(geojson) {
      if (!this.coverageMap) return;

      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      } else {
        this.streetLayers = L.layerGroup().addTo(this.coverageMap);
      }

      this.streetsGeoJson = geojson;
      this.currentFilter = "all";

      if (!geojson || !geojson.features || geojson.features.length === 0) {
        console.warn("No street features found in GeoJSON data.");
        this.mapBounds = this.coverageMap.getBounds();
        this.streetsGeoJsonLayer = null;
        return;
      }

      this.streetsGeoJsonLayer = L.geoJSON(geojson, {
        style: (feature) => this.styleStreet(feature),
        onEachFeature: (feature, layer) => {
          layer.originalStyle = this.styleStreet(feature);
          layer.featureProperties = feature.properties;

          layer.on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            this.clearHighlight();
            this.clearHoverHighlight();

            this.highlightedLayer = layer;
            layer.setStyle(this.styleStreet(feature, false, true));
            layer.bringToFront();

            this.updateMapInfoPanel(feature.properties);
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";

            layer.openPopup();
          });

          layer.on("mouseover", (e) => {
            if (layer !== this.highlightedLayer) {
              this.clearHoverHighlight();
              this.hoverHighlightLayer = layer;
              layer.setStyle(this.styleStreet(feature, true, false));
              layer.bringToFront();
            }
          });
          layer.on("mouseout", (e) => {
            if (layer === this.hoverHighlightLayer) {
              this.clearHoverHighlight();
            }
          });

          const handleMarkDriven = () =>
            this.markStreetSegment(layer, "driven");
          const handleMarkUndriven = () =>
            this.markStreetSegment(layer, "undriven");
          const handleMarkUndriveable = () =>
            this.markStreetSegment(layer, "undriveable");
          const handleMarkDriveable = () =>
            this.markStreetSegment(layer, "driveable");

          layer._popupHandlers = {
            handleMarkDriven,
            handleMarkUndriven,
            handleMarkUndriveable,
            handleMarkDriveable,
          };

          layer.bindPopup(() => this.createStreetPopupContent(layer), {
            closeButton: true,
            minWidth: 240,
            className: "coverage-popup",
          });

          layer.on("popupopen", (e) => {
            console.log(
              "Popup opened for segment:",
              feature.properties.segment_id,
            );
            const popupEl = e.popup.getElement();
            if (!popupEl) {
              console.error("Popup element not found on open:", e);
              return;
            }

            queueMicrotask(() => {
              const drivenBtn = popupEl.querySelector(".mark-driven-btn");
              const undrivenBtn = popupEl.querySelector(".mark-undriven-btn");
              const undriveableBtn = popupEl.querySelector(
                ".mark-undriveable-btn",
              );
              const driveableBtn = popupEl.querySelector(".mark-driveable-btn");

              console.log("Attaching listeners. Buttons found:", {
                driven: !!drivenBtn,
                undriven: !!undrivenBtn,
                undriveable: !!undriveableBtn,
                driveable: !!driveableBtn,
              });

              drivenBtn?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkDriven,
              );
              undrivenBtn?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriven,
              );
              undriveableBtn?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriveable,
              );
              driveableBtn?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkDriveable,
              );
            });
          });

          layer.on("popupclose", (e) => {
            const popupEl = e.popup.getElement();
            if (!popupEl || !layer._popupHandlers) return;

            console.log(
              "Popup closed, removing listeners for segment:",
              feature.properties.segment_id,
            );
            const drivenBtn = popupEl.querySelector(".mark-driven-btn");
            const undrivenBtn = popupEl.querySelector(".mark-undriven-btn");
            const undriveableBtn = popupEl.querySelector(
              ".mark-undriveable-btn",
            );
            const driveableBtn = popupEl.querySelector(".mark-driveable-btn");

            drivenBtn?.removeEventListener(
              "click",
              layer._popupHandlers.handleMarkDriven,
            );
            undrivenBtn?.removeEventListener(
              "click",
              layer._popupHandlers.handleMarkUndriven,
            );
            undriveableBtn?.removeEventListener(
              "click",
              layer._popupHandlers.handleMarkUndriveable,
            );
            driveableBtn?.removeEventListener(
              "click",
              layer._popupHandlers.handleMarkDriveable,
            );
          });
        },
        pane: "streetPane",
      });

      this.streetLayers.addLayer(this.streetsGeoJsonLayer);

      this.mapBounds = this.streetsGeoJsonLayer.getBounds();
    }

    createStreetPopupContent(layer) {
      const props = layer.featureProperties;
      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const lengthMiles = this.distanceInUserUnits(props.segment_length_m || 0);
      const status = props.driven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      const popupContent = document.createElement("div");
      popupContent.className = "street-popup-content";
      popupContent.innerHTML = `
        <h6>${streetName}</h6>
        <hr>
        <small>
          <strong>Type:</strong> ${CoverageManager.formatStreetType(streetType)}<br>
          <strong>Length:</strong> ${lengthMiles}<br>
          <strong>Status:</strong> <span class="${props.driven ? "text-success" : "text-danger"}">${status}</span><br>
          ${props.undriveable ? '<strong>Marked as:</strong> <span class="text-warning">Undriveable</span><br>' : ""}
          <strong>ID:</strong> ${segmentId}
        </small>
        <div class="street-actions mt-2 d-flex flex-wrap gap-2">
          ${!props.driven ? `<button class="btn btn-sm btn-outline-success mark-driven-btn">Mark Driven</button>` : ""}
          ${props.driven ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn">Mark Undriven</button>` : ""}
          ${!props.undriveable ? `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn">Mark Undriveable</button>` : ""}
          ${props.undriveable ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn">Mark Driveable</button>` : ""}
        </div>
      `;
      return popupContent;
    }

    clearHighlight() {
      if (this.highlightedLayer) {
        try {
          this.highlightedLayer.setStyle(this.highlightedLayer.originalStyle);
        } catch (styleError) {
          console.warn(
            "Could not reset style on previously highlighted layer:",
            styleError,
          );
          try {
            this.highlightedLayer.setStyle({
              weight: 3,
              opacity: 0.7,
              color: "#ff5252",
            });
          } catch (fallbackError) {
            console.warn("Fallback style reset failed:", fallbackError);
          }
        }
        this.highlightedLayer = null;
      }
    }

    clearHoverHighlight() {
      if (this.hoverHighlightLayer) {
        try {
          if (this.hoverHighlightLayer !== this.highlightedLayer) {
            this.hoverHighlightLayer.setStyle(
              this.hoverHighlightLayer.originalStyle,
            );
          }
        } catch (styleError) {
          console.warn(
            "Could not reset style on previously hovered layer:",
            styleError,
          );
          try {
            this.hoverHighlightLayer.setStyle({
              weight: 3,
              opacity: 0.7,
              color: "#ff5252",
            });
          } catch (fallbackError) {
            console.warn("Fallback style reset failed:", fallbackError);
          }
        }
        this.hoverHighlightLayer = null;
      }
    }

    createMapInfoPanel() {
      if (this.mapInfoPanel) return;

      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      document.getElementById("coverage-map")?.appendChild(this.mapInfoPanel);
    }

    updateMapInfoPanel(props, isHover = false) {
      if (!this.mapInfoPanel) return;

      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const lengthMiles = this.distanceInUserUnits(props.segment_length_m || 0);
      const status = props.driven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      this.mapInfoPanel.innerHTML = `
        <strong class="d-block mb-1">${streetName}</strong>
        ${isHover ? "" : '<hr class="panel-divider">'} <div class="d-flex justify-content-between small">
          <span>Type:</span>
          <span class="text-info">${CoverageManager.formatStreetType(streetType)}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Length:</span>
          <span class="text-info">${lengthMiles}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Status:</span>
          <span class="${props.driven ? "text-success" : "text-danger"}">
            <i class="fas fa-${props.driven ? "check-circle" : "times-circle"} me-1"></i>${status}
          </span>
        </div>
        ${
          props.undriveable
            ? `
          <div class="d-flex justify-content-between small">
            <span>Marked:</span>
            <span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span>
          </div>`
            : ""
        }
        ${
          isHover
            ? ""
            : `
          <div class="d-flex justify-content-between small mt-1">
            <span>ID:</span>
            <span class="text-muted">${segmentId}</span>
          </div>
          <div class="mt-2 small text-center text-muted">Click segment to mark status</div>
        `
        }
      `;
    }

    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;

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
          L.DomEvent.disableClickPropagation(container);
          L.DomEvent.disableScrollPropagation(container);

          const coveragePercentage =
            coverage.coverage_percentage?.toFixed(1) || "0.0";
          const totalMiles = this.distanceInUserUnits(
            coverage.total_length || 0,
          );
          const drivenMiles = this.distanceInUserUnits(
            coverage.driven_length || 0,
          );

          let barColor = "bg-success";
          if (
            coverage.status === STATUS.ERROR ||
            coverage.status === STATUS.CANCELED
          )
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
                <div>${drivenMiles} / ${totalMiles}</div>
              </div>
            </div>`;
          return container;
        },
        onRemove: () => {},
      });

      this.coverageSummaryControl = new CoverageSummaryControl();
      this.coverageSummaryControl.addTo(this.coverageMap);
    }

    async markStreetSegment(layer, action) {
      const props = layer.featureProperties;
      if (!props || !props.segment_id) {
        this.notificationManager.show("Missing segment ID.", "danger");
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation._id) {
        this.notificationManager.show("Missing location context.", "danger");
        return;
      }

      const locationId = this.selectedLocation._id;
      const segmentId = props.segment_id;

      let apiEndpoint, statusText, optimisticDriven, optimisticUndriveable;
      switch (action) {
        case "driven":
          apiEndpoint = "/api/street_segments/mark_driven";
          statusText = "driven";
          optimisticDriven = true;
          optimisticUndriveable = false;
          break;
        case "undriven":
          apiEndpoint = "/api/street_segments/mark_undriven";
          statusText = "undriven";
          optimisticDriven = false;
          optimisticUndriveable = props.undriveable;
          break;
        case "undriveable":
          apiEndpoint = "/api/street_segments/mark_undriveable";
          statusText = "undriveable";
          optimisticDriven = props.driven;
          optimisticUndriveable = true;
          break;
        case "driveable":
          apiEndpoint = "/api/street_segments/mark_driveable";
          statusText = "driveable";
          optimisticDriven = props.driven;
          optimisticUndriveable = false;
          break;
        default:
          this.notificationManager.show("Invalid action specified", "danger");
          return;
      }

      const streetName = props.name || props.street_name || "Unnamed Street";
      const originalStyle = layer.originalStyle;

      layer.featureProperties.driven = optimisticDriven;
      layer.featureProperties.undriveable = optimisticUndriveable;
      const newStyle = this.styleStreet({
        properties: layer.featureProperties,
      });
      layer.setStyle(newStyle);

      if (this.highlightedLayer === layer && this.mapInfoPanel) {
        this.updateMapInfoPanel(layer.featureProperties);
      }
      this.coverageMap?.closePopup();

      try {
        this.notificationManager.show(
          `Marking ${streetName} as ${statusText}...`,
          "info",
        );

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

        this.notificationManager.show(
          `Marked ${streetName} as ${statusText}.`,
          "success",
        );
        layer.originalStyle = { ...newStyle };
        await this.refreshCoverageStats();
      } catch (error) {
        console.error(`Error marking segment as ${statusText}:`, error);
        this.notificationManager.show(
          `Failed to mark segment: ${error.message}`,
          "danger",
        );

        layer.featureProperties.driven = props.driven;
        layer.featureProperties.undriveable = props.undriveable;
        layer.setStyle(originalStyle);

        if (this.highlightedLayer === layer && this.mapInfoPanel) {
          this.updateMapInfoPanel(layer.featureProperties);
        }
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
        if (!data.success || !data.coverage) {
          throw new Error(data.error || "API returned failure on stat refresh");
        }

        this.selectedLocation = { ...this.selectedLocation, ...data.coverage };

        this.updateDashboardStats(this.selectedLocation);
        this.createStreetTypeChart(this.selectedLocation.street_types);
        this.updateStreetTypeCoverage(this.selectedLocation.street_types);

        this.notificationManager.show("Coverage statistics refreshed.", "info");
        return data.coverage;
      } catch (error) {
        console.error("Error refreshing coverage stats:", error);
        this.notificationManager.show(
          `Failed to refresh stats: ${error.message}`,
          "warning",
        );
        return undefined;
      }
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, { padding: [40, 40] });
      } else if (this.coverageMap) {
        this.coverageMap.setView([31.55, -97.15], 11);
        console.warn("Map bounds invalid or not set, using default view.");
      }
    }

    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;

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
          '<div class="alert alert-warning">Chart library not found.</div>';
        return;
      }

      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.driveable_length_m || 0) - (a.driveable_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 7);

      const labels = topTypes.map((t) =>
        CoverageManager.formatStreetType(t.type),
      );
      const parseDist = (distStr) => parseFloat(distStr.split(" ")[0]) || 0;

      const drivenLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.covered_length_m || 0)),
      );
      const driveableLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.driveable_length_m || 0)),
      );
      const notDrivenLengths = driveableLengths.map((total, i) =>
        parseFloat(Math.max(0, total - drivenLengths[i]).toFixed(2)),
      );

      const lengthUnit = "mi";

      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      const drivenColor = "rgba(76, 175, 80, 0.8)";
      const notDrivenColor = "rgba(255, 82, 82, 0.7)";

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
                  const total = driveableLengths[context.dataIndex];
                  const percentage =
                    total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                  return `${label}: ${value.toFixed(2)} ${lengthUnit} (${percentage}%)`;
                },
                footer: (tooltipItems) => {
                  const total = driveableLengths[tooltipItems[0].dataIndex];
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
            title: { display: false },
          },
        },
      });
    }

    exportCoverageMap() {
      if (!this.coverageMap || typeof leafletImage === "undefined") {
        this.notificationManager.show(
          "Map export library (leaflet-image) not available.",
          "warning",
        );
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation.location_name) {
        this.notificationManager.show(
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

      this.notificationManager.show("Generating map image...", "info");

      this.setMapFilter(this.currentFilter || "all", false);
      this.coverageMap.invalidateSize();

      setTimeout(() => {
        leafletImage(
          this.coverageMap,
          (err, canvas) => {
            if (err) {
              console.error("Error generating map image:", err);
              this.notificationManager.show(
                `Failed to generate map image: ${err.message || err}`,
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
              this.notificationManager.show(
                "Map image download started.",
                "success",
              );
            } catch (downloadError) {
              console.error("Error triggering download:", downloadError);
              this.notificationManager.show(
                "Failed to trigger map download.",
                "danger",
              );
            }
          },
          { preferCanvas: true },
        );
      }, 1000);
    }

    setMapFilter(filterType, updateButtons = true) {
      if (
        !this.coverageMap ||
        !this.streetsGeoJsonLayer ||
        !this.streetLayers
      ) {
        console.warn(
          "Cannot set map filter: Map or street layer not initialized.",
        );
        return;
      }

      this.currentFilter = filterType;
      console.log(`Applying filter: ${filterType}`);
      let visibleCount = 0;

      this.streetsGeoJsonLayer.eachLayer((layer) => {
        const props = layer.featureProperties;
        let isVisible = false;

        if (filterType === "driven") {
          isVisible = props.driven === true && !props.undriveable;
        } else if (filterType === "undriven") {
          isVisible = props.driven === false && !props.undriveable;
        } else {
          isVisible = true;
        }

        if (isVisible) {
          if (!this.streetLayers.hasLayer(layer)) {
            try {
              layer.setStyle(layer.originalStyle);
            } catch (e) {
              console.warn("Style reset failed on add");
            }
            this.streetLayers.addLayer(layer);
          }
          if (layer === this.highlightedLayer) {
            layer.setStyle(this.styleStreet(layer.feature, false, true));
            layer.bringToFront();
          }
          visibleCount++;
        } else {
          if (layer === this.highlightedLayer) {
            this.clearHighlight();
          }
          if (layer === this.hoverHighlightLayer) {
            this.clearHoverHighlight();
          }

          if (this.streetLayers.hasLayer(layer)) {
            try {
              layer.setStyle(layer.originalStyle);
            } catch (e) {
              console.warn("Style reset failed on removal");
            }
            this.streetLayers.removeLayer(layer);
          }
        }
      });

      console.log(`Filter applied. Visible segments: ${visibleCount}`);

      if (updateButtons) {
        this.updateFilterButtonStates();
      }
    }

    updateFilterButtonStates() {
      const filterButtons = {
        all: document.querySelector('.map-controls button[data-filter="all"]'),
        driven: document.querySelector(
          '.map-controls button[data-filter="driven"]',
        ),
        undriven: document.querySelector(
          '.map-controls button[data-filter="undriven"]',
        ),
      };

      Object.keys(filterButtons).forEach((key) => {
        const btn = filterButtons[key];
        if (!btn) return;

        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
          "btn-outline-secondary",
        );
        btn.classList.add("btn-outline-secondary");

        if (key === this.currentFilter) {
          btn.classList.add("active");
          btn.classList.remove("btn-outline-secondary");
          if (key === "driven") btn.classList.add("btn-success");
          else if (key === "undriven") btn.classList.add("btn-danger");
          else btn.classList.add("btn-primary");
        }
      });
    }

    static getStageIcon(stage) {
      const icons = {
        [STATUS.INITIALIZING]: '<i class="fas fa-cog fa-spin"></i>',
        [STATUS.PREPROCESSING]: '<i class="fas fa-map-marked-alt"></i>',
        [STATUS.LOADING_STREETS]: '<i class="fas fa-map"></i>',
        [STATUS.INDEXING]: '<i class="fas fa-project-diagram"></i>',
        [STATUS.COUNTING_TRIPS]: '<i class="fas fa-calculator"></i>',
        [STATUS.PROCESSING_TRIPS]: '<i class="fas fa-route fa-spin"></i>',
        [STATUS.CALCULATING]: '<i class="fas fa-cogs fa-spin"></i>',
        [STATUS.FINALIZING]: '<i class="fas fa-chart-line"></i>',
        [STATUS.GENERATING_GEOJSON]: '<i class="fas fa-file-code fa-spin"></i>',
        [STATUS.COMPLETE_STATS]: '<i class="fas fa-check"></i>',
        [STATUS.COMPLETE]: '<i class="fas fa-check-circle"></i>',
        [STATUS.COMPLETED]: '<i class="fas fa-check-circle"></i>',
        [STATUS.ERROR]: '<i class="fas fa-exclamation-circle"></i>',
        [STATUS.WARNING]: '<i class="fas fa-exclamation-triangle"></i>',
        [STATUS.CANCELED]: '<i class="fas fa-ban"></i>',
      };
      return icons[stage] || '<i class="fas fa-question-circle"></i>';
    }

    static getStageTextClass(stage) {
      const classes = {
        [STATUS.COMPLETE]: "text-success",
        [STATUS.COMPLETED]: "text-success",
        [STATUS.ERROR]: "text-danger",
        [STATUS.WARNING]: "text-warning",
        [STATUS.CANCELED]: "text-warning",
      };
      return classes[stage] || "text-info";
    }

    static formatStageName(stage) {
      const stageNames = {
        [STATUS.INITIALIZING]: "Initializing",
        [STATUS.PREPROCESSING]: "Fetching Streets",
        [STATUS.LOADING_STREETS]: "Loading Streets",
        [STATUS.INDEXING]: "Building Index",
        [STATUS.COUNTING_TRIPS]: "Analyzing Trips",
        [STATUS.PROCESSING_TRIPS]: "Processing Trips",
        [STATUS.CALCULATING]: "Calculating Coverage",
        [STATUS.FINALIZING]: "Calculating Stats",
        [STATUS.GENERATING_GEOJSON]: "Generating Map",
        [STATUS.COMPLETE_STATS]: "Finalizing",
        [STATUS.COMPLETE]: "Complete",
        [STATUS.COMPLETED]: "Complete",
        [STATUS.ERROR]: "Error",
        [STATUS.WARNING]: "Warning",
        [STATUS.CANCELED]: "Canceled",
      };
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      );
    }

    static formatStreetType(type) {
      if (!type) return "Unknown";
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }

    ensureTripsLayerGroup() {
      if (!this.coverageMap) return;
      if (!this.tripsLayerGroup) {
        this.tripsLayerGroup = L.layerGroup([], {
          pane: "tripsPane",
        });
      }
      if (!this.coverageMap.hasLayer(this.tripsLayerGroup)) {
        this.tripsLayerGroup.addTo(this.coverageMap);
        console.log("Trips layer group added to map.");
      }
    }

    clearTripOverlay() {
      if (this.tripsLayerGroup) {
        this.tripsLayerGroup.clearLayers();
        if (
          this.coverageMap &&
          this.coverageMap.hasLayer(this.tripsLayerGroup)
        ) {
        }
        console.log("Trip overlay cleared.");
      }
    }

    async loadTripsForView() {
      if (!this.coverageMap || !this.showTripsActive) {
        return;
      }

      this.ensureTripsLayerGroup();

      const bounds = this.coverageMap.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();

      const boundsArea = Math.abs(ne.lng - sw.lng) * Math.abs(ne.lat - sw.lat);
      if (boundsArea > 10) {
        console.warn("Map bounds too large, skipping trip overlay update.");
        this.clearTripOverlay();
        this.notificationManager.show(
          "Zoom in further to view trip overlays.",
          "info",
        );
        return;
      }

      const params = new URLSearchParams({
        min_lat: sw.lat.toFixed(6),
        min_lon: sw.lng.toFixed(6),
        max_lat: ne.lat.toFixed(6),
        max_lon: ne.lng.toFixed(6),
      });

      console.log("Fetching trips for bounds:", params.toString());

      try {
        const response = await fetch(
          `/api/trips_in_bounds?${params.toString()}`,
        );
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP Error ${response.status}`);
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.trips)) {
          throw new Error("Invalid trip data received from server.");
        }

        console.log(`Received ${data.trips.length} trip segments.`);
        this.tripsLayerGroup.clearLayers();

        if (data.trips.length > 0) {
          data.trips.forEach((coords) => {
            const latLngs = coords.map(([lon, lat]) => [lat, lon]);
            L.polyline(latLngs, {
              color: "#3388ff",
              weight: 2,
              opacity: 0.7,
              interactive: false,
              pane: "tripsPane",
            }).addTo(this.tripsLayerGroup);
          });
        } else {
          console.log("No trips found in the current map view.");
        }
      } catch (error) {
        console.error("Error loading trips for view:", error);
        this.notificationManager.show(
          `Failed to load trip overlay: ${error.message}`,
          "danger",
        );
        this.clearTripOverlay();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      console.error(
        "Leaflet or Chart.js not loaded. Coverage Manager initialization aborted.",
      );
      const errorContainer = document.getElementById("alerts-container");
      if (errorContainer) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "alert alert-danger";
        errorDiv.textContent =
          "Error: Required libraries (Leaflet, Chart.js) failed to load. Map and chart functionality will be unavailable.";
        errorContainer.prepend(errorDiv);
      }
      return;
    }

    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized.");
  });
})();
