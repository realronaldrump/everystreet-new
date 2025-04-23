/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart, mapboxgl */
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
        show: () => {},
      };
      this.confirmationDialog = window.confirmationDialog || {
        show: (options) => {
          console.warn(
            "ConfirmationDialog fallback used. Ensure utils.js loads before coverage-management.js.",
            options,
          );
          return Promise.resolve(false);
        },
      };

      this.setupAutoRefresh();
      this.checkForInterruptedTasks();
      CoverageManager.setupConnectionMonitoring();
      this.initTooltips();
      this.createMapInfoPanel();
      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    static distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      return `${(meters * 0.000621371).toFixed(fixed)} mi`;
    }

    static setupConnectionMonitoring() {
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

    static enhanceResponsiveTables() {
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
                this.notificationManager.show(
                  `Action failed: Invalid location data. Error: ${parseError.message}`,
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
                this.notificationManager.show(
                  `Unknown table action: ${action}`,
                  "warning",
                );
            }
          } else if (targetLink) {
            e.preventDefault();
            const locationId = targetLink.dataset.locationId;
            if (locationId) {
              this.displayCoverageDashboard(locationId);
            } else {
              this.notificationManager.show(
                "Error: Location ID missing from link.",
                "danger",
              );
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

      let locationData = null;
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

        const errorResponse = error.cause || error;

        try {
          if (errorResponse && typeof errorResponse.json === "function") {
            const errorData = await errorResponse.json();
            if (errorData?.detail) {
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
          this.notificationManager.show(
            `Could not parse error response body or unexpected error structure: ${parseError}, Error: ${error}`,
            "warning",
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
        CoverageManager.enhanceResponsiveTables();
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

      while (retries < maxRetries) {
        if (!this.activeTaskIds.has(taskId)) {
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
            } catch (e) {
              // Ignore JSON parsing error, use HTTP status code
            }
            throw new Error(`Failed to get task status: ${errorDetail}`);
          }

          let data = null;
          try {
            data = await response.json();
            if (!data || typeof data !== "object" || !data.stage) {
              if (response.ok) {
                this.notificationManager.show(
                  `Task ${taskId}: Received incomplete/invalid data structure despite HTTP OK status.`,
                  "warning",
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
          CoverageManager.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date();
          this.saveProcessingState();

          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            this.updateModalContent({ ...data, progress: 100 });
            CoverageManager.updateStepIndicators(STATUS.COMPLETE, 100);
            this.activeTaskIds.delete(taskId);
            return data;
          } else if (data.stage === STATUS.ERROR) {
            const errorMessage = data.error || data.message || "Unknown error";
            this.notificationManager.show(
              `Task ${taskId} failed with error: ${errorMessage}`,
              "danger",
            );
            this.activeTaskIds.delete(taskId);
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            );
          } else if (data.stage === STATUS.CANCELED) {
            this.notificationManager.show(
              `Task ${taskId} was canceled.`,
              "warning",
            );
            this.activeTaskIds.delete(taskId);
            throw new Error("Task was canceled");
          }

          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              this.notificationManager.show(
                `Task ${taskId} seems stalled at stage: ${data.stage}`,
                "warning",
              );
              consecutiveSameStage = 0;
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
          retries++;
        } catch (error) {
          this.notificationManager.show(
            `Error polling coverage progress for task ${taskId}: ${error.message}`,
            "danger",
          );
          this.updateModalContent({
            stage: STATUS.ERROR,
            progress: this.currentProcessingLocation?.progress || 0,
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {},
          });
          CoverageManager.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId);
          throw error;
        }
      }

      this.notificationManager.show(
        `Polling for task ${taskId} timed out after ${(maxRetries * 5) / 60} minutes.`,
        "danger",
      );
      this.updateModalContent({
        stage: STATUS.ERROR,
        progress: this.currentProcessingLocation?.progress || 99,
        message: "Polling timed out waiting for completion.",
        error: "Polling timed out",
        metrics: {},
      });
      CoverageManager.updateStepIndicators(
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
        const totalLengthMiles = CoverageManager.distanceInUserUnits(
          area.total_length,
        );
        const drivenLengthMiles = CoverageManager.distanceInUserUnits(
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
            ${isCanceled ? '<div class="text-warning small"><i class="fas fa-ban me-1"></i>Canceled</div>' : ""}
            ${isProcessing ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>${CoverageManager.formatStageName(status)}...</div>` : ""}
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
        this.notificationManager.show(
          "UI Error: Progress details container not found in modal.",
          "danger",
        );
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

    static updateStepIndicators(stage, progress) {
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
      if (estimatedTimeEl) {
        estimatedTimeEl.textContent = "";
      }
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
      let currentlyActive = false;

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
        lastUpdateEl.textContent = `Last update: ${CoverageManager.formatTimeAgo(this.lastActivityTime)}`;
      } else {
        lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
      }
    }

    static formatTimeAgo(date) {
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
          CoverageManager.distanceInUserUnits(metrics.total_length_m || 0),
          "",
          "fas fa-ruler-horizontal",
        );
        addStat(
          "Driveable Length",
          CoverageManager.distanceInUserUnits(metrics.driveable_length_m || 0),
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
          CoverageManager.distanceInUserUnits(metrics.covered_length_m || 0),
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
          CoverageManager.distanceInUserUnits(metrics.driveable_length_m || 0),
          "",
          "fas fa-car",
        );
        addStat(
          "Distance Covered",
          CoverageManager.distanceInUserUnits(metrics.covered_length_m || 0),
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
          let statusMessageHtml = null;
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
        statsContainer.innerHTML =
          '<div class="text-danger p-2">Failed to load stats.</div>';
        streetTypeCoverageEl.innerHTML =
          '<div class="text-danger p-2">Failed to load breakdown.</div>';
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
          <small id="dashboard-total-length">${CoverageManager.distanceInUserUnits(totalLengthM)}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small>Driven Length:</small>
          <small id="dashboard-driven-length">${CoverageManager.distanceInUserUnits(drivenLengthM)}</small>
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
        const coveredDist = CoverageManager.distanceInUserUnits(
          type.covered_length_m || 0,
        );
        const driveableDist = CoverageManager.distanceInUserUnits(
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
      // Remove any previous map instance
      if (this.coverageMap && this.coverageMap.remove) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }
      mapContainer.innerHTML = "";
      // Mapbox GL JS setup
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
      this.coverageMap = new mapboxgl.Map({
        container: "coverage-map",
        style: "mapbox://styles/mapbox/dark-v11",
        attributionControl: false,
        zoom: 11,
        center: [-97.15, 31.55], // fallback center
        minZoom: 5,
        maxZoom: 20,
        preserveDrawingBuffer: true, // FIX: Enable for html2canvas export
      });
      // mapboxgl.setTelemetryEnabled(false); // Removed: not supported in this Mapbox GL JS version
      this.coverageMap.addControl(
        new mapboxgl.NavigationControl(),
        "top-right",
      );
      this.coverageMap.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        "bottom-right",
      );
      this.coverageMap.on("load", () => {
        if (coverage.streets_geojson) {
          this.addStreetsToMap(coverage.streets_geojson);
        } else {
          this.notificationManager.show(
            "No streets_geojson data found in coverage object.",
            "warning",
          );
          this.mapBounds = null;
        }
        this.addCoverageSummary(coverage);
        this.fitMapToBounds();
      });
      // Remove old info panel if present
      if (this.mapInfoPanel) {
        this.mapInfoPanel.remove();
        this.mapInfoPanel = null;
      }
      this.createMapInfoPanel();
    }

    addStreetsToMap(geojson) {
      if (!this.coverageMap || !geojson) return;
      // Remove previous source/layer if present
      if (this.coverageMap.getLayer("streets-layer")) {
        this.coverageMap.removeLayer("streets-layer");
      }
      if (this.coverageMap.getSource("streets")) {
        this.coverageMap.removeSource("streets");
      }
      this.streetsGeoJson = geojson;
      this.currentFilter = "all";

      this.coverageMap.addSource("streets", {
        type: "geojson",
        data: geojson,
      });

      // Dynamic style function for Mapbox GL JS
      const getLineColor = [
        "case",
        ["boolean", ["get", "undriveable"], false],
        "#607d8b",
        ["boolean", ["get", "driven"], false],
        "#4caf50",
        "#ff5252",
      ];
      const getLineWidth = [
        "case",
        ["==", ["get", "highway"], "motorway"],
        5,
        ["==", ["get", "highway"], "trunk"],
        5,
        ["==", ["get", "highway"], "primary"],
        5,
        ["==", ["get", "highway"], "secondary"],
        4.5,
        ["==", ["get", "highway"], "tertiary"],
        4,
        [
          "in",
          ["get", "highway"],
          ["literal", ["residential", "unclassified"]],
        ],
        3,
        [
          "in",
          ["get", "highway"],
          ["literal", ["service", "track", "path", "living_street"]],
        ],
        2.5,
        2,
      ];
      const getLineOpacity = [
        "case",
        ["boolean", ["get", "undriveable"], false],
        0.6,
        ["boolean", ["get", "driven"], false],
        0.75,
        0.75,
      ];
      const getLineDash = [
        "case",
        ["boolean", ["get", "undriveable"], false],
        ["literal", [2, 2]],
        ["boolean", ["get", "driven"], false],
        ["literal", [1, 0]],
        ["literal", [1, 0]],
      ];

      this.coverageMap.addLayer({
        id: "streets-layer",
        type: "line",
        source: "streets",
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": getLineColor,
          "line-width": getLineWidth,
          "line-opacity": getLineOpacity,
          "line-dasharray": getLineDash,
        },
      });

      // Fit bounds to data
      const bounds = new mapboxgl.LngLatBounds();
      geojson.features.forEach((f) => {
        if (f.geometry.type === "LineString") {
          f.geometry.coordinates.forEach((coord) => bounds.extend(coord));
        } else if (f.geometry.type === "MultiLineString") {
          f.geometry.coordinates.forEach((line) =>
            line.forEach((coord) => bounds.extend(coord)),
          );
        }
      });
      if (!bounds.isEmpty()) {
        this.mapBounds = bounds;
        this.fitMapToBounds();
      }

      // Interactivity: click/hover for popups/info panel
      this.coverageMap.on("mouseenter", "streets-layer", (e) => {
        this.coverageMap.getCanvas().style.cursor = "pointer";
        if (e.features && e.features.length > 0) {
          this.updateMapInfoPanel(e.features[0].properties, true);
          if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
        }
      });
      this.coverageMap.on("mouseleave", "streets-layer", () => {
        this.coverageMap.getCanvas().style.cursor = "";
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
      });
      this.coverageMap.on("click", "streets-layer", (e) => {
        if (e.features && e.features.length > 0) {
          const props = e.features[0].properties;
          const coordinates = e.lngLat;
          // Show popup
          new mapboxgl.Popup({
            closeButton: true,
            minWidth: 240,
            className: "coverage-popup",
          })
            .setLngLat(coordinates)
            .setHTML(this.createStreetPopupContentHTML(props))
            .addTo(this.coverageMap);
          this.updateMapInfoPanel(props, false);
          if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
          // TODO: Add event listeners for popup buttons (mark driven, undriven, etc.)
        }
      });
    }

    // Helper to create popup HTML for Mapbox
    createStreetPopupContentHTML(props) {
      const streetName =
        props.street_name ||
        props.name ||
        props.display_name ||
        "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const lengthMiles = CoverageManager.distanceInUserUnits(
        props.segment_length_m || 0,
      );
      const status = props.driven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";
      return `
        <div style="font-size:1.1em;line-height:1.6;background:#23272b;color:#fff;padding:18px 20px 12px 20px;border-radius:10px;box-shadow:0 2px 12px #000a;min-width:260px;max-width:340px;">
          <div style="font-weight:bold;font-size:1.2em;margin-bottom:6px;color:#59a6ff;">${streetName}</div>
          <div style="margin-bottom:8px;"><span style="color:#bbb;">Type:</span> <span style="color:#fff;">${CoverageManager.formatStreetType(streetType)}</span></div>
          <div style="margin-bottom:8px;"><span style="color:#bbb;">Length:</span> <span style="color:#fff;">${lengthMiles}</span></div>
          <div style="margin-bottom:8px;"><span style="color:#bbb;">Status:</span> <span style="color:${props.driven ? "#4caf50" : "#ff5252"};font-weight:bold;">${status}</span></div>
          ${props.undriveable ? '<div style="margin-bottom:8px;"><span style="color:#bbb;">Marked as:</span> <span style="color:#ffc107;">Undriveable</span></div>' : ""}
          <div style="margin-bottom:8px;"><span style="color:#bbb;">ID:</span> <span style="color:#aaa;">${segmentId}</span></div>
          <div class="street-actions mt-2 d-flex flex-wrap gap-2" style="margin-top:10px;">
            ${!props.driven ? '<button class="btn btn-sm btn-outline-success mark-driven-btn">Mark Driven</button>' : ""}
            ${props.driven ? '<button class="btn btn-sm btn-outline-danger mark-undriven-btn">Mark Undriven</button>' : ""}
            ${!props.undriveable ? '<button class="btn btn-sm btn-outline-warning mark-undriveable-btn">Mark Undriveable</button>' : ""}
            ${props.undriveable ? '<button class="btn btn-sm btn-outline-info mark-driveable-btn">Mark Driveable</button>' : ""}
          </div>
        </div>
      `;
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && !this.mapBounds.isEmpty()) {
        this.coverageMap.fitBounds(this.mapBounds, {
          padding: 40,
          maxZoom: 17,
        });
      } else if (this.coverageMap) {
        this.coverageMap.setCenter([-97.15, 31.55]);
        this.coverageMap.setZoom(11);
        this.notificationManager.show(
          "Map bounds invalid or not set, using default view.",
          "warning",
        );
      }
    }

    setMapFilter(filterType, updateButtons = true) {
      if (!this.coverageMap || !this.coverageMap.getLayer("streets-layer")) {
        this.notificationManager.show(
          "Cannot set map filter: Map or street layer not initialized.",
          "warning",
        );
        return;
      }
      this.currentFilter = filterType;
      let filter = null;
      if (filterType === "driven") {
        filter = [
          "all",
          ["==", ["get", "driven"], true],
          ["!", ["get", "undriveable"]],
        ];
      } else if (filterType === "undriven") {
        filter = [
          "all",
          ["==", ["get", "driven"], false],
          ["!", ["get", "undriveable"]],
        ];
      } else {
        filter = null; // show all
      }
      this.coverageMap.setFilter("streets-layer", filter);
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
        [STATUS.POLLING_CHECK]: '<i class="fas fa-sync-alt fa-spin"></i>',
        [STATUS.UNKNOWN]: '<i class="fas fa-question-circle"></i>',
      };
      return icons[stage] || icons[STATUS.UNKNOWN];
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
        [STATUS.POLLING_CHECK]: "Checking Status",
        [STATUS.UNKNOWN]: "Unknown",
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
      // This is a no-op for MapboxGL; remove Leaflet code
      // Optionally, implement trip overlays using MapboxGL sources/layers if needed
      return;
    }

    clearTripOverlay() {
      if (this.tripsLayerGroup) {
        this.tripsLayerGroup.clearLayers();
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
      if (boundsArea > 5) {
        this.notificationManager.show(
          "Map area too large, zoom in further to view trip overlays.",
          "info",
        );
        this.clearTripOverlay();
        return;
      }

      const params = new URLSearchParams({
        min_lat: sw.lat.toFixed(6),
        min_lon: sw.lng.toFixed(6),
        max_lat: ne.lat.toFixed(6),
        max_lon: ne.lng.toFixed(6),
      });

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
        }
      } catch (error) {
        this.notificationManager.show(
          `Failed to load trip overlay: ${error.message}`,
          "danger",
        );
        this.clearTripOverlay();
      }
    }

    createMapInfoPanel() {
      if (this.mapInfoPanel) return;
      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      this.mapInfoPanel.style.display = "none";
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.appendChild(this.mapInfoPanel);
    }

    updateMapInfoPanel(props, isHover = false) {
      if (!this.mapInfoPanel) return;
      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const lengthMiles = CoverageManager.distanceInUserUnits(
        props.segment_length_m || 0,
      );
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
        ${props.undriveable ? `<div class="d-flex justify-content-between small"><span>Marked:</span><span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span></div>` : ""}
        ${isHover ? "" : `<div class="d-flex justify-content-between small mt-1"><span>ID:</span><span class="text-muted">${segmentId}</span></div><div class="mt-2 small text-center text-muted">Click segment to mark status</div>`}
      `;
    }

    // Add this method to CoverageManager:
    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;
      // Remove any previous chart instance
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }
      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data available.</div>';
        return;
      }
      // Prepare data
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.total_length_m || 0) - (a.total_length_m || 0),
      );
      const labels = sortedTypes.map((t) =>
        CoverageManager.formatStreetType(t.type),
      );
      const covered = sortedTypes.map(
        (t) => (t.covered_length_m || 0) * 0.000621371,
      ); // miles
      const driveable = sortedTypes.map(
        (t) => (t.driveable_length_m || 0) * 0.000621371,
      ); // miles
      const coveragePct = sortedTypes.map((t) => t.coverage_percentage || 0);
      // Create canvas
      chartContainer.innerHTML =
        '<canvas id="streetTypeChartCanvas" height="180"></canvas>';
      const ctx = document
        .getElementById("streetTypeChartCanvas")
        .getContext("2d");
      this.streetTypeChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Covered (mi)",
              data: covered,
              backgroundColor: "#4caf50",
              borderColor: "#388e3c",
              borderWidth: 1,
            },
            {
              label: "Driveable (mi)",
              data: driveable,
              backgroundColor: "#607d8b",
              borderColor: "#37474f",
              borderWidth: 1,
            },
            {
              label: "% Covered",
              data: coveragePct,
              type: "line",
              yAxisID: "y1",
              borderColor: "#ffb300",
              backgroundColor: "#ffb30044",
              fill: false,
              tension: 0.2,
              pointRadius: 3,
              pointBackgroundColor: "#ffb300",
              pointBorderColor: "#ffb300",
              order: 2,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "top", labels: { color: "#fff" } },
            tooltip: {
              callbacks: {
                label: function (context) {
                  if (context.dataset.label === "% Covered") {
                    return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`;
                  } else {
                    return `${context.dataset.label}: ${context.parsed.y.toFixed(2)} mi`;
                  }
                },
              },
            },
          },
          scales: {
            x: {
              ticks: { color: "#fff" },
              grid: { color: "rgba(255,255,255,0.1)" },
            },
            y: {
              beginAtZero: true,
              title: { display: true, text: "Distance (mi)", color: "#fff" },
              ticks: { color: "#fff" },
              grid: { color: "rgba(255,255,255,0.1)" },
            },
            y1: {
              beginAtZero: true,
              position: "right",
              title: { display: true, text: "% Covered", color: "#ffb300" },
              ticks: { color: "#ffb300" },
              grid: { drawOnChartArea: false },
              min: 0,
              max: 100,
            },
          },
        },
      });
    }

    // --- FIX: Add missing addCoverageSummary method ---
    addCoverageSummary(coverage) {
      // Remove previous summary control if present
      if (
        this.coverageSummaryControl &&
        this.coverageMap &&
        this.coverageMap._controls
      ) {
        this.coverageMap._controls = this.coverageMap._controls.filter(
          (ctrl) => ctrl !== this.coverageSummaryControl,
        );
        if (this.coverageSummaryControl._container) {
          this.coverageSummaryControl._container.remove();
        }
        this.coverageSummaryControl = null;
      }
      if (!coverage) return;
      // Create a custom control for summary
      const controlDiv = document.createElement("div");
      controlDiv.className = "coverage-summary-control";
      controlDiv.innerHTML = `
        <div class="summary-title">Coverage</div>
        <div class="summary-percentage">${coverage.coverage_percentage?.toFixed(1) || 0}%</div>
        <div class="summary-progress">
          <div class="progress" style="height: 8px;">
            <div class="progress-bar bg-success" role="progressbar" style="width: ${coverage.coverage_percentage?.toFixed(1) || 0}%"></div>
          </div>
        </div>
        <div class="summary-details">
          <div>Total: ${CoverageManager.distanceInUserUnits(coverage.total_length || 0)}</div>
          <div>Driven: ${CoverageManager.distanceInUserUnits(coverage.driven_length || 0)}</div>
        </div>
      `;
      // Add to map as a custom control
      this.coverageSummaryControl = {
        onAdd: () => controlDiv,
        onRemove: () => controlDiv.remove(),
        getDefaultPosition: () => "top-left",
      };
      if (this.coverageMap && this.coverageMap.addControl) {
        this.coverageMap.addControl(this.coverageSummaryControl, "top-left");
      }
    }

    // --- FIX: Update exportCoverageMap to use html2canvas for full map export ---
    exportCoverageMap() {
      const mapContainer = document.getElementById("coverage-map");
      if (!this.coverageMap || !mapContainer) {
        this.notificationManager.show(
          "Map is not ready for export.",
          "warning",
        );
        return;
      }
      // Dynamically load html2canvas if not present
      const doExport = () => {
        // Add a short delay to allow the map to fully render
        setTimeout(() => {
          html2canvas(mapContainer, {
            useCORS: true,
            backgroundColor: null, // Use null for transparency if map has it
            logging: false,
            allowTaint: true, // Necessary for external tile sources
            width: mapContainer.offsetWidth,
            height: mapContainer.offsetHeight,
            windowWidth: mapContainer.scrollWidth,
            windowHeight: mapContainer.scrollHeight,
            // Ensure map controls are captured (might need specific selectors if nested)
            ignoreElements: (element) => false, // Attempt to capture everything
          })
            .then((canvas) => {
              canvas.toBlob((blob) => {
                if (!blob) {
                  this.notificationManager.show(
                    "Failed to create image blob for export.",
                    "danger",
                  );
                  return;
                }
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "coverage-map.png";
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }, 100);
              }, "image/png");
            })
            .catch((error) => {
              console.error("html2canvas export error:", error);
              this.notificationManager.show(
                `Map export failed: ${error.message}`,
                "danger",
              );
            });
        }, 500); // 500ms delay before capture
      };
      if (typeof html2canvas === "undefined") {
        const script = document.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
        // --- FIX: Correct the integrity hash ---
        script.integrity =
          "sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs="; // Corrected hash from browser error
        script.crossOrigin = "anonymous";
        script.onload = doExport;
        script.onerror = () => {
          this.notificationManager.show(
            "Failed to load html2canvas library for export.",
            "danger",
          );
        };
        document.body.appendChild(script);
      } else {
        doExport();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (typeof L === "undefined" || typeof Chart === "undefined") {
      const errorMessage =
        "Error: Required libraries (Leaflet, Chart.js) failed to load. Map and chart functionality will be unavailable.";
      const errorContainer = document.getElementById("alerts-container");
      if (errorContainer) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "alert alert-danger";
        errorDiv.textContent = errorMessage;
        errorContainer.prepend(errorDiv);
      } else {
        window.notificationManager.show(errorMessage, "danger");
      }
      return;
    }

    window.coverageManager = new CoverageManager();
  });
})();
