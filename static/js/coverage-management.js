/* eslint-disable complexity */
/* global bootstrap, Chart, mapboxgl, html2canvas, $*/
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
  // Removed Leaflet-specific CSS
  style.textContent = `
    .activity-indicator.pulsing { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    .detailed-stage-info { font-style: italic; color: #adb5bd; font-size: 0.9em; margin-top: 5px; }
    .stats-info { font-size: 0.9em; }
    .stats-info small { color: #ced4da; }
    .stats-info .text-info { color: #3db9d5 !important; }
    .stats-info .text-success { color: #4caf50 !important; }
    .stats-info .text-primary { color: #59a6ff !important; }

    .map-info-panel { position: absolute; top: 10px; left: 10px; z-index: 1000; background: rgba(40, 40, 40, 0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); max-width: 250px; border-left: 3px solid #007bff; display: none; }
    .map-info-panel strong { color: #fff; }
    .map-info-panel .text-success { color: #4caf50 !important; }
    .map-info-panel .text-danger { color: #ff5252 !important; }
    .map-info-panel .text-info { color: #17a2b8 !important; }
    .map-info-panel .text-warning { color: #ffc107 !important; }
    .map-info-panel .text-muted { color: #adb5bd !important; }
    .map-info-panel hr.panel-divider { border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 5px 0; }

    .coverage-summary-control { background: rgba(40, 40, 40, 0.9); color: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1) !important; min-width: 150px; }
    .summary-title { font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #ccc; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-percentage { font-size: 24px; font-weight: bold; margin-bottom: 5px; color: #fff; }
    .summary-progress { margin-bottom: 8px; }
    .summary-details { font-size: 11px; color: #ccc; text-align: right; }
  `;
  if (!document.getElementById(style.id)) {
    document.head.appendChild(style);
  }
})();

(() => {
  class CoverageManager {
    constructor() {
      this.map = null; // General map reference (if needed elsewhere, maybe remove)
      this.coverageMap = null; // Specific map instance for this page
      // Removed Leaflet-specific variables: streetLayers, streetsGeoJsonLayer, highlightedLayer, hoverHighlightLayer
      this.streetsGeoJson = null;
      this.mapBounds = null;

      this.selectedLocation = null; // Holds the full data of the currently displayed area
      this.currentDashboardLocationId = null; // Add this line
      this.currentProcessingLocation = null; // Holds location data during processing modal display
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.progressTimer = null;
      this.activeTaskIds = new Set();
      this.currentTaskId = null; // Unified task identifier
      this.validatedLocation = null; // Holds validated location from the "Add Area" form
      this.currentFilter = "all"; // Map filter state ('all', 'driven', 'undriven')
      this.lastActivityTime = null; // For modal activity indicator
      this.showTripsActive = false; // State for trip overlay toggle
      this.loadTripsDebounceTimer = null; // Timer for debouncing trip loads on map move

      this.tooltips = []; // To manage Bootstrap tooltips
      this.mapInfoPanel = null; // DOM element for hover info
      this.coverageSummaryControl = null; // Mapbox custom control for summary
      this.streetTypeChartInstance = null; // Chart.js instance

      this.notificationManager = window.notificationManager || {
        show: (message, type) => {
          console.log(`[${type || "info"}] Notification: ${message}`);
        },
      };
      this.confirmationDialog = window.confirmationDialog || {
        show: (options) => {
          console.warn(
            "ConfirmationDialog fallback used. Ensure utils.js loads before coverage-management.js.",
            options,
          );
          // Simulate user confirming for testing purposes if needed,
          // but default to false for safety.
          // return Promise.resolve(window.confirm(options.message));
          return Promise.resolve(false);
        },
      };

      this.setupAutoRefresh();
      this.checkForInterruptedTasks();
      CoverageManager.setupConnectionMonitoring();
      this.initTooltips();
      this.createMapInfoPanel(); // Create panel structure on init
      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    static distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      // Assuming miles for now
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
              statusBar.remove(); // Fallback removal
            }
          }, 5000);
        }
      };

      window.addEventListener("online", handleConnectionChange);
      window.addEventListener("offline", handleConnectionChange);
      handleConnectionChange(); // Initial check
    }

    initTooltips() {
      // Dispose existing tooltips first
      this.tooltips.forEach((tooltip) => {
        if (tooltip && typeof tooltip.dispose === "function") {
          tooltip.dispose();
        }
      });
      this.tooltips = [];

      // Initialize new tooltips
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

        // Only refresh if something is actively processing OR the modal is shown
        if (isProcessingRow || isModalProcessing) {
          await this.loadCoverageAreas();
        }
      }, 10000); // Check every 10 seconds
    }

    setupEventListeners() {
      document
        .getElementById("validate-location")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.validateLocation();
        });

      document
        .getElementById("add-coverage-area")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.addCoverageArea();
        });

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
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.cancelProcessing(this.currentProcessingLocation);
        });

      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          // When modal is hidden, clear the context unless it was canceled/errored
          if (
            this.currentProcessingLocation &&
            this.currentProcessingLocation.status !== STATUS.CANCELED &&
            this.currentProcessingLocation.status !== STATUS.ERROR
          ) {
            // Maybe refresh table one last time
            this.loadCoverageAreas();
          }
          this.clearProcessingContext();
        });

      // Save state before unload if processing
      window.addEventListener("beforeunload", () => {
        if (this.currentProcessingLocation) {
          this.saveProcessingState();
        }
      });

      // Event delegation for table actions
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          const targetButton = e.target.closest("button[data-action]");
          const targetLink = e.target.closest("a.location-name-link");

          if (targetButton) {
            e.preventDefault();
            const action = targetButton.dataset.action;
            const locationId = targetButton.dataset.locationId;
            const locationStr = targetButton.dataset.location; // For delete/cancel

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
                // Use JSON.parse cautiously
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

      // Event delegation for dashboard controls
      document.addEventListener("click", (e) => {
        // Handle "Update Now" button in alert messages
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          const locationId = updateMissingDataBtn.dataset.locationId;
          if (locationId) {
            this.updateCoverageForArea(locationId, "full"); // Default to full update
          } else {
            this.notificationManager.show(
              "Failed to initiate update: Missing location ID.",
              "danger",
            );
          }
        }

        // Handle map filter buttons
        const filterButton = e.target.closest(
          ".map-controls button[data-filter]",
        );
        if (filterButton) {
          this.setMapFilter(filterButton.dataset.filter);
        }

        // Handle map export button
        const exportButton = e.target.closest("#export-coverage-map");
        if (exportButton) {
          this.exportCoverageMap();
        }

        // Handle trip overlay toggle
        const tripToggle = e.target.closest("#toggle-trip-overlay");
        if (tripToggle) {
          this.showTripsActive = tripToggle.checked;
          if (this.showTripsActive) {
            this.setupTripLayers(); // Ensure layers exist
            this.loadTripsForView(); // Load trips for current view
          } else {
            this.clearTripOverlay(); // Clear trips if toggled off
          }
        }
      });

      // Add listener for map movement to reload trips (debounced)
      if (this.coverageMap) {
        this.coverageMap.on("moveend", () => {
          if (this.showTripsActive) {
            clearTimeout(this.loadTripsDebounceTimer);
            this.loadTripsDebounceTimer = setTimeout(() => {
              this.loadTripsForView();
            }, 500); // Debounce time in ms
          }
        });
      }
    }

    checkForInterruptedTasks() {
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          // Check if saved state is reasonably recent (e.g., within 1 hour)
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

            // Show notification to user
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
              .addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                this.resumeInterruptedTask(progressData);
              });
            notification
              .querySelector(".discard-task")
              .addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                localStorage.removeItem("coverageProcessingState");
              });

            document.querySelector("#alerts-container")?.prepend(notification);
          } else {
            // Saved state is too old, discard it
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
      this.currentTaskId = taskId;
      this.showProgressModal(
        `Checking status for ${location.display_name}...`,
        savedData.progress || 0,
      );
      this.activeTaskIds.add(taskId);

      // Start polling
      this.pollCoverageProgress(taskId)
        .then(async (finalData) => {
          // Handle completion (success or expected error like 'canceled')
          if (finalData?.stage !== STATUS.ERROR) {
            this.notificationManager.show(
              `Task for ${location.display_name} completed.`,
              "success",
            );
          }
          // Refresh UI regardless of outcome
          await this.loadCoverageAreas();
          // If the resumed task was for the currently displayed dashboard, refresh it
          if (this.selectedLocation?._id === location._id) {
            await this.displayCoverageDashboard(this.selectedLocation._id);
          }
        })
        .catch(async (pollError) => {
          // Handle polling failure (e.g., task not found, network error)
          this.notificationManager.show(
            `Failed to resume task for ${location.display_name}: ${pollError.message || pollError}`,
            "danger",
          );
          await this.loadCoverageAreas(); // Refresh table to show potential error state
        })
        .finally(() => {
          // Cleanup after polling finishes or fails
          this.activeTaskIds.delete(taskId);
          // No need to call hideProgressModal here, it's handled by pollCoverageProgress on completion/error
        });
    }

    saveProcessingState() {
      if (this.currentProcessingLocation && this.currentTaskId) {
        const progressBar = document.querySelector(
          "#taskProgressModal .progress-bar",
        );
        const progressMessageEl = document.querySelector(
          "#taskProgressModal .progress-message",
        );
        const saveData = {
          location: this.currentProcessingLocation,
          taskId: this.currentTaskId,
          stage: progressMessageEl?.dataset.stage || STATUS.UNKNOWN,
          progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0"),
          timestamp: new Date().toISOString(),
        };
        localStorage.setItem(
          "coverageProcessingState",
          JSON.stringify(saveData),
        );
      } else {
        // Clear state if no longer processing
        localStorage.removeItem("coverageProcessingState");
      }
    }

    clearProcessingContext() {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      localStorage.removeItem("coverageProcessingState");
      // Remove the specific listener added during processing start
      window.removeEventListener("beforeunload", this.saveProcessingState);

      // Reset state variables
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.currentTaskId = null; // Ensure task_id is cleared
      this.lastActivityTime = null;
      // Do NOT clear activeTaskIds here, polling might still be needed for resumed tasks
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

      // Reset state
      locationInputEl.classList.remove("is-invalid", "is-valid");
      addButton.disabled = true;
      this.validatedLocation = null;

      if (!locationInput) {
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show("Please enter a location.", "warning");
        return;
      }
      if (!locType) {
        // Should not happen with default select, but good practice
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

        // Check for essential fields in the response
        if (!data || !data.osm_id || !data.display_name) {
          locationInputEl.classList.add("is-invalid");
          this.notificationManager.show(
            "Location not found or invalid response. Check input.",
            "warning",
          );
        } else {
          locationInputEl.classList.add("is-valid");
          this.validatedLocation = data; // Store the validated data
          addButton.disabled = false; // Enable the add button
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

      const locationToAdd = { ...this.validatedLocation }; // Use the validated data

      try {
        // Check if area already exists (optional but good practice)
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
          // Re-enable validate button potentially? Or just leave add disabled.
          return; // Stop processing
        }

        // Set context for processing modal and state saving
        this.currentProcessingLocation = locationToAdd;
        this.currentTaskId = null; // Task ID will come from the backend response
        this.showProgressModal(
          `Starting processing for ${locationToAdd.display_name}...`,
          0,
        );
        // Add unload listener *before* making the request
        window.addEventListener("beforeunload", this.saveProcessingState);

        // Make the API call to start preprocessing
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToAdd), // Send validated data
        });

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal(); // Hide modal on immediate failure
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`,
          );
        }

        this.notificationManager.show(
          "Coverage area processing started.",
          "info",
        );

        // If successful, start polling using the returned task_id
        if (taskData?.task_id) {
          this.currentTaskId = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState(); // Save state now that we have a task ID
          await this.pollCoverageProgress(taskData.task_id);
          // Polling handles modal hiding on completion/error
          this.notificationManager.show(
            `Processing for ${locationToAdd.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas(); // Refresh table
        } else {
          // Handle case where backend starts but doesn't return task_id (shouldn't happen ideally)
          this.hideProgressModal();
          this.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas(); // Refresh table anyway
        }

        // Clear the input form after successful start
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
        this.hideProgressModal(); // Ensure modal is hidden on error
        await this.loadCoverageAreas(); // Refresh table to show original state
      } finally {
        // Reset the add button state (it should remain disabled until next validation)
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

      // Fetch the latest location data first to ensure we have the correct details
      let locationData = null;
      try {
        const response = await fetch(`/api/coverage_areas/${locationId}`); // Use detail endpoint
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

      // Prevent starting if already processing this location
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
        ); // Re-show modal if hidden
        return;
      }

      const processingLocation = { ...locationData }; // Use fetched data

      try {
        this.currentProcessingLocation = processingLocation;
        this.currentTaskId = null; // Will be set by the response
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id === locationId; // Check if the dashboard is showing this location

        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${processingLocation.display_name}...`,
        );
        window.addEventListener("beforeunload", this.saveProcessingState); // Add listener

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";

        // The backend expects the LocationModel structure
        const payload = { ...processingLocation }; // Send the full location object

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          // Handle potential validation errors (422) specifically
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
          this.currentTaskId = data.task_id;
          this.activeTaskIds.add(data.task_id);
          this.saveProcessingState(); // Save state with task ID
          await this.pollCoverageProgress(data.task_id);
          // Polling handles modal hiding
          this.notificationManager.show(
            `Coverage update for ${processingLocation.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas(); // Refresh table
          // If the dashboard was showing this location, refresh it
          if (isUpdatingDisplayedLocation) {
            await this.displayCoverageDashboard(locationId);
          }
        } else {
          this.hideProgressModal();
          this.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas(); // Refresh table
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        this.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
        this.hideProgressModal(); // Ensure modal is hidden on error
        await this.loadCoverageAreas(); // Refresh table
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
        // Backend expects just the display_name for cancellation
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

        // If the currently processing location was canceled, clear the context
        if (
          this.currentProcessingLocation?.display_name ===
          locationToCancel.display_name
        ) {
          // Mark the task as inactive *before* hiding the modal
          if (this.currentTaskId) {
            this.activeTaskIds.delete(this.currentTaskId);
          }
          this.hideProgressModal(); // This also clears the context
        }
        await this.loadCoverageAreas(); // Refresh the table to show the canceled state
      } catch (error) {
        console.error("Error cancelling processing:", error);
        this.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
      } finally {
        // No need for specific cleanup here as hideProgressModal handles it
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

        // Backend expects display_name for deletion
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

        // Refresh the table
        await this.loadCoverageAreas();

        // If the deleted area was displayed in the dashboard, hide it
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
          this.clearDashboardUI(); // Clear stats, chart etc.
        }

        this.notificationManager.show(
          `Coverage area '${location.display_name}' deleted.`,
          "success",
        );
      } catch (error) {
        console.error("Error deleting coverage area:", error);
        // Attempt to parse detailed error message from response if possible
        let detailMessage = error.message;
        // Check if the error object might contain response details (e.g., from fetch failure)
        const errorResponse = error.cause || error; // Check cause first if available

        try {
          // Check if it looks like a Response object or has similar properties
          if (errorResponse && typeof errorResponse.json === "function") {
            const errorData = await errorResponse.json();
            if (errorData?.detail) {
              // Handle FastAPI validation errors or simple detail strings
              if (Array.isArray(errorData.detail)) {
                detailMessage = errorData.detail
                  .map((err) => `${err.loc?.join(".") || "field"}: ${err.msg}`)
                  .join("; ");
              } else {
                detailMessage = errorData.detail;
              }
            }
          } else if (error.message.includes("Failed to fetch")) {
            // Generic network error
            detailMessage = "Network error or failed to connect to the server.";
          } else {
            // Fallback to the basic error message
            detailMessage = error.message || "An unknown error occurred.";
          }
        } catch (parseError) {
          // If parsing the error response fails
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
            // Try to get more detail from the response body
            errorDetail = (await response.json()).detail || errorDetail;
          } catch (e) {
            /* ignore json parsing error */
          }
          throw new Error(`Failed to fetch coverage areas (${errorDetail})`);
        }

        const data = await response.json();
        if (!data.success)
          throw new Error(data.error || "API returned failure");

        CoverageManager.updateCoverageTable(data.areas, this); // Pass instance `this`
        CoverageManager.enhanceResponsiveTables(); // Make table responsive
        this.initTooltips(); // Re-initialize tooltips for new buttons

        // --- DataTables Sorting Integration ---
        if (window.$ && $.fn.DataTable) {
          const table = $("#coverage-areas-table");
          if ($.fn.DataTable.isDataTable(table)) {
            table.DataTable().destroy();
          }
          table.DataTable({
            order: [[0, "asc"]], // Default sort by Location ascending
            paging: false,
            searching: false,
            info: false,
            responsive: true,
            autoWidth: false,
            columnDefs: [
              { orderable: false, targets: 6 }, // Actions column not sortable
            ],
            language: {
              emptyTable: "No coverage areas defined yet.",
            },
          });
        }
        // --- End DataTables Sorting ---
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
      const maxRetries = 360; // ~30 minutes (360 * 5s)
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;
      const pollingStartTime = Date.now();

      while (retries < maxRetries) {
        // Check if cancellation was requested externally (e.g., user clicked cancel)
        if (!this.activeTaskIds.has(taskId)) {
          this.notificationManager.show(
            `Polling stopped for task ${taskId.substring(0, 8)}...`,
            "info",
          );
          throw new Error("Polling canceled");
        }

        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);

          if (response.status === 404) {
            // Task might be old, completed long ago, or invalid
            throw new Error("Task not found (expired or invalid).");
          }
          if (!response.ok) {
            let errorDetail = `HTTP error ${response.status}`;
            try {
              errorDetail = (await response.json()).detail || errorDetail;
            } catch (e) {
              /* ignore json parsing error */
            }
            throw new Error(`Failed to get task status: ${errorDetail}`);
          }

          let data = null;
          try {
            data = await response.json();
            // Basic validation of the response structure
            if (!data || typeof data !== "object" || !data.stage) {
              // Log unexpected success response structure
              if (response.ok) {
                this.notificationManager.show(
                  `Task ${taskId.substring(0, 8)}...: Received incomplete/invalid data structure despite HTTP OK status.`,
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

          // Update modal UI
          this.updateModalContent(data);
          CoverageManager.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date(); // Update activity time on successful poll
          this.saveProcessingState(); // Save the latest progress

          // Check for terminal states
          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            this.updateModalContent({ ...data, progress: 100 }); // Ensure 100% on complete
            CoverageManager.updateStepIndicators(STATUS.COMPLETE, 100);
            this.activeTaskIds.delete(taskId);
            this.hideProgressModal(); // Hide modal on success
            return data; // Resolve the promise with final data
          } else if (data.stage === STATUS.ERROR) {
            const errorMessage = data.error || data.message || "Unknown error";
            this.notificationManager.show(
              `Task ${taskId.substring(0, 8)}... failed with error: ${errorMessage}`,
              "danger",
            );
            this.activeTaskIds.delete(taskId);
            // Don't hide modal immediately on error, let user see the message
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            ); // Reject the promise
          } else if (data.stage === STATUS.CANCELED) {
            this.notificationManager.show(
              `Task ${taskId.substring(0, 8)}... was canceled.`,
              "warning",
            );
            this.activeTaskIds.delete(taskId);
            this.hideProgressModal(); // Hide modal on cancel
            throw new Error("Task was canceled"); // Reject the promise
          }

          // Check for stalled progress
          if (data.stage === lastStage) {
            consecutiveSameStage++;
            // Notify if stalled for ~1 minute (12 * 5s)
            if (consecutiveSameStage > 12) {
              this.notificationManager.show(
                `Task ${taskId.substring(0, 8)}... seems stalled at stage: ${data.stage}`,
                "warning",
              );
              consecutiveSameStage = 0; // Reset counter after warning
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 5000)); // 5-second interval
          retries++;
        } catch (error) {
          // Handle errors during polling (network, 404, 500, parsing, etc.)
          this.notificationManager.show(
            `Error polling coverage progress for task ${taskId.substring(0, 8)}...: ${error.message}`,
            "danger",
          );
          // Update modal to show error state
          this.updateModalContent({
            stage: STATUS.ERROR,
            progress: this.currentProcessingLocation?.progress || 0, // Use last known progress
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {}, // Clear metrics on error
          });
          CoverageManager.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId);
          // Don't hide modal on polling error
          throw error; // Reject the promise
        }
      }

      // If loop finishes without reaching a terminal state
      this.notificationManager.show(
        `Polling for task ${taskId.substring(0, 8)}... timed out after ${(maxRetries * 5) / 60} minutes.`,
        "danger",
      );
      this.updateModalContent({
        stage: STATUS.ERROR,
        progress: this.currentProcessingLocation?.progress || 99, // Show near complete but errored
        message: "Polling timed out waiting for completion.",
        error: "Polling timed out",
        metrics: {},
      });
      CoverageManager.updateStepIndicators(
        STATUS.ERROR,
        this.currentProcessingLocation?.progress || 99,
      );
      this.activeTaskIds.delete(taskId);
      // Don't hide modal on timeout
      throw new Error("Coverage calculation polling timed out");
    }

    static updateCoverageTable(areas, instance) {
      // instance is the CoverageManager instance
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = ""; // Clear existing rows

      if (!areas || areas.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="7" class="text-center fst-italic text-muted py-4">No coverage areas defined yet.</td></tr>';
        return;
      }

      // Sort areas alphabetically by display name
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

        // Add class for styling processing rows
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
        const lastUpdatedOrder = area.last_updated
          ? new Date(area.last_updated).getTime()
          : 0;
        const totalLengthMiles = CoverageManager.distanceInUserUnits(
          area.total_length,
        );
        const drivenLengthMiles = CoverageManager.distanceInUserUnits(
          area.driven_length,
        );
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0";

        // Determine progress bar color based on coverage percentage and status
        let progressBarColor = "bg-success"; // Default green
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if (area.coverage_percentage < 25) progressBarColor = "bg-danger";
        else if (area.coverage_percentage < 75) progressBarColor = "bg-warning";

        // Prepare location data for buttons (ensure it's valid JSON string)
        // Only need display_name for delete/cancel based on backend API
        const locationButtonData = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;"); // Escape single quotes for HTML attribute
        const locationId = area._id; // Use _id for update actions

        row.innerHTML = `
          <td data-label="Location">
            <a href="#" class="location-name-link text-info fw-bold" data-location-id="${locationId}">
              ${area.location?.display_name || "Unknown Location"}
            </a>
            ${hasError ? `<div class="text-danger small" title="${area.last_error || ""}"><i class="fas fa-exclamation-circle me-1"></i>Error</div>` : ""}
            ${isCanceled ? '<div class="text-warning small"><i class="fas fa-ban me-1"></i>Canceled</div>' : ""}
            ${isProcessing ? `<div class="text-primary small"><i class="fas fa-spinner fa-spin me-1"></i>${CoverageManager.formatStageName(status)}...</div>` : ""}
          </td>
          <td data-label="Total Length" class="text-end" data-order="${parseFloat(area.total_length || 0) * 0.000621371}">${totalLengthMiles}</td>
          <td data-label="Driven Length" class="text-end" data-order="${parseFloat(area.driven_length || 0) * 0.000621371}">${drivenLengthMiles}</td>
          <td data-label="Coverage" data-order="${parseFloat(area.coverage_percentage || 0)}">
            <div class="progress" style="height: 20px;" title="${coveragePercentage}%">
              <div class="progress-bar ${progressBarColor}" role="progressbar"
                   style="width: ${coveragePercentage}%;"
                   aria-valuenow="${coveragePercentage}"
                   aria-valuemin="0" aria-valuemax="100">
                ${coveragePercentage}%
              </div>
            </div>
          </td>
          <td data-label="Segments" class="text-end" data-order="${parseInt(area.total_segments || 0, 10)}">${area.total_segments?.toLocaleString() || 0}</td>
          <td data-label="Last Updated" data-order="${lastUpdatedOrder}">${lastUpdated}</td>
          <td data-label="Actions">
            <div class="btn-group" role="group">
              <button class="btn btn-sm btn-success" data-action="update-full" data-location-id="${locationId}" title="Full Update (Recalculate All)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-sync-alt"></i>
              </button>
              <button class="btn btn-sm btn-info" data-action="update-incremental" data-location-id="${locationId}" title="Quick Update (New Trips Only)" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-bolt"></i>
              </button>
              <button class="btn btn-sm btn-danger" data-action="delete" data-location='${locationButtonData}' title="Delete Area" ${isProcessing ? "disabled" : ""} data-bs-toggle="tooltip">
                <i class="fas fa-trash-alt"></i>
              </button>
              ${isProcessing ? `<button class="btn btn-sm btn-warning" data-action="cancel" data-location='${locationButtonData}' title="Cancel Processing" data-bs-toggle="tooltip"><i class="fas fa-stop-circle"></i></button>` : ""}
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

      // Set initial modal state
      if (modalTitle)
        modalTitle.textContent = this.currentProcessingLocation?.display_name
          ? `Processing: ${this.currentProcessingLocation.display_name}`
          : "Processing Coverage";
      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        // Start with animated primary bar
        modalProgressBar.className =
          "progress-bar progress-bar-striped progress-bar-animated bg-primary";
      }
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.className = "progress-message"; // Reset text color class
        progressMessage.removeAttribute("data-stage"); // Clear stage data attribute initially
      }
      // Clear dynamic content areas
      progressDetails.querySelector(".stage-info").innerHTML = "";
      progressDetails.querySelector(".stats-info").innerHTML = "";
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = "";

      // Ensure cancel button is enabled initially
      if (cancelBtn) cancelBtn.disabled = false;

      // Start or restart the timer
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.processingStartTime = Date.now();
      this.lastActivityTime = Date.now(); // Set initial activity time
      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();
        this.updateActivityIndicator(); // Update activity based on lastActivityTime
      }, 1000);
      this.updateTimingInfo(); // Initial call
      this.updateActivityIndicator(); // Initial call

      // Show the modal
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static", // Prevent closing by clicking outside
        keyboard: false, // Prevent closing with Esc key
      });
      bsModal.show();
    }

    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;
      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) {
        modal.hide(); // Use Bootstrap's hide method
      } else {
        // Fallback if instance not found (shouldn't happen with getOrCreateInstance)
        modalElement.style.display = "none";
        modalElement.classList.remove("show");
        document.body.classList.remove("modal-open");
        const backdrop = document.querySelector(".modal-backdrop");
        if (backdrop) backdrop.remove();
      }
      // Important: Clear context AFTER modal is hidden (or during hidden.bs.modal event)
      // this.clearProcessingContext(); // Moved to hidden.bs.modal listener
    }

    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      // Only update if the modal is actually for the current processing context
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

      // Update Progress Bar
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        // Update bar style based on stage
        progressBar.className = "progress-bar"; // Reset classes
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

      // Update Progress Message
      if (progressMessageEl) {
        progressMessageEl.textContent = error ? `Error: ${error}` : message;
        progressMessageEl.dataset.stage = stage; // Store current stage
        // Update text color based on stage
        progressMessageEl.className = "progress-message text-center mb-2"; // Reset classes
        if (stage === STATUS.ERROR)
          progressMessageEl.classList.add("text-danger");
        if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED)
          progressMessageEl.classList.add("text-success");
      }

      // Update Stage Indicator
      if (stageInfoEl) {
        const stageName = CoverageManager.formatStageName(stage);
        const stageIcon = CoverageManager.getStageIcon(stage);
        stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
        stageInfoEl.className = `stage-info mb-2 text-${CoverageManager.getStageTextClass(stage)}`;
      }

      // Update Stats Display
      if (statsInfoEl) {
        statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
      }

      // Enable/Disable Cancel Button
      if (cancelBtn) {
        cancelBtn.disabled = [
          STATUS.COMPLETE,
          STATUS.COMPLETED,
          STATUS.ERROR,
          STATUS.CANCELED,
        ].includes(stage);
      }

      // Stop timer and activity indicator on terminal states
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
          this.updateTimingInfo(); // Final update
          const estimatedTimeEl = modalElement.querySelector(".estimated-time");
          if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Clear estimate
        }
        this.updateActivityIndicator(false); // Mark as inactive
      } else {
        // Ensure timer is running if not in terminal state
        if (!this.progressTimer) {
          this.processingStartTime =
            Date.now() - (this.lastProgressUpdate?.elapsedMs || 0); // Estimate start time if restarting timer
          this.progressTimer = setInterval(() => {
            this.updateTimingInfo();
            this.updateActivityIndicator();
          }, 1000);
        }
        this.updateActivityIndicator(true); // Mark as active
      }
      // Store last update for potential restart
      this.lastProgressUpdate = {
        stage,
        progress,
        elapsedMs: Date.now() - (this.processingStartTime || Date.now()),
      };
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

      // Reset all steps first
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

      // Determine state based on current stage
      if (stage === STATUS.ERROR) {
        // Mark steps up to the point of failure as complete/error
        if ([STATUS.INITIALIZING].includes(stage) || progress < 5) {
          markError("initializing");
        } else if (
          [STATUS.PREPROCESSING, STATUS.LOADING_STREETS].includes(stage) ||
          progress < 50 // Assuming preprocessing/loading happens before 50%
        ) {
          markComplete("initializing");
          markError("preprocessing");
        } else if ([STATUS.INDEXING].includes(stage) || progress < 60) {
          // Assuming indexing before 60%
          markComplete("initializing");
          markComplete("preprocessing");
          markError("indexing");
        } else if (
          [
            STATUS.PROCESSING_TRIPS,
            STATUS.CALCULATING,
            STATUS.COUNTING_TRIPS,
          ].includes(stage) ||
          progress < 90 // Assuming calculation before 90%
        ) {
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markError("calculating");
        } else {
          // Error occurred during finalization/completion stages
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markComplete("calculating");
          markError("complete");
        }
      } else if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
        Object.keys(steps).forEach(markComplete); // All steps complete
      } else {
        // Mark steps as complete/active based on progress
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
          markActive("complete"); // Mark final step as active during these stages
        } else {
          // Default to initializing if stage is unknown but not error/complete
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
      ); // Placeholder for future estimation logic

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      // Clear or update estimated time if logic is added
      if (estimatedTimeEl) {
        estimatedTimeEl.textContent = ""; // Currently no estimation logic
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
        // Explicitly set state if provided
        currentlyActive = isActive;
      } else {
        // Determine activity based on last update time (e.g., within 10 seconds)
        currentlyActive =
          this.lastActivityTime && now - this.lastActivityTime < 10000;
      }

      // Update indicator icon and text
      if (currentlyActive) {
        activityIndicator.classList.add("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
      } else {
        activityIndicator.classList.remove("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle';
      }

      // Update last update time text
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

      let statsHtml = '<div class="mt-1 stats-info">'; // Use stats-info class

      // Helper to add a stat line
      const addStat = (
        label,
        value,
        unit = "",
        icon = null,
        colorClass = "text-primary", // Default color
      ) => {
        if (value !== undefined && value !== null && value !== "") {
          const iconHtml = icon ? `<i class="${icon} me-1"></i>` : "";
          // Format numbers with commas for readability
          const displayValue =
            typeof value === "number" ? value.toLocaleString() : value;
          statsHtml += `
            <div class="d-flex justify-content-between">
              <small>${iconHtml}${label}:</small>
              <small class="${colorClass}">${displayValue}${unit}</small>
            </div>`;
        }
      };

      // Display stats relevant to the current stage
      if (
        [
          STATUS.INDEXING,
          STATUS.PREPROCESSING,
          STATUS.LOADING_STREETS,
        ].includes(stage)
      ) {
        addStat(
          "Streets Found",
          metrics.total_segments,
          "",
          "fas fa-road",
          "text-info",
        );
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
        addStat(
          "Initial Driven",
          metrics.initial_covered_segments,
          " segs",
          "fas fa-flag-checkered",
          "text-success",
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
          `${processed.toLocaleString()}/${total.toLocaleString()} (${tripsProgress}%)`,
          "",
          "fas fa-route",
          "text-info",
        );
        addStat(
          "New Segments Found",
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
          "text-success",
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
        addStat(
          "Total Segments",
          metrics.total_segments,
          "",
          "fas fa-road",
          "text-info",
        );
        addStat(
          "Segments Covered",
          metrics.total_covered_segments || metrics.covered_segments, // Use alias if needed
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
        // Default message if stage doesn't match known phases with metrics
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

      // Ensure all required elements exist
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

      // Show dashboard and loading indicators
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

      // Scroll to dashboard
      dashboardContainer.scrollIntoView({ behavior: "smooth", block: "start" });

      try {
        // Fetch detailed data for the specific location
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            errorDetail = (await response.json()).detail || errorDetail;
          } catch (e) {
            /* ignore json parsing error */
          }
          throw new Error(`Failed to load coverage data (${errorDetail})`);
        }

        const data = await response.json();
        if (!data.success || !data.coverage) {
          throw new Error(
            data.error || "Failed to load coverage data from API",
          );
        }

        this.selectedLocation = data.coverage; // Store the full coverage data
        this.currentDashboardLocationId = locationId; // <--- ADD THIS LINE
        const coverage = data.coverage;

        const locationName = coverage.location_name || "Coverage Details";
        dashboardLocationName.textContent = locationName;

        // Update the stats panel first
        this.updateDashboardStats(coverage);

        // Determine if map data is available and valid
        const hasStreetData = coverage.streets_geojson?.features?.length > 0;
        const needsReprocessing = coverage.needs_reprocessing || false; // Check if backend flagged reprocessing need
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

        // Handle cases where map/chart cannot be displayed
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
              locationId, // Pass locationId to allow re-running
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
            // Optionally set a timer to re-check
            setTimeout(() => this.displayCoverageDashboard(locationId), 15000);
          } else if (status === STATUS.COMPLETED && !hasStreetData) {
            // This state means stats are done, but GeoJSON generation might still be running or failed
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Finalizing Map Data",
              "Coverage statistics calculated. Generating detailed map data...",
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Generating chart data...</div>';
            notificationMessage = `Finalizing map data for ${locationName}.`;
            // Re-check shortly
            setTimeout(() => this.displayCoverageDashboard(locationId), 10000);
          } else {
            // Default case: No error, not processing, but no data (needs update)
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Map Data Not Available",
              "Please update the coverage data to generate the map.",
              "warning",
              locationId, // Pass locationId to allow running update
            );
            notificationType = "warning";
            notificationMessage = `Map data needs to be generated for ${locationName}.`;
          }

          mapContainer.innerHTML = statusMessageHtml;
          chartContainer.innerHTML = chartMessageHtml;
          this.notificationManager.show(notificationMessage, notificationType);
        } else {
          // Map data is available - initialize map and chart
          this.notificationManager.show(
            `Loaded coverage map for ${locationName}`,
            "success",
          );

          this.initializeCoverageMap(coverage); // Pass full coverage object
          this.createStreetTypeChart(coverage.street_types);
          this.updateStreetTypeCoverage(coverage.street_types); // Update the list view as well

          // Fit map after initialization (map needs to be loaded)
          // initializeCoverageMap handles fitting internally now
        }

        // Ensure tooltips are initialized for any new buttons (like in alerts)
        this.initTooltips();
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger p-4"><strong>Error:</strong> ${error.message}</div>`;
        chartContainer.innerHTML = ""; // Clear chart area on error
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

      // Log the coverage object to help debug segment counts
      console.log("Coverage object for dashboard stats:", coverage); // <--- ADD THIS LINE

      // Extract data safely, providing defaults
      const totalLengthM = parseFloat(
        coverage.total_length_m ||
          coverage.total_length ||
          coverage.driveable_length_m ||
          0,
      ); // Prefer specific _m field
      const drivenLengthM = parseFloat(
        coverage.driven_length_m ||
          coverage.covered_length_m ||
          coverage.driven_length ||
          0,
      );
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";
      const totalSegments = parseInt(coverage.total_segments || 0, 10);

      // Calculate covered segments from GeoJSON features
      let calculatedCoveredSegments = 0;
      if (
        coverage.streets_geojson &&
        Array.isArray(coverage.streets_geojson.features)
      ) {
        calculatedCoveredSegments = coverage.streets_geojson.features.reduce(
          (count, feature) => {
            if (
              feature &&
              feature.properties &&
              feature.properties.driven === true
            ) {
              return count + 1;
            }
            return count;
          },
          0,
        );
      }
      const coveredSegments = calculatedCoveredSegments;

      const lastUpdated = coverage.last_updated
        ? new Date(coverage.last_updated).toLocaleString()
        : "Never";

      // Determine progress bar color
      let barColor = "bg-success";
      if (
        coverage.status === STATUS.ERROR ||
        coverage.status === STATUS.CANCELED
      )
        barColor = "bg-secondary";
      else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
      else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";

      // Update the HTML
      statsContainer.innerHTML = `
        <div class="progress mb-3" style="height: 25px" title="Overall Coverage: ${coveragePercentage}%">
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
          <small><i class="fas fa-road me-1 text-secondary"></i>Total Segments:</small>
          <small id="dashboard-total-segments">${totalSegments.toLocaleString()}</small>
        </div>
         <div class="d-flex justify-content-between mb-2">
          <small><i class="fas fa-check-circle me-1 text-success"></i>Covered Segments:</small>
          <small id="dashboard-covered-segments">${coveredSegments.toLocaleString()}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small><i class="fas fa-ruler-horizontal me-1 text-secondary"></i>Total Length:</small>
          <small id="dashboard-total-length">${CoverageManager.distanceInUserUnits(totalLengthM)}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small><i class="fas fa-route me-1 text-success"></i>Driven Length:</small>
          <small id="dashboard-driven-length">${CoverageManager.distanceInUserUnits(drivenLengthM)}</small>
        </div>
        <div class="d-flex justify-content-between mb-2">
          <small><i class="fas fa-clock me-1 text-secondary"></i>Last Updated:</small>
          <small id="dashboard-last-updated">${lastUpdated}</small>
        </div>
      `;

      // Update the separate street type list (if data exists)
      this.updateStreetTypeCoverage(coverage.street_types);

      // Update the map summary control if the map exists
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

      // Sort by total length descending
      const sortedTypes = [...streetTypes].sort(
        (a, b) =>
          parseFloat(b.total_length_m || 0) - parseFloat(a.total_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6); // Show top 6 types

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        // Use driveable length for the denominator display if available
        const coveredDist = CoverageManager.distanceInUserUnits(
          parseFloat(type.covered_length_m || 0),
        );
        const totalDist = CoverageManager.distanceInUserUnits(
          parseFloat(
            (type.driveable_length_m !== undefined
              ? type.driveable_length_m
              : type.total_length_m) || 0,
          ), // Prefer driveable, fallback to total
        );
        const denominatorLabel =
          type.driveable_length_m !== undefined ? "Driveable" : "Total";

        let barColor = "bg-success";
        if (parseFloat(type.coverage_percentage || 0) < 25)
          barColor = "bg-danger";
        else if (parseFloat(type.coverage_percentage || 0) < 75)
          barColor = "bg-warning";

        html += `
          <div class="street-type-item mb-2">
            <div class="d-flex justify-content-between mb-1">
              <small><strong>${CoverageManager.formatStreetType(type.type)}</strong></small>
              <small>${coveragePct}% (${coveredDist} / ${totalDist} ${denominatorLabel})</small>
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
      // Reset dashboard elements to initial state
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      document.querySelector(
        ".dashboard-stats-card .stats-container",
      ).innerHTML = ""; // Clear stats
      document.getElementById("street-type-chart").innerHTML = ""; // Clear chart area
      document.getElementById("street-type-coverage").innerHTML = ""; // Clear list

      // Remove map instance and clear container
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = ""; // Clear map container
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }

      // Reset internal state
      this.selectedLocation = null;
      this.streetsGeoJson = null;
      // this.streetsGeoJsonLayer = null; // Removed Leaflet remnant
      // this.highlightedLayer = null; // Removed Leaflet remnant
      // this.hoverHighlightLayer = null; // Removed Leaflet remnant
      this.mapBounds = null;
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }
      this.currentDashboardLocationId = null; // <--- ADD THIS LINE
      // Remove map info panel if it exists
      if (this.mapInfoPanel) {
        this.mapInfoPanel.remove();
        this.mapInfoPanel = null;
      }
      // Remove summary control if it exists
      if (this.coverageSummaryControl && this.coverageMap) {
        try {
          this.coverageMap.removeControl(this.coverageSummaryControl);
        } catch (e) {
          console.warn("Minor error removing summary control:", e);
        }
        this.coverageSummaryControl = null;
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
      // Add button only if locationId is provided and type suggests an action is needed
      const showButton =
        locationId && (type === "danger" || type === "warning");
      const buttonHtml = showButton
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

      // Ensure previous instance is fully removed
      if (this.coverageMap && typeof this.coverageMap.remove === "function") {
        try {
          this.coverageMap.remove();
        } catch (e) {
          console.warn("Error removing previous map instance:", e);
        }
        this.coverageMap = null;
      }
      mapContainer.innerHTML = ""; // Clear container

      // Mapbox GL JS setup
      if (!window.MAPBOX_ACCESS_TOKEN) {
        mapContainer.innerHTML = CoverageManager.createAlertMessage(
          "Mapbox Token Missing",
          "Cannot display map. Please configure Mapbox access token.",
          "danger",
        );
        return;
      }
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

      try {
        this.coverageMap = new mapboxgl.Map({
          container: "coverage-map",
          style: "mapbox://styles/mapbox/dark-v11", // Dark theme
          attributionControl: false, // Add custom compact one later
          zoom: 11,
          center: [-97.15, 31.55], // Default center (Waco) - will be overridden by fitBounds
          minZoom: 5,
          maxZoom: 20,
          preserveDrawingBuffer: true, // Needed for html2canvas export
        });

        // Add standard controls
        this.coverageMap.addControl(
          new mapboxgl.NavigationControl(),
          "top-right",
        );
        this.coverageMap.addControl(
          new mapboxgl.AttributionControl({ compact: true }),
          "bottom-right",
        );

        // Handle map load event
        this.coverageMap.on("load", () => {
          if (coverage.streets_geojson) {
            this.addStreetsToMap(coverage.streets_geojson);
          } else {
            this.notificationManager.show(
              "No streets_geojson data found in coverage object.",
              "warning",
            );
            this.mapBounds = null; // Reset bounds if no data
          }
          // Add summary control after layers are potentially added
          this.addCoverageSummary(coverage);
          // Fit bounds after data is added (or use default if no data)
          this.fitMapToBounds();

          // Add map move listener for trip loading *after* map is loaded
          this.coverageMap.on("moveend", () => {
            if (this.showTripsActive) {
              clearTimeout(this.loadTripsDebounceTimer);
              this.loadTripsDebounceTimer = setTimeout(() => {
                this.loadTripsForView();
              }, 500); // Debounce time in ms
            }
          });
        });

        // Handle potential errors during map initialization
        this.coverageMap.on("error", (e) => {
          console.error("Mapbox GL Error:", e.error);
          this.notificationManager.show(
            `Map error: ${e.error?.message || "Unknown map error"}`,
            "danger",
          );
          mapContainer.innerHTML = CoverageManager.createAlertMessage(
            "Map Load Error",
            e.error?.message || "Could not initialize the map.",
            "danger",
          );
        });

        // Remove old info panel if present (shouldn't be needed with proper cleanup, but safe)
        if (this.mapInfoPanel) {
          this.mapInfoPanel.remove();
          this.mapInfoPanel = null;
        }
        this.createMapInfoPanel(); // Create the panel element ready for updates
      } catch (mapInitError) {
        console.error("Failed to initialize Mapbox GL:", mapInitError);
        mapContainer.innerHTML = CoverageManager.createAlertMessage(
          "Map Initialization Failed",
          mapInitError.message,
          "danger",
        );
      }
    }

    addStreetsToMap(geojson) {
      if (!this.coverageMap || !this.coverageMap.isStyleLoaded() || !geojson) {
        console.warn("Map not ready or no GeoJSON data to add streets.");
        return;
      }

      // Remove previous source/layers if they exist
      const layersToRemove = [
        "streets-layer",
        "streets-hover-highlight",
        "streets-click-highlight",
      ];
      layersToRemove.forEach((layerId) => {
        if (this.coverageMap.getLayer(layerId)) {
          this.coverageMap.removeLayer(layerId);
        }
      });
      if (this.coverageMap.getSource("streets")) {
        this.coverageMap.removeSource("streets");
      }

      this.streetsGeoJson = geojson; // Store the data
      this.currentFilter = "all"; // Reset filter on new data load

      try {
        this.coverageMap.addSource("streets", {
          type: "geojson",
          data: geojson,
          promoteId: "segment_id", // Use segment_id for feature state if available in properties
        });

        // Define dynamic styling using Mapbox expressions
        const getLineColor = [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          "#ffff00", // Yellow hover highlight
          ["boolean", ["get", "undriveable"], false],
          "#607d8b", // Grey for undriveable
          ["boolean", ["get", "driven"], false],
          "#4caf50", // Green for driven
          "#ff5252", // Red for not driven (default)
        ];
        const getLineWidth = [
          "interpolate",
          ["linear"],
          ["zoom"],
          8,
          [
            "case", // Zoom level 8
            [
              "in",
              ["get", "highway"],
              ["literal", ["motorway", "trunk", "primary"]],
            ],
            1.5,
            ["in", ["get", "highway"], ["literal", ["secondary", "tertiary"]]],
            1,
            0.5,
          ],
          14,
          [
            "case", // Zoom level 14
            [
              "in",
              ["get", "highway"],
              ["literal", ["motorway", "trunk", "primary"]],
            ],
            5,
            ["in", ["get", "highway"], ["literal", ["secondary", "tertiary"]]],
            4,
            [
              "in",
              ["get", "highway"],
              ["literal", ["residential", "unclassified"]],
            ],
            3,
            2.5,
          ], // Default at zoom 14+
          18,
          [
            "case", // Zoom level 18
            [
              "in",
              ["get", "highway"],
              ["literal", ["motorway", "trunk", "primary"]],
            ],
            8,
            ["in", ["get", "highway"], ["literal", ["secondary", "tertiary"]]],
            7,
            [
              "in",
              ["get", "highway"],
              ["literal", ["residential", "unclassified"]],
            ],
            6,
            5,
          ], // Default at zoom 18+
        ];
        const getLineOpacity = [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          1.0, // Full opacity on hover
          ["boolean", ["get", "undriveable"], false],
          0.6, // Less opacity for undriveable
          0.85, // Default opacity
        ];
        const getLineDash = [
          "case",
          ["boolean", ["get", "undriveable"], false],
          ["literal", [2, 2]], // Dashed for undriveable
          ["literal", [1, 0]], // Solid otherwise
        ];

        // Add the main streets layer
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

        // Calculate bounds
        const bounds = new mapboxgl.LngLatBounds();
        geojson.features.forEach((f) => {
          if (f.geometry?.coordinates) {
            if (f.geometry.type === "LineString") {
              f.geometry.coordinates.forEach((coord) => bounds.extend(coord));
            } else if (f.geometry.type === "MultiLineString") {
              f.geometry.coordinates.forEach((line) =>
                line.forEach((coord) => bounds.extend(coord)),
              );
            }
          }
        });

        if (!bounds.isEmpty()) {
          this.mapBounds = bounds;
          // Fit bounds is called in the 'load' event handler or after data load
        } else {
          this.mapBounds = null; // Reset if no valid coordinates found
        }

        // --- Interactivity ---
        let hoveredSegmentId = null;

        // Mouse Enter: Show pointer, update info panel, set hover state
        this.coverageMap.on("mouseenter", "streets-layer", (e) => {
          this.coverageMap.getCanvas().style.cursor = "pointer";
          if (e.features && e.features.length > 0) {
            const props = e.features[0].properties;
            const currentHoverId = props.segment_id;

            // Set hover state for the new feature
            if (currentHoverId !== hoveredSegmentId) {
              // Remove hover state from the previous feature
              if (
                hoveredSegmentId !== null &&
                this.coverageMap.getSource("streets")
              ) {
                this.coverageMap.setFeatureState(
                  { source: "streets", id: hoveredSegmentId },
                  { hover: false },
                );
              }
              if (this.coverageMap.getSource("streets")) {
                this.coverageMap.setFeatureState(
                  { source: "streets", id: currentHoverId },
                  { hover: true },
                );
              }
              hoveredSegmentId = currentHoverId;
            }

            this.updateMapInfoPanel(props, true); // Update panel for hover
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
          }
        });

        // Mouse Leave: Reset cursor, hide info panel, clear hover state
        this.coverageMap.on("mouseleave", "streets-layer", () => {
          this.coverageMap.getCanvas().style.cursor = "";
          if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";

          // Clear hover state when mouse leaves the layer
          if (
            hoveredSegmentId !== null &&
            this.coverageMap.getSource("streets")
          ) {
            this.coverageMap.setFeatureState(
              { source: "streets", id: hoveredSegmentId },
              { hover: false },
            );
          }
          hoveredSegmentId = null;
        });

        // Click: Show popup with action buttons
        this.coverageMap.on("click", "streets-layer", (e) => {
          if (e.originalEvent && e.originalEvent.button !== 0) return;
          if (e.features && e.features.length > 0) {
            const props = e.features[0].properties;
            const coordinates = e.lngLat;

            // Create popup content
            const popupContent = this.createStreetPopupContentHTML(props);

            // Create and add the popup
            const popup = new mapboxgl.Popup({
              closeButton: true,
              closeOnClick: false, // Keep popup open until explicitly closed or another is opened
              maxWidth: "350px", // Set max width if needed
              className: "coverage-popup", // Add class for potential specific styling
            })
              .setLngLat(coordinates)
              .setHTML(popupContent)
              .addTo(this.coverageMap);

            // --- FIX: Add event listeners AFTER popup is added ---
            const popupElement = popup.getElement();
            if (popupElement) {
              popupElement.addEventListener("click", (event) => {
                const button = event.target.closest("button[data-action]");
                if (button) {
                  const action = button.dataset.action;
                  const segmentId = button.dataset.segmentId;
                  if (action && segmentId) {
                    this._handleMarkSegmentAction(action, segmentId);
                    popup.remove(); // Close popup after action
                  } else {
                    console.warn(
                      "Action or Segment ID missing from button:",
                      button,
                    );
                  }
                }
              });
            } else {
              console.warn("Could not get popup element to attach listeners.");
            }

            // Update info panel as well on click (optional, shows persistent info)
            this.updateMapInfoPanel(props, false);
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
          }
        });
      } catch (error) {
        console.error("Error adding streets source/layer:", error);
        this.notificationManager.show(
          `Failed to display streets on map: ${error.message}`,
          "danger",
        );
      }
    }

    // Helper to create popup HTML for Mapbox, including data attributes for actions
    createStreetPopupContentHTML(props) {
      const streetName =
        props.street_name ||
        props.name ||
        props.display_name ||
        "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      // Ensure we handle all possible length property names and formats
      const segmentLength = parseFloat(
        props.segment_length || props.segment_length_m || props.length || 0,
      );
      const lengthMiles = CoverageManager.distanceInUserUnits(segmentLength);
      const isDriven = props.driven === true || props.driven === "true"; // Handle boolean/string
      const isUndriveable =
        props.undriveable === true || props.undriveable === "true";
      const status = isDriven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      // --- FIX: Added data-action and data-segment-id to buttons ---
      return `
        <div class="coverage-popup-content">
          <div class="popup-title">${streetName}</div>
          <div class="popup-detail">
            <span class="popup-label">Type:</span>
            <span class="popup-value">${CoverageManager.formatStreetType(streetType)}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Length:</span>
            <span class="popup-value">${lengthMiles}</span>
          </div>
          <div class="popup-detail">
            <span class="popup-label">Status:</span>
            <span class="popup-value ${isDriven ? "status-driven" : "status-undriven"}">${status}</span>
          </div>
          ${isUndriveable ? `<div class="popup-detail"><span class="popup-label">Marked as:</span> <span class="popup-value status-undriveable">Undriveable</span></div>` : ""}
          <div class="popup-detail">
            <span class="popup-label">ID:</span>
            <span class="popup-value segment-id">${segmentId}</span>
          </div>
          <div class="street-actions mt-2 d-flex flex-wrap gap-2">
            ${!isDriven ? `<button class="btn btn-sm btn-outline-success mark-driven-btn" data-action="driven" data-segment-id="${segmentId}">Mark Driven</button>` : ""}
            ${isDriven ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn" data-action="undriven" data-segment-id="${segmentId}">Mark Undriven</button>` : ""}
            ${!isUndriveable ? `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn" data-action="undriveable" data-segment-id="${segmentId}">Mark Undriveable</button>` : ""}
            ${isUndriveable ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn" data-action="driveable" data-segment-id="${segmentId}">Mark Driveable</button>` : ""}
          </div>
        </div>
      `;
    }

    // --- FIX: Added method to handle button clicks from popups ---
    async _handleMarkSegmentAction(action, segmentId) {
      const activeLocationId =
        this.selectedLocation?._id || this.currentDashboardLocationId;

      if (!activeLocationId) {
        this.notificationManager.show(
          "Cannot perform action: No location selected or location ID missing.",
          "warning",
        );
        return;
      }

      // if (!this.selectedLocation || !this.selectedLocation._id) {
      //   this.notificationManager.show(
      //     "Cannot perform action: No location selected.",
      //     "warning",
      //   );
      //   return;
      // }
      if (!segmentId) {
        this.notificationManager.show(
          "Cannot perform action: Segment ID missing.",
          "warning",
        );
        return;
      }

      const locationIdForApi = activeLocationId; // const locationId = this.selectedLocation._id;
      let endpoint = "";
      const payload = {
        location_id: locationIdForApi,
        segment_id: segmentId,
      };

      switch (action) {
        case "driven":
          endpoint = "/api/street_segments/mark_driven";
          break;
        case "undriven":
          endpoint = "/api/street_segments/mark_undriven";
          break;
        case "undriveable":
          endpoint = "/api/street_segments/mark_undriveable";
          break;
        case "driveable":
          endpoint = "/api/street_segments/mark_driveable";
          break;
        default:
          this.notificationManager.show(
            `Unknown segment action: ${action}`,
            "warning",
          );
          return;
      }

      try {
        await this._makeSegmentApiRequest(endpoint, payload);
        this.notificationManager.show(
          `Segment ${segmentId.substring(0, 8)}... marked as ${action}. Refreshing...`,
          "success",
        );

        // --- BEGIN IMMEDIATE VISUAL UPDATE ---
        if (
          this.streetsGeoJson &&
          this.streetsGeoJson.features &&
          this.coverageMap &&
          this.coverageMap.getSource("streets")
        ) {
          const featureIndex = this.streetsGeoJson.features.findIndex(
            (f) => f.properties.segment_id === segmentId,
          );
          if (featureIndex !== -1) {
            const feature = this.streetsGeoJson.features[featureIndex];
            switch (action) {
              case "driven":
                feature.properties.driven = true;
                feature.properties.undriveable = false;
                break;
              case "undriven":
                feature.properties.driven = false;
                // undriveable status is not changed by "mark undriven" action alone
                break;
              case "undriveable":
                feature.properties.undriveable = true;
                feature.properties.driven = false; // Marking undriveable implies not driven
                break;
              case "driveable":
                feature.properties.undriveable = false;
                // driven status is not changed by "mark driveable" action alone
                break;
            }
            // Ensure the source is updated.
            // Create a new object for setData to ensure Mapbox detects a change.
            const newGeoJson = {
              ...this.streetsGeoJson,
              features: [...this.streetsGeoJson.features],
            };
            newGeoJson.features[featureIndex] = { ...feature };
            this.coverageMap.getSource("streets").setData(newGeoJson);
            this.streetsGeoJson = newGeoJson; // Update the stored geojson
          }
        }
        // --- END IMMEDIATE VISUAL UPDATE ---

        // Refresh statistics on the server and update stats UI
        try {
          const refreshResp = await fetch(
            `/api/coverage_areas/${locationIdForApi}/refresh_stats`,
            { method: "POST" },
          );
          const refreshData = await refreshResp.json();
          if (refreshResp.ok && refreshData.coverage) {
            this.selectedLocation = refreshData.coverage;
            this.updateDashboardStats(refreshData.coverage);
            // Update summary control if map exists
            this.addCoverageSummary(refreshData.coverage);
          } else {
            this.notificationManager.show(
              `Failed to refresh stats: ${refreshData.detail || "Unknown error"}`,
              "warning",
            );
          }
        } catch (e) {
          console.error("Error refreshing stats:", e);
          this.notificationManager.show(
            `Error fetching updated stats: ${e.message}`,
            "danger",
          );
        }
        // Refresh the main coverage areas table
        await this.loadCoverageAreas();
      } catch (error) {
        this.notificationManager.show(
          `Failed to mark segment as ${action}: ${error.message}`,
          "danger",
        );
      }
    }

    // --- FIX: Added generic helper for API requests ---
    async _makeSegmentApiRequest(endpoint, payload) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `API request failed (HTTP ${response.status})`,
          );
        }
        return data; // Return success data if needed
      } catch (error) {
        console.error(`Error calling ${endpoint}:`, error);
        throw error; // Re-throw to be caught by the caller
      }
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && !this.mapBounds.isEmpty()) {
        try {
          this.coverageMap.fitBounds(this.mapBounds, {
            padding: 40, // Add some padding around the bounds
            maxZoom: 17, // Don't zoom in excessively close
            duration: 500, // Smooth transition
          });
        } catch (e) {
          console.error("Error fitting map to bounds:", e);
          // Fallback if fitBounds fails
          this.coverageMap.setCenter([-97.15, 31.55]);
          this.coverageMap.setZoom(11);
        }
      } else if (this.coverageMap) {
        // Fallback if no valid bounds
        this.coverageMap.setCenter([-97.15, 31.55]);
        this.coverageMap.setZoom(11);
        // Optionally notify user if bounds were expected but invalid
        // this.notificationManager.show("Map bounds invalid or not set, using default view.", "warning");
      }
    }

    setMapFilter(filterType, updateButtons = true) {
      if (!this.coverageMap || !this.coverageMap.getLayer("streets-layer")) {
        // Don't show notification if map just isn't loaded yet
        // this.notificationManager.show("Cannot set map filter: Map or street layer not initialized.", "warning");
        return;
      }
      this.currentFilter = filterType;
      let filter = null;

      // Mapbox GL JS filter syntax
      if (filterType === "driven") {
        filter = [
          "all",
          ["==", ["get", "driven"], true],
          ["!=", ["get", "undriveable"], true], // Explicitly check for not undriveable
        ];
      } else if (filterType === "undriven") {
        filter = [
          "all",
          ["==", ["get", "driven"], false],
          ["!=", ["get", "undriveable"], true], // Explicitly check for not undriveable
        ];
      } else {
        filter = null; // null filter shows all features
      }

      try {
        this.coverageMap.setFilter("streets-layer", filter);
        if (updateButtons) {
          this.updateFilterButtonStates();
        }
      } catch (error) {
        console.error("Error setting map filter:", error);
        this.notificationManager.show(
          `Failed to apply map filter: ${error.message}`,
          "danger",
        );
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

        // Reset styles
        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
          "btn-outline-secondary",
        );
        // Default style
        btn.classList.add("btn-outline-secondary");

        // Apply active style
        if (key === this.currentFilter) {
          btn.classList.add("active");
          btn.classList.remove("btn-outline-secondary");
          // Assign specific color based on filter type
          if (key === "driven") btn.classList.add("btn-success");
          else if (key === "undriven") btn.classList.add("btn-danger");
          else btn.classList.add("btn-primary"); // 'all' uses primary
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
      return classes[stage] || "text-info"; // Default to info color
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
      // Fallback for potentially new stages from backend
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      );
    }

    static formatStreetType(type) {
      if (!type) return "Unknown";
      // Simple formatting: replace underscores, capitalize words
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }

    setupTripLayers() {
      if (!this.coverageMap || !this.coverageMap.isStyleLoaded()) return;

      // Add source if it doesn't exist
      if (!this.coverageMap.getSource("trips-source")) {
        this.coverageMap.addSource("trips-source", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] }, // Start empty
        });
      }
      // Add layer if it doesn't exist
      if (!this.coverageMap.getLayer("trips-layer")) {
        this.coverageMap.addLayer(
          {
            id: "trips-layer",
            type: "line",
            source: "trips-source",
            layout: {
              "line-join": "round",
              "line-cap": "round",
            },
            paint: {
              "line-color": "#3388ff", // Blue color for trips
              "line-width": 2,
              "line-opacity": 0.7,
            },
          },
          "streets-layer", // Attempt to add trips layer *below* streets layer
        );
      }
    }

    clearTripOverlay() {
      if (!this.coverageMap || !this.coverageMap.getSource("trips-source"))
        return;
      try {
        const emptyGeoJSON = { type: "FeatureCollection", features: [] };
        this.coverageMap.getSource("trips-source").setData(emptyGeoJSON);
      } catch (error) {
        console.warn("Error clearing trip overlay:", error);
        // Source might not exist if map wasn't fully loaded
      }
    }

    async loadTripsForView() {
      if (
        !this.coverageMap ||
        !this.showTripsActive ||
        !this.coverageMap.isStyleLoaded()
      ) {
        return; // Don't load if map not ready or toggle is off
      }

      // Ensure layers are ready
      this.setupTripLayers();
      const tripsSource = this.coverageMap.getSource("trips-source");
      if (!tripsSource) {
        console.warn("Trips source not ready for loading data.");
        return;
      }

      const bounds = this.coverageMap.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();

      // --- FIX: Add user feedback for zoom level ---
      // Calculate approximate area (very rough estimate)
      const boundsArea = Math.abs(ne.lng - sw.lng) * Math.abs(ne.lat - sw.lat);
      const zoomThreshold = 5; // Example threshold for area

      if (boundsArea > zoomThreshold) {
        this.notificationManager.show(
          "Map area too large, zoom in further to view trip overlays.",
          "info",
        );
        this.clearTripOverlay(); // Clear existing trips
        return; // Stop loading
      }
      // --- End Fix ---

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

        // Format trips as GeoJSON FeatureCollection
        const tripFeatures = data.trips
          .map((coords, index) => {
            // Basic validation of coordinates structure
            if (
              !Array.isArray(coords) ||
              coords.length < 2 ||
              !Array.isArray(coords[0]) ||
              coords[0].length < 2
            ) {
              console.warn(
                `Invalid coordinate structure for trip index ${index}`,
              );
              return null; // Skip invalid features
            }
            return {
              type: "Feature",
              properties: { tripId: `trip-${index}` }, // Simple ID
              geometry: {
                type: "LineString",
                coordinates: coords,
              },
            };
          })
          .filter((feature) => feature !== null); // Remove nulls from skipped features

        const tripsGeoJSON = {
          type: "FeatureCollection",
          features: tripFeatures,
        };

        // Update the source data
        tripsSource.setData(tripsGeoJSON);
      } catch (error) {
        this.notificationManager.show(
          `Failed to load trip overlay: ${error.message}`,
          "danger",
        );
        this.clearTripOverlay(); // Clear on error
      }
    }

    createMapInfoPanel() {
      // Ensure panel doesn't already exist
      if (document.querySelector(".map-info-panel")) return;

      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      this.mapInfoPanel.style.display = "none"; // Initially hidden
      const mapContainer = document.getElementById("coverage-map");
      // Append only if map container exists
      if (mapContainer) {
        mapContainer.appendChild(this.mapInfoPanel);
      } else {
        console.warn("Map container not found for info panel.");
      }
    }

    updateMapInfoPanel(props, isHover = false) {
      if (!this.mapInfoPanel) return; // Don't try to update if panel doesn't exist

      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      // Ensure we handle all possible length property names and formats
      const segmentLength = parseFloat(
        props.segment_length || props.segment_length_m || props.length || 0,
      );
      const lengthMiles = CoverageManager.distanceInUserUnits(segmentLength);
      const isDriven = props.driven === true || props.driven === "true";
      const isUndriveable =
        props.undriveable === true || props.undriveable === "true";
      const status = isDriven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      // Build inner HTML
      this.mapInfoPanel.innerHTML = `
        <strong class="d-block mb-1">${streetName}</strong>
        ${isHover ? "" : '<hr class="panel-divider">'}
        <div class="d-flex justify-content-between small">
          <span>Type:</span>
          <span class="text-info">${CoverageManager.formatStreetType(streetType)}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Length:</span>
          <span class="text-info">${lengthMiles}</span>
        </div>
        <div class="d-flex justify-content-between small">
          <span>Status:</span>
          <span class="${isDriven ? "text-success" : "text-danger"}">
            <i class="fas fa-${isDriven ? "check-circle" : "times-circle"} me-1"></i>${status}
          </span>
        </div>
        ${isUndriveable ? `<div class="d-flex justify-content-between small"><span>Marked:</span><span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span></div>` : ""}
        ${isHover ? "" : `<div class="d-flex justify-content-between small mt-1"><span>ID:</span><span class="text-muted">${segmentId}</span></div><div class="mt-2 small text-center text-muted">Click segment to mark status</div>`}
      `;
      // Ensure panel is visible if updated (unless it's meant to be hidden on mouseleave)
      if (!isHover) {
        this.mapInfoPanel.style.display = "block";
      }
    }

    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;

      // Destroy previous chart instance if it exists
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }

      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data available.</div>';
        return;
      }

      // Prepare data for Chart.js
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.total_length_m || 0) - (a.total_length_m || 0),
      );
      const labels = sortedTypes.map((t) =>
        CoverageManager.formatStreetType(t.type),
      );
      const covered = sortedTypes.map(
        (t) => (t.covered_length_m || 0) * 0.000621371,
      ); // Convert meters to miles
      const driveable = sortedTypes.map(
        (t) => (t.driveable_length_m || 0) * 0.000621371,
      ); // Convert meters to miles
      const coveragePct = sortedTypes.map((t) => t.coverage_percentage || 0);

      // Create canvas element for the chart
      chartContainer.innerHTML =
        '<canvas id="streetTypeChartCanvas" height="180"></canvas>'; // Set fixed height or manage via CSS
      const ctx = document
        .getElementById("streetTypeChartCanvas")
        .getContext("2d");

      // Create the chart
      this.streetTypeChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Covered (mi)",
              data: covered,
              backgroundColor: "#4caf50", // Green for covered
              borderColor: "#388e3c",
              borderWidth: 1,
              order: 1, // Ensure bars are behind line
            },
            {
              label: "Driveable (mi)",
              data: driveable,
              backgroundColor: "#607d8b", // Grey for driveable total
              borderColor: "#37474f",
              borderWidth: 1,
              order: 1,
            },
            {
              label: "% Covered",
              data: coveragePct,
              type: "line", // Overlay as a line chart
              yAxisID: "y1", // Use the secondary y-axis
              borderColor: "#ffb300", // Amber/yellow for percentage line
              backgroundColor: "#ffb30044", // Semi-transparent fill
              fill: false,
              tension: 0.2,
              pointRadius: 3,
              pointBackgroundColor: "#ffb300",
              pointBorderColor: "#ffb300",
              order: 0, // Draw line on top
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, // Allow chart to fill container height
          plugins: {
            legend: {
              position: "top",
              labels: { color: "#fff" }, // White labels for dark theme
            },
            tooltip: {
              // Custom tooltips for different units
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
              grid: { color: "rgba(255,255,255,0.1)" }, // Light grid lines
            },
            y: {
              // Primary y-axis for distance
              beginAtZero: true,
              title: { display: true, text: "Distance (mi)", color: "#fff" },
              ticks: { color: "#fff" },
              grid: { color: "rgba(255,255,255,0.1)" },
            },
            y1: {
              // Secondary y-axis for percentage
              beginAtZero: true,
              position: "right", // Position on the right
              title: { display: true, text: "% Covered", color: "#ffb300" }, // Match line color
              ticks: { color: "#ffb300" },
              grid: { drawOnChartArea: false }, // Don't draw grid lines for this axis
              min: 0,
              max: 100, // Percentage scale
            },
          },
        },
      });
    }

    addCoverageSummary(coverage) {
      // Remove previous summary control if present
      if (
        this.coverageSummaryControl &&
        this.coverageMap &&
        this.coverageMap.removeControl
      ) {
        try {
          this.coverageMap.removeControl(this.coverageSummaryControl);
        } catch (e) {
          console.warn("Minor error removing previous summary control:", e);
        }
        this.coverageSummaryControl = null;
      }

      if (!coverage || !this.coverageMap) return;

      const coveragePercentage = coverage.coverage_percentage?.toFixed(1) || 0;
      const totalDist = CoverageManager.distanceInUserUnits(
        coverage.total_length_m || coverage.total_length || 0,
      );
      const drivenDist = CoverageManager.distanceInUserUnits(
        coverage.driven_length_m || coverage.driven_length || 0,
      );

      // Create a custom control div
      const controlDiv = document.createElement("div");
      controlDiv.className =
        "coverage-summary-control mapboxgl-ctrl mapboxgl-ctrl-group"; // Use Mapbox classes for potential styling consistency
      controlDiv.innerHTML = `
            <div class="summary-title">Coverage</div>
            <div class="summary-percentage">${coveragePercentage}%</div>
            <div class="summary-progress">
                <div class="progress" style="height: 8px;">
                    <div class="progress-bar bg-success" role="progressbar" style="width: ${coveragePercentage}%"></div>
                </div>
            </div>
            <div class="summary-details">
                <div>Total: ${totalDist}</div>
                <div>Driven: ${drivenDist}</div>
            </div>
        `;

      // Create a custom control object for Mapbox
      this.coverageSummaryControl = {
        onAdd: () => controlDiv,
        onRemove: () => controlDiv.remove(),
        getDefaultPosition: () => "top-left", // Default position
      };

      // Add the custom control to the map
      try {
        this.coverageMap.addControl(this.coverageSummaryControl, "top-left");
      } catch (e) {
        console.error("Error adding coverage summary control:", e);
      }
    }

    exportCoverageMap() {
      const mapContainer = document.getElementById("coverage-map");
      if (!this.coverageMap || !mapContainer) {
        this.notificationManager.show(
          "Map is not ready for export.",
          "warning",
        );
        return;
      }

      this.notificationManager.show("Preparing map export...", "info");

      // Function to perform the export using html2canvas
      const doExport = () => {
        // Add a short delay to allow map tiles and layers to potentially finish rendering
        setTimeout(() => {
          html2canvas(mapContainer, {
            useCORS: true, // Important for loading external map tiles
            backgroundColor: "#1a1a1a", // Match map background or set as needed
            logging: false, // Disable console logging from html2canvas
            allowTaint: true, // May be needed for some tile sources, use with caution
            // Explicitly set width/height to capture the container size
            width: mapContainer.offsetWidth,
            height: mapContainer.offsetHeight,
            // These might help capture the full map if scrolled, but can be complex
            // windowWidth: mapContainer.scrollWidth,
            // windowHeight: mapContainer.scrollHeight,
            // Try to capture controls by default, ignoreElements: false is default
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
                // Generate filename with location and date
                const locationName =
                  this.selectedLocation?.location_name || "coverage";
                const dateStr = new Date().toISOString().split("T")[0];
                a.download = `${locationName.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_map_${dateStr}.png`;
                document.body.appendChild(a);
                a.click();
                // Clean up the temporary link and URL
                setTimeout(() => {
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  this.notificationManager.show(
                    "Map exported successfully.",
                    "success",
                  );
                }, 100);
              }, "image/png"); // Specify PNG format
            })
            .catch((error) => {
              console.error("html2canvas export error:", error);
              this.notificationManager.show(
                `Map export failed: ${error.message}`,
                "danger",
              );
            });
        }, 500); // 500ms delay before capture seems reasonable
      };

      // Load html2canvas dynamically if it's not already loaded
      if (typeof html2canvas === "undefined") {
        const script = document.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
        // --- FIX: Use the verified integrity hash ---
        script.integrity =
          "sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs=";
        script.crossOrigin = "anonymous";
        script.onload = doExport; // Call export function once loaded
        script.onerror = () => {
          this.notificationManager.show(
            "Failed to load html2canvas library for export.",
            "danger",
          );
        };
        document.body.appendChild(script);
      } else {
        // If already loaded, just run the export function
        doExport();
      }
    }
  } // End of CoverageManager class

  // Initialize the manager when the DOM is ready
  document.addEventListener("DOMContentLoaded", () => {
    // Check for Mapbox GL JS dependency
    if (typeof mapboxgl === "undefined") {
      const errorMessage =
        "Error: Mapbox GL JS library failed to load. Map functionality will be unavailable.";
      const errorContainer = document.getElementById("alerts-container");
      if (errorContainer) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "alert alert-danger";
        errorDiv.textContent = errorMessage;
        errorContainer.prepend(errorDiv);
      } else {
        // Fallback if alerts container isn't ready yet
        console.error(errorMessage);
        alert(errorMessage); // Basic alert fallback
      }
      return; // Stop initialization
    }
    // Check for Chart.js dependency
    if (typeof Chart === "undefined") {
      console.warn(
        "Chart.js not loaded. Chart functionality will be unavailable.",
      );
      // Optionally display a message in the chart container
      const chartContainer = document.getElementById("street-type-chart");
      if (chartContainer) {
        chartContainer.innerHTML =
          '<div class="alert alert-warning small p-2">Chart library not loaded.</div>';
      }
    }

    // Initialize the Coverage Manager
    window.coverageManager = new CoverageManager();
  });
})(); // End of IIFE
