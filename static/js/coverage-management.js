/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */
"use strict";

// Define STATUS constants if not globally available
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
  COMPLETED: "completed", // Treat as COMPLETE
  ERROR: "error",
  WARNING: "warning",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
  POLLING_CHECK: "polling_check",
};

// Add dynamic styles if they don't exist
(() => {
  const style = document.createElement("style");
  style.id = "coverage-manager-dynamic-styles";
  style.textContent = `
    /* --- Progress Modal --- */
    .activity-indicator.pulsing { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    .detailed-stage-info { font-style: italic; color: #adb5bd; font-size: 0.9em; margin-top: 5px; }
    .stats-info { font-size: 0.9em; }
    .stats-info small { color: #ced4da; }
    .stats-info .text-info { color: #3db9d5 !important; }
    .stats-info .text-success { color: #4caf50 !important; }
    .stats-info .text-primary { color: #59a6ff !important; }

    /* --- Map Styling --- */
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

    /* Map Info Panel (Hover/Click) */
    .map-info-panel { position: absolute; top: 10px; left: 10px; z-index: 1000; background: rgba(40, 40, 40, 0.9); color: white; padding: 8px 12px; border-radius: 4px; font-size: 12px; pointer-events: none; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4); max-width: 250px; border-left: 3px solid #007bff; display: none; }
    .map-info-panel strong { color: #fff; }
    .map-info-panel .text-success { color: #4caf50 !important; }
    .map-info-panel .text-danger { color: #ff5252 !important; }
    .map-info-panel .text-info { color: #17a2b8 !important; }
    .map-info-panel .text-warning { color: #ffc107 !important; }
    .map-info-panel .text-muted { color: #adb5bd !important; }
    .map-info-panel hr.panel-divider { border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 5px 0; }

    /* Coverage Summary Control */
    .coverage-summary-control { background: rgba(40, 40, 40, 0.9); color: white; padding: 10px; border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1) !important; min-width: 150px; }
    .summary-title { font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #ccc; text-transform: uppercase; letter-spacing: 0.5px;}
    .summary-percentage { font-size: 24px; font-weight: bold; margin-bottom: 5px; color: #fff; }
    .summary-progress { margin-bottom: 8px; }
    .summary-details { font-size: 11px; color: #ccc; text-align: right; }

    /* Street Highlight Styles */
    .street-highlighted { /* Define a specific class for highlighting if needed, otherwise rely on setStyle changes */ }
  `;
  if (!document.getElementById(style.id)) {
    document.head.appendChild(style);
  }
})();

(() => {
  /**
   * Manages the coverage calculation UI, map display, and interactions.
   */
  class CoverageManager {
    constructor() {
      // Map and Layer References
      this.map = null; // Main map instance (Leaflet)
      this.coverageMap = null; // Specific map instance for the dashboard view
      this.streetLayers = null; // LayerGroup holding individual street segments
      this.streetsGeoJson = null; // Raw GeoJSON data for all streets in the selected area
      this.streetsGeoJsonLayer = null; // The L.geoJSON layer created from streetsGeoJson
      this.mapBounds = null; // Bounds of the displayed streets
      this.highlightedLayer = null; // Layer currently highlighted by click
      this.hoverHighlightLayer = null; // Layer currently highlighted by hover

      // State Management
      this.selectedLocation = null; // Full data object for the currently viewed coverage area
      this.currentProcessingLocation = null; // Location object currently being processed (for modal)
      this.processingStartTime = null; // Timestamp when processing started
      this.lastProgressUpdate = null; // Timestamp of last progress update received
      this.progressTimer = null; // Interval timer for updating elapsed time in modal
      this.activeTaskIds = new Set(); // Set of task IDs currently being processed/polled
      this.validatedLocation = null; // Location data validated via API before adding
      this.currentFilter = "all"; // Current map filter ('all', 'driven', 'undriven')
      this.lastActivityTime = null; // Timestamp of the last SSE message or poll update

      // UI Elements & Controls
      this.tooltips = []; // Array to hold Bootstrap tooltip instances
      this.mapInfoPanel = null; // DOM element for the hover/click info panel on the map
      this.coverageSummaryControl = null; // Leaflet control for the summary box
      this.streetTypeChartInstance = null; // Chart.js instance for the street type breakdown

      // External Dependencies (with fallbacks)
      this.notificationManager = window.notificationManager || {
        show: (message, type = "info") =>
          console.log(`[${type.toUpperCase()}] ${message}`),
      };
      this.confirmationDialog = window.confirmationDialog || {
        show: async (options) => confirm(options.message || "Are you sure?"),
      };

      // Initialization
      this.setupAutoRefresh();
      this.checkForInterruptedTasks();
      this.setupConnectionMonitoring();
      this.initTooltips(); // Initialize tooltips now directly
      this.createMapInfoPanel(); // Create panel container now directly
      this.setupEventListeners(); // Setup general listeners
      this.loadCoverageAreas(); // Load initial area list
    }

    /**
     * Converts meters to miles string.
     * @param {number} meters - Distance in meters.
     * @param {number} [fixed=2] - Number of decimal places.
     * @returns {string} Distance in miles (e.g., "1.23 mi").
     */
    distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      return (meters * 0.000621371).toFixed(fixed) + " mi";
    }

    /**
     * Sets up listeners for online/offline events.
     */
    setupConnectionMonitoring() {
      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        const alertsContainer = document.querySelector("#alerts-container");
        if (!alertsContainer) return;

        // Remove existing connection status alerts
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

        // Auto-dismiss the 'Connected' message after a delay
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

    /**
     * Initializes Bootstrap tooltips on the page.
     */
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

    /**
     * Enhances tables for better responsiveness by adding data-label attributes.
     */
    enhanceResponsiveTables() {
      const tables = document.querySelectorAll("#coverage-areas-table"); // Target specific table
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

    /**
     * Sets up an interval to periodically refresh the coverage areas list if processing is ongoing.
     */
    setupAutoRefresh() {
      setInterval(async () => {
        const isProcessingRow = document.querySelector(".processing-row"); // Check table row status
        const isModalProcessing =
          this.currentProcessingLocation &&
          document
            .getElementById("taskProgressModal")
            ?.classList.contains("show");

        // Refresh only if a task is actively processing (indicated by UI)
        if (isProcessingRow || isModalProcessing) {
          await this.loadCoverageAreas();
        }
      }, 10000); // Refresh every 10 seconds
    }

    /**
     * Sets up primary event listeners for the page.
     */
    setupEventListeners() {
      // Validate Location Button
      document
        .getElementById("validate-location")
        ?.addEventListener("click", () => this.validateLocation());

      // Add Coverage Area Button
      document
        .getElementById("add-coverage-area")
        ?.addEventListener("click", () => this.addCoverageArea());

      // Location Input Change (reset validation)
      document
        .getElementById("location-input")
        ?.addEventListener("input", () => {
          const addButton = document.getElementById("add-coverage-area");
          if (addButton) addButton.disabled = true;
          this.validatedLocation = null;
          const locationInput = document.getElementById("location-input");
          locationInput?.classList.remove("is-invalid", "is-valid");
        });

      // Cancel Processing Button (in modal)
      document
        .getElementById("cancel-processing")
        ?.addEventListener("click", () =>
          this.cancelProcessing(this.currentProcessingLocation),
        );

      // Progress Modal Close Event
      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          // Refresh list if modal closed while task was potentially still running but not explicitly canceled/errored
          if (
            this.currentProcessingLocation &&
            this.currentProcessingLocation.status !== STATUS.CANCELED &&
            this.currentProcessingLocation.status !== STATUS.ERROR
          ) {
            this.loadCoverageAreas();
          }
          this.clearProcessingContext(); // Always clear context when modal closes
        });

      // Save processing state before page unloads
      window.addEventListener("beforeunload", () => {
        if (this.currentProcessingLocation) {
          this.saveProcessingState();
        }
      });

      // Event Delegation for Coverage Areas Table Actions
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const targetButton = e.target.closest("button[data-action]");
          const targetLink = e.target.closest("a.location-name-link");

          if (targetButton) {
            e.preventDefault();
            const action = targetButton.dataset.action;
            const locationId = targetButton.dataset.locationId;
            const locationStr = targetButton.dataset.location; // Used for delete/cancel

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

            // Handle different actions
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
            // Handle clicking the location name link
            e.preventDefault();
            const locationId = targetLink.dataset.locationId;
            if (locationId) {
              this.displayCoverageDashboard(locationId);
            } else {
              console.error("Location ID missing from link:", targetLink);
            }
          }
        });

      // Event Delegation for Dashboard Actions (e.g., update missing data button)
      document.addEventListener("click", (e) => {
        // Update Missing Data Button (often shown when map data is missing/errored)
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          const locationId = updateMissingDataBtn.dataset.locationId;
          if (locationId) {
            this.updateCoverageForArea(locationId, "full"); // Trigger a full update
          } else {
            console.error("Missing location ID on update button.");
            this.notificationManager.show(
              "Failed to initiate update: Missing location ID.",
              "danger",
            );
          }
        }

        // Map Filter Buttons
        const filterButton = e.target.closest(
          ".map-controls button[data-filter]",
        );
        if (filterButton) {
          this.setMapFilter(filterButton.dataset.filter);
        }

        // Export Map Button
        const exportButton = e.target.closest("#export-coverage-map");
        if (exportButton) {
          this.exportCoverageMap();
        }
      });
    }

    /**
     * Checks localStorage for any interrupted processing tasks on page load.
     */
    checkForInterruptedTasks() {
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          // Check if the saved state is relatively recent (e.g., within the last hour)
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

            // Create notification for the user
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

            // Add event listeners for resume/discard
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

            // Add notification to the page
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

    /**
     * Resumes polling for an interrupted task based on saved data.
     * @param {object} savedData - The parsed data from localStorage.
     */
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

      // Set context and show modal
      this.currentProcessingLocation = location;
      this.task_id = taskId; // Ensure task_id is set on the instance
      this.showProgressModal(
        `Checking status for ${location.display_name}...`,
        savedData.progress || 0,
      );
      this.activeTaskIds.add(taskId);

      // Start polling
      this.pollCoverageProgress(taskId)
        .then(async (finalData) => {
          // Task completed (or was already complete)
          if (finalData?.stage !== STATUS.ERROR) {
            this.notificationManager.show(
              `Task for ${location.display_name} completed.`,
              "success",
            );
          }
          await this.loadCoverageAreas(); // Refresh the main list
          // If the completed task was for the currently viewed dashboard, refresh it
          if (this.selectedLocation?._id === location._id) {
            // Assuming location has _id
            await this.displayCoverageDashboard(this.selectedLocation._id);
          }
        })
        .catch(async (pollError) => {
          // Polling failed or task errored/canceled
          this.notificationManager.show(
            `Failed to resume task for ${location.display_name}: ${pollError.message || pollError}`,
            "danger",
          );
          await this.loadCoverageAreas(); // Refresh list even on error
        })
        .finally(() => {
          // Clean up regardless of outcome
          this.activeTaskIds.delete(taskId);
          // Modal hiding is handled by updateModalContent or modal close event
        });
    }

    /**
     * Saves the current processing state (location, task ID, progress) to localStorage.
     */
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
        // If no active processing, ensure saved state is cleared
        localStorage.removeItem("coverageProcessingState");
      }
    }

    /**
     * Clears the context related to the currently processing task.
     */
    clearProcessingContext() {
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      // Clear saved state as processing is no longer active in this session
      localStorage.removeItem("coverageProcessingState");
      // Remove the listener that saves state on page unload
      window.removeEventListener("beforeunload", this.saveProcessingState);

      // Reset instance variables
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.task_id = null; // Clear the task ID
      this.lastActivityTime = null;
      console.log("Processing context cleared.");
    }

    /**
     * Validates the location entered by the user via an API call.
     */
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

      // Reset UI state
      locationInputEl.classList.remove("is-invalid", "is-valid");
      addButton.disabled = true;
      this.validatedLocation = null;

      // Basic input validation
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

      // Set button loading state
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

        // Check if response contains necessary data
        if (!data || !data.osm_id || !data.display_name) {
          locationInputEl.classList.add("is-invalid");
          this.notificationManager.show(
            "Location not found or invalid response. Check input.",
            "warning",
          );
        } else {
          // Success: Update UI and store validated data
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
        // Reset button state
        validateButton.disabled = false;
        validateButton.innerHTML = originalButtonText;
      }
    }

    /**
     * Adds a new coverage area after validation and initiates processing.
     */
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

      const locationToAdd = { ...this.validatedLocation }; // Use validated data

      try {
        // Check if area already exists
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
          addButton.innerHTML = originalButtonText; // Reset button text, keep disabled
          return; // Don't proceed if area exists
        }

        // Set processing context and show modal
        this.currentProcessingLocation = locationToAdd;
        this.task_id = null; // Reset task ID for new task
        this.showProgressModal(
          `Starting processing for ${locationToAdd.display_name}...`,
          0,
        );
        window.addEventListener("beforeunload", this.saveProcessingState); // Add listener to save state if page closes

        // Start the backend processing task
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToAdd),
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

        // If task ID received, start polling for progress
        if (taskData?.task_id) {
          this.task_id = taskData.task_id;
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState(); // Save state now that we have a task ID
          await this.pollCoverageProgress(taskData.task_id); // Wait for polling to complete
          // Polling completed (successfully or with handled error)
          this.notificationManager.show(
            `Processing for ${locationToAdd.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas(); // Refresh the list
        } else {
          // No task ID received, cannot track progress
          this.hideProgressModal();
          this.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas(); // Refresh list anyway
        }

        // Reset the input form
        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid", "is-invalid");
        }
        this.validatedLocation = null; // Clear validated location
      } catch (error) {
        console.error("Error adding coverage area:", error);
        this.notificationManager.show(
          `Failed to add coverage area: ${error.message}`,
          "danger",
        );
        this.hideProgressModal(); // Hide modal on error
        await this.loadCoverageAreas(); // Refresh list to show current state
      } finally {
        // Reset add button state (keep disabled as validation is cleared)
        addButton.disabled = true;
        addButton.innerHTML = originalButtonText;
        // Processing context is cleared when modal closes or polling finishes
      }
    }

    /**
     * Initiates an update (full or incremental) for an existing coverage area.
     * @param {string} locationId - The ID (_id) of the location to update.
     * @param {string} [mode="full"] - The update mode ('full' or 'incremental').
     */
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
        // Fetch current details to get the location object needed for the update API
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

      // Check if this location is already being processed
      if (
        this.currentProcessingLocation?.display_name ===
        locationData.display_name
      ) {
        this.notificationManager.show(
          `Update already in progress for ${locationData.display_name}.`,
          "info",
        );
        // Optionally re-show the modal if it was hidden
        this.showProgressModal(
          `Update already running for ${locationData.display_name}...`,
        );
        return;
      }

      const processingLocation = { ...locationData }; // Use fetched data

      try {
        // Set processing context and show modal
        this.currentProcessingLocation = processingLocation;
        this.task_id = null; // Reset task ID
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id === locationId;
        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${processingLocation.display_name}...`,
        );
        window.addEventListener("beforeunload", this.saveProcessingState); // Save state if page closes

        // Determine API endpoint based on mode
        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage"; // Default to full update

        const payload = { ...processingLocation }; // API expects the location object

        // Call the update API
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        // Handle API response
        if (!response.ok) {
          // Handle validation errors (422) specifically
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

        // Start polling if task ID received
        if (data.task_id) {
          this.task_id = data.task_id;
          this.activeTaskIds.add(data.task_id);
          this.saveProcessingState(); // Save state with new task ID
          await this.pollCoverageProgress(data.task_id); // Wait for completion
          this.notificationManager.show(
            `Coverage update for ${processingLocation.display_name} completed.`,
            "success",
          );
          await this.loadCoverageAreas(); // Refresh list
          // If the updated location was being viewed, refresh the dashboard
          if (isUpdatingDisplayedLocation) {
            await this.displayCoverageDashboard(locationId);
          }
        } else {
          // No task ID, cannot track progress
          this.hideProgressModal();
          this.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas(); // Refresh list
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        this.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
        this.hideProgressModal(); // Hide modal on error
        await this.loadCoverageAreas(); // Refresh list
      }
      // Processing context is cleared when modal closes or polling finishes
    }

    /**
     * Cancels an ongoing processing task for a specific location.
     * @param {object|null} location - The location object to cancel processing for. Defaults to currentProcessingLocation.
     */
    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;

      if (!locationToCancel || !locationToCancel.display_name) {
        this.notificationManager.show(
          "No active processing context found to cancel.",
          "warning",
        );
        return;
      }

      // Confirm cancellation with the user
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
        // API expects display_name to identify the task to cancel
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
        this.hideProgressModal(); // Hide modal after successful cancellation
        await this.loadCoverageAreas(); // Refresh the list
      } catch (error) {
        console.error("Error cancelling processing:", error);
        this.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
        // Don't automatically hide modal on error, user might want to see the state
      } finally {
        // If the canceled task was the one currently being processed, clear its context
        if (
          this.currentProcessingLocation?.display_name ===
          locationToCancel.display_name
        ) {
          // Context is cleared when modal is hidden or polling loop exits
        }
      }
    }

    /**
     * Deletes a coverage area and its associated data.
     * @param {object} location - The location object to delete.
     */
    async deleteArea(location) {
      if (!location || !location.display_name) {
        this.notificationManager.show(
          "Invalid location data for deletion.",
          "warning",
        );
        return;
      }

      // Confirm deletion with the user
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

        // API expects display_name to identify the area to delete
        const payload = { display_name: location.display_name };
        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST", // Using POST as DELETE might not support body easily in all setups
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`,
          );
        }

        // Refresh the coverage areas list
        await this.loadCoverageAreas();

        // If the deleted area was the one displayed in the dashboard, hide the dashboard
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
        this.notificationManager.show(
          `Error deleting coverage area: ${error.message}`,
          "danger",
        );
      }
    }

    /**
     * Fetches the list of coverage areas from the API and updates the table.
     */
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

        // Update the table using the static method, passing the instance for context (e.g., distance units)
        CoverageManager.updateCoverageTable(data.areas, this);
        this.enhanceResponsiveTables(); // Add data-labels for mobile
        this.initTooltips(); // Re-initialize tooltips for new buttons
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        this.notificationManager.show(
          `Failed to load coverage areas: ${error.message}.`,
          "danger",
        );
        // Display error in the table body
        const tableBody = document.querySelector("#coverage-areas-table tbody");
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error loading data: ${error.message}</td></tr>`;
        }
      }
    }

    /**
     * Polls the backend for the status of a specific background task.
     * @param {string} taskId - The ID of the task to poll.
     * @returns {Promise<object>} A promise that resolves with the final task data when completed.
     * @throws {Error} If polling fails, times out, or the task errors/is canceled.
     */
    async pollCoverageProgress(taskId) {
      const maxRetries = 360; // Max polling attempts (e.g., 360 * 5s = 30 minutes)
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;

      console.log(`Starting polling for task ${taskId}`);

      while (retries < maxRetries) {
        // Check if the task is still considered active by the manager
        if (!this.activeTaskIds.has(taskId)) {
          console.log(
            `Polling stopped for task ${taskId} as it's no longer active.`,
          );
          throw new Error("Polling canceled"); // Or resolve/reject based on desired behavior
        }

        try {
          const response = await fetch(`/api/street_coverage/${taskId}`);

          // Handle specific HTTP errors
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

          // Parse response data
          let data;
          try {
            data = await response.json();
            // Basic validation of the response structure
            if (!data || typeof data !== "object" || !data.stage) {
              // Handle potentially empty but successful responses after a few retries
              if (response.ok && retries > 5) {
                console.warn(
                  `Task ${taskId}: Received incomplete data, assuming completion.`,
                );
                data = {
                  stage: STATUS.COMPLETE,
                  progress: 100,
                  message: "Completed.",
                  metrics: {},
                };
              } else {
                throw new Error("Invalid data format received from server.");
              }
            }
          } catch (jsonError) {
            throw new Error(
              `Error processing server response: ${jsonError.message}`,
            );
          }

          // Update UI based on received data
          this.updateModalContent(data);
          this.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date(); // Record activity
          this.saveProcessingState(); // Update saved state with latest progress

          // Check for terminal states
          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            console.log(`Task ${taskId} completed successfully.`);
            this.updateModalContent({ ...data, progress: 100 }); // Ensure progress bar is full
            this.updateStepIndicators(STATUS.COMPLETE, 100);
            this.activeTaskIds.delete(taskId); // Task finished, remove from active set
            return data; // Resolve the promise with final data
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

          // Check for stalled task
          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              // ~1 minute if polling every 5s
              console.warn(
                `Task ${taskId} seems stalled at stage: ${data.stage}`,
              );
              // Could potentially add logic here to increase polling interval if stalled
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 5000)); // Poll every 5 seconds
          retries++;
        } catch (error) {
          // Handle errors during polling (network error, task error, etc.)
          console.error(
            `Error polling coverage progress for task ${taskId}:`,
            error,
          );
          this.updateModalContent({
            stage: STATUS.ERROR,
            progress: this.currentProcessingLocation?.progress || 0, // Show last known progress
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {},
          });
          this.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId); // Task is no longer actively polled
          throw error; // Reject the promise
        }
      }

      // If loop completes without returning/throwing, it timed out
      this.updateModalContent({
        stage: STATUS.ERROR,
        progress: this.currentProcessingLocation?.progress || 99, // Show almost complete
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

    /**
     * Static method to update the coverage areas HTML table.
     * @param {Array<object>} areas - Array of coverage area objects from the API.
     * @param {CoverageManager} instance - The CoverageManager instance (for accessing methods like distanceInUserUnits).
     */
    static updateCoverageTable(areas, instance) {
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

        // Apply row classes based on status
        row.className = isProcessing
          ? "processing-row table-info"
          : hasError
            ? "table-danger"
            : isCanceled
              ? "table-warning"
              : "";

        // Format data for display
        const lastUpdated = area.last_updated
          ? new Date(area.last_updated).toLocaleString()
          : "Never";
        const totalLengthMiles = instance.distanceInUserUnits(
          area.total_length,
        ); // Use instance method
        const drivenLengthMiles = instance.distanceInUserUnits(
          area.driven_length,
        ); // Use instance method
        const coveragePercentage =
          area.coverage_percentage?.toFixed(1) || "0.0";

        // Determine progress bar color
        let progressBarColor = "bg-success";
        if (hasError || isCanceled) progressBarColor = "bg-secondary";
        else if (area.coverage_percentage < 25) progressBarColor = "bg-danger";
        else if (area.coverage_percentage < 75) progressBarColor = "bg-warning";

        // Safely stringify location data for the delete/cancel buttons
        const escapedLocation = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;");
        const locationId = area._id; // Use the database ID for updates/viewing

        // Populate row HTML
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

    /**
     * Shows the progress modal with initial message and progress.
     * @param {string} [message="Processing..."] - Initial message to display.
     * @param {number} [progress=0] - Initial progress percentage.
     */
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

      // Set initial modal content
      if (modalTitle)
        modalTitle.textContent = this.currentProcessingLocation?.display_name
          ? `Processing: ${this.currentProcessingLocation.display_name}`
          : "Processing Coverage";
      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        modalProgressBar.className =
          "progress-bar progress-bar-striped progress-bar-animated bg-primary"; // Reset classes
      }
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.className = "progress-message"; // Reset classes
        progressMessage.removeAttribute("data-stage");
      }
      // Clear details sections
      progressDetails.querySelector(".stage-info").innerHTML = "";
      progressDetails.querySelector(".stats-info").innerHTML = "";
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = ""; // Estimation removed

      // Enable cancel button initially
      if (cancelBtn) cancelBtn.disabled = false;

      // Start or reset the elapsed timer
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.processingStartTime = Date.now();
      this.lastActivityTime = Date.now(); // Set initial activity time
      this.progressTimer = setInterval(() => {
        this.updateTimingInfo();
        this.updateActivityIndicator();
      }, 1000);
      this.updateTimingInfo(); // Run once immediately
      this.updateActivityIndicator(); // Run once immediately

      // Show the modal using Bootstrap API
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static", // Prevent closing on backdrop click
        keyboard: false, // Prevent closing with Esc key
      });
      bsModal.show();
    }

    /**
     * Hides the progress modal.
     */
    hideProgressModal() {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;
      const modal = bootstrap.Modal.getInstance(modalElement);
      if (modal) {
        modal.hide();
        // The 'hidden.bs.modal' event listener handles context cleanup
      } else {
        // Fallback if Bootstrap instance isn't found
        modalElement.style.display = "none";
        modalElement.classList.remove("show");
        document.body.classList.remove("modal-open");
        const backdrop = document.querySelector(".modal-backdrop");
        if (backdrop) backdrop.remove();
        this.clearProcessingContext(); // Manually clear context in fallback
      }
    }

    /**
     * Updates the content of the progress modal based on task status data.
     * @param {object} data - Task status data from the API or polling.
     */
    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      // Ensure modal and processing context exist
      if (!modalElement || !this.currentProcessingLocation) return;

      // Destructure data with defaults
      const {
        stage = STATUS.UNKNOWN,
        progress = 0,
        metrics = {},
        message = "Processing...",
        error = null,
      } = data || {};

      // Get modal elements
      const progressBar = modalElement.querySelector(".progress-bar");
      const progressMessageEl = modalElement.querySelector(".progress-message");
      const stageInfoEl = modalElement.querySelector(".stage-info");
      const statsInfoEl = modalElement.querySelector(".stats-info");
      const cancelBtn = document.getElementById("cancel-processing");

      // Update Progress Bar
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        // Reset classes and apply appropriate ones
        progressBar.className = "progress-bar"; // Base class
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
        progressMessageEl.dataset.stage = stage; // Store stage for potential use
        // Apply text color based on status
        progressMessageEl.className = "progress-message"; // Reset classes
        if (stage === STATUS.ERROR)
          progressMessageEl.classList.add("text-danger");
        if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED)
          progressMessageEl.classList.add("text-success");
      }

      // Update Stage Info (Icon + Name)
      if (stageInfoEl) {
        const stageName = CoverageManager.formatStageName(stage);
        const stageIcon = CoverageManager.getStageIcon(stage);
        stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
        stageInfoEl.className = `stage-info mb-2 text-${CoverageManager.getStageTextClass(stage)}`;
      }

      // Update Statistics Info
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

      // Stop timer and activity indicator if task is finished/errored/canceled
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
          if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Clear estimation
        }
        this.updateActivityIndicator(false); // Set indicator to inactive
      }
    }

    /**
     * Updates the visual step indicators in the progress modal.
     * @param {string} stage - The current task stage.
     * @param {number} progress - The current progress percentage.
     */
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

      // Reset all steps
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

      // Determine which step errored based on stage and progress
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
          // Error during finalization or generation
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markComplete("calculating");
          markError("complete");
        }
      } else if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
        Object.keys(steps).forEach(markComplete); // Mark all as complete
      } else {
        // Mark steps as complete up to the current stage, and mark the current stage as active
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
          // Default to initializing if stage is unknown
          markActive("initializing");
        }
      }
    }

    /**
     * Updates the elapsed time display in the progress modal.
     */
    updateTimingInfo() {
      if (!this.processingStartTime) return; // Ensure start time is set

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
      ); // Keep reference even if not used

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Estimation removed for simplicity/accuracy
    }

    /**
     * Updates the activity indicator (pulsing icon, last update time) in the progress modal.
     * @param {boolean|null} [isActive=null] - Force the state, or calculate based on lastActivityTime.
     */
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
        // Consider active if last activity was within 10 seconds
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
        lastUpdateEl.textContent = `Last update: ${this.formatTimeAgo(this.lastActivityTime)}`;
      } else {
        lastUpdateEl.textContent = currentlyActive ? "" : "No recent activity";
      }
    }

    /**
     * Formats a date object into a relative time string (e.g., "5s ago", "2m ago").
     * @param {Date} date - The date object to format.
     * @returns {string} The formatted relative time string.
     */
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

    /**
     * Formats metric statistics into HTML for display in the progress modal.
     * @param {string} stage - The current task stage.
     * @param {object} metrics - The metrics object from the task status.
     * @returns {string} HTML string representing the formatted stats.
     */
    formatMetricStats(stage, metrics) {
      if (!metrics || Object.keys(metrics).length === 0) {
        return '<div class="text-muted small">Calculating...</div>';
      }

      let statsHtml = '<div class="mt-1">'; // Container

      // Helper to add a stat row
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

      // Display relevant metrics based on the current stage
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
        // Show final summary stats
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
        // Default message if stage doesn't match known metric groups
        statsHtml += '<div class="text-muted small">Processing...</div>';
      }

      statsHtml += "</div>"; // Close container
      return statsHtml;
    }

    // --- Dashboard Display ---

    /**
     * Fetches detailed data for a location and displays the dashboard view.
     * @param {string} locationId - The ID of the location to display.
     */
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

      // Ensure all required dashboard elements exist
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

      // --- Show Loading State ---
      dashboardContainer.style.display = "block"; // Make dashboard visible
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

      // Scroll to the dashboard smoothly
      dashboardContainer.scrollIntoView({ behavior: "smooth", block: "start" });

      try {
        // Fetch detailed data for the selected location
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

        this.selectedLocation = data.coverage; // Store the full coverage data
        const coverage = data.coverage;

        // --- Populate UI with fetched data ---
        const locationName = coverage.location_name || "Coverage Details";
        dashboardLocationName.textContent = locationName; // Update title

        // Update the main statistics card
        this.updateDashboardStats(coverage);

        // Determine if map/chart data is available and valid
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

        // Handle cases where map/chart cannot be displayed
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
              locationId, // Pass ID for the update button
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
            // Schedule a refresh if processing
            setTimeout(() => this.displayCoverageDashboard(locationId), 15000);
          } else if (status === STATUS.COMPLETED && !hasStreetData) {
            // Handle case where stats are done but GeoJSON generation might be pending or failed
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Finalizing Map Data",
              "Coverage statistics calculated. Generating detailed map data...",
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Generating chart data...</div>';
            notificationMessage = `Finalizing map data for ${locationName}.`;
            setTimeout(() => this.displayCoverageDashboard(locationId), 10000); // Refresh sooner
          } else {
            // Needs reprocessing or other non-error state without data
            statusMessageHtml = CoverageManager.createAlertMessage(
              "Map Data Not Available",
              "Please update the coverage data to generate the map.",
              "warning",
              locationId, // Pass ID for the update button
            );
            notificationType = "warning";
            notificationMessage = `Map data needs to be generated for ${locationName}.`;
          }

          // Display status messages instead of map/chart
          mapContainer.innerHTML = statusMessageHtml;
          chartContainer.innerHTML = chartMessageHtml;
          this.notificationManager.show(notificationMessage, notificationType);
        } else {
          // --- Success Path: Display Map and Chart ---
          this.notificationManager.show(
            `Loaded coverage map for ${locationName}`,
            "success",
          );

          // Initialize map and chart with the valid data
          this.initializeCoverageMap(coverage); // Creates/replaces map instance
          this.createStreetTypeChart(coverage.street_types); // Creates/replaces chart instance
          this.updateStreetTypeCoverage(coverage.street_types); // Updates the list breakdown

          // Fit map bounds after initialization
          this.fitMapToBounds();
        }

        // Re-initialize tooltips for any new buttons added
        this.initTooltips();
      } catch (error) {
        // Handle errors during dashboard data fetching/display
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger p-4"><strong>Error:</strong> ${error.message}</div>`;
        chartContainer.innerHTML = ""; // Clear chart
        statsContainer.innerHTML = `<div class="text-danger p-2">Failed to load stats.</div>`;
        streetTypeCoverageEl.innerHTML = `<div class="text-danger p-2">Failed to load breakdown.</div>`;
        this.notificationManager.show(
          `Error loading dashboard: ${error.message}`,
          "danger",
        );
      }
    }

    /**
     * Updates the statistics card in the dashboard.
     * @param {object} coverage - The coverage data object.
     */
    updateDashboardStats(coverage) {
      if (!coverage) return;
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      );
      if (!statsContainer) return;

      // Extract and format data
      const totalLengthM = coverage.total_length || 0;
      const drivenLengthM = coverage.driven_length || 0;
      const coveragePercentage =
        coverage.coverage_percentage?.toFixed(1) || "0.0";
      const totalSegments = coverage.total_segments || 0;
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

      // Update HTML
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

      // Update the separate street type coverage list
      this.updateStreetTypeCoverage(coverage.street_types);

      // Update the map summary control if the map exists
      if (this.coverageMap) {
        this.addCoverageSummary(coverage); // Re-adds/updates the control
      }
    }

    /**
     * Updates the list showing coverage breakdown by street type.
     * @param {Array<object>} streetTypes - Array of street type statistics.
     */
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

      // Sort by total length descending and take top 6
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

        // Determine bar color based on coverage percentage
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

    /**
     * Clears the dashboard UI elements when hiding or deleting data.
     */
    clearDashboardUI() {
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      document.querySelector(
        ".dashboard-stats-card .stats-container",
      ).innerHTML = "";
      document.getElementById("street-type-chart").innerHTML = "";
      document.getElementById("street-type-coverage").innerHTML = "";

      // Clear map container and instance
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = "";
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }

      // Reset related state variables
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

    /**
     * Static helper to create a loading indicator HTML string.
     * @param {string} [message="Loading..."] - The message to display.
     * @returns {string} HTML string for the loading indicator.
     */
    static createLoadingIndicator(message = "Loading...") {
      return `
        <div class="d-flex flex-column align-items-center justify-content-center p-4 text-center text-muted">
          <div class="spinner-border spinner-border-sm text-secondary mb-2" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <small>${message}</small>
        </div>`;
    }

    /**
     * Static helper to create an alert message HTML string, optionally with an update button.
     * @param {string} title - The alert title.
     * @param {string} message - The alert message body.
     * @param {string} [type="info"] - Alert type ('info', 'warning', 'danger', 'success').
     * @param {string|null} [locationId=null] - If provided, adds an "Update Now" button targeting this ID.
     * @returns {string} HTML string for the alert message.
     */
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

    // --- Map Interaction and Display ---

    /**
     * Initializes or re-initializes the coverage map in the dashboard.
     * @param {object} coverage - The coverage data object containing streets_geojson.
     */
    initializeCoverageMap(coverage) {
      const mapContainer = document.getElementById("coverage-map");
      if (!mapContainer) return;

      // Clear previous map instance if it exists
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }

      // Ensure container is empty before initializing
      mapContainer.innerHTML = "";

      // Create new map instance
      this.coverageMap = L.map("coverage-map", {
        attributionControl: false, // Add manually later
        zoomControl: true,
      });

      // Add base tile layer
      L.tileLayer(
        "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        {
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: "abcd",
          maxZoom: 20,
          minZoom: 5, // Set a reasonable min zoom
        },
      ).addTo(this.coverageMap);

      // Add custom attribution control
      L.control.attribution({ prefix: false }).addTo(this.coverageMap);

      // Add streets layer (if data exists)
      if (coverage.streets_geojson) {
        this.addStreetsToMap(coverage.streets_geojson); // This also sets this.mapBounds
      } else {
        console.warn("No streets_geojson data found in coverage object.");
        this.mapBounds = null; // Reset bounds if no streets
      }

      // Add summary control
      this.addCoverageSummary(coverage);

      // Add listener to clear highlight when map background is clicked
      this.coverageMap.on("click", () => {
        this.clearHighlight();
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
      });

      // Invalidate size after a short delay to ensure proper rendering
      setTimeout(() => this.coverageMap?.invalidateSize(), 100);
    }

    /**
     * Determines the style for a street segment feature.
     * @param {object} feature - GeoJSON feature object.
     * @param {boolean} [isHover=false] - Whether the style is for hover state.
     * @param {boolean} [isHighlight=false] - Whether the style is for click highlight state.
     * @returns {object} Leaflet path style options.
     */
    styleStreet(feature, isHover = false, isHighlight = false) {
      const props = feature.properties;
      const isDriven = props.driven;
      const isUndriveable = props.undriveable;
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";

      // Base weight and adjustments for visual hierarchy
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
      else weight = baseWeight - 1; // Footway, cycleway, etc.

      // Base color and opacity
      let color;
      let opacity = 0.75;
      let dashArray = null;

      if (isUndriveable) {
        color = "#607d8b"; // Muted blue-gray
        opacity = 0.6;
        dashArray = "4, 4";
      } else if (isDriven) {
        color = "#4caf50"; // Green
      } else {
        color = "#ff5252"; // Red
      }

      // Apply hover/highlight overrides
      if (isHighlight) {
        weight += 2;
        opacity = 1;
        color = "#ffff00"; // Yellow highlight
      } else if (isHover) {
        weight += 1.5;
        opacity = 0.95;
        // Keep original color on hover, just thicker/more opaque
      }

      return {
        color: color,
        weight: weight,
        opacity: opacity,
        dashArray: dashArray,
      };
    }

    /**
     * Adds the street GeoJSON data to the map as a layer.
     * @param {object} geojson - The GeoJSON FeatureCollection for streets.
     */
    addStreetsToMap(geojson) {
      if (!this.coverageMap) return;

      // Clear existing street layers if they exist
      if (this.streetLayers) {
        this.streetLayers.clearLayers();
      } else {
        this.streetLayers = L.layerGroup().addTo(this.coverageMap);
      }

      // Store the raw GeoJSON data for filtering
      this.streetsGeoJson = geojson;
      this.currentFilter = "all"; // Reset filter on adding new data

      if (!geojson || !geojson.features || geojson.features.length === 0) {
        console.warn("No street features found in GeoJSON data.");
        this.mapBounds = this.coverageMap.getBounds(); // Use current map view if no features
        this.streetsGeoJsonLayer = null; // Ensure layer reference is cleared
        return;
      }

      // Create the main GeoJSON layer
      this.streetsGeoJsonLayer = L.geoJSON(geojson, {
        style: (feature) => this.styleStreet(feature), // Use base style initially
        onEachFeature: (feature, layer) => {
          // Store original style for resetting highlight/hover
          layer.originalStyle = this.styleStreet(feature);
          // Store feature properties for easy access in handlers
          layer.featureProperties = feature.properties;

          // --- Click Handler (Highlighting & Popup/Panel) ---
          layer.on("click", (e) => {
            L.DomEvent.stopPropagation(e); // Prevent map click event
            this.clearHighlight(); // Clear previous click highlight
            this.clearHoverHighlight(); // Clear hover highlight

            this.highlightedLayer = layer;
            layer.setStyle(this.styleStreet(feature, false, true)); // Apply click highlight style
            layer.bringToFront();

            // Update and show the info panel on click
            this.updateMapInfoPanel(feature.properties);
            if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";

            // Optionally open popup on click as well (can be redundant with panel)
            layer.openPopup();
          });

          // --- Hover Handlers ---
          layer.on("mouseover", (e) => {
            if (layer !== this.highlightedLayer) {
              // Don't apply hover if already click-highlighted
              this.clearHoverHighlight(); // Clear previous hover highlight
              this.hoverHighlightLayer = layer;
              layer.setStyle(this.styleStreet(feature, true, false)); // Apply hover style
              layer.bringToFront();
              // Optionally update info panel on hover too
              // this.updateMapInfoPanel(feature.properties, true);
              // if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
            }
          });
          layer.on("mouseout", (e) => {
            if (layer === this.hoverHighlightLayer) {
              this.clearHoverHighlight();
              // Hide panel if it was shown ONLY on hover and not click-highlighted
              // if (this.mapInfoPanel && layer !== this.highlightedLayer) {
              //   this.mapInfoPanel.style.display = 'none';
              // }
            }
          });

          // --- Bind Popup (for manual marking actions) ---
          // Define handlers HERE to ensure correct `this` binding and allow removal
          const handleMarkDriven = () =>
            this.markStreetSegment(layer, "driven");
          const handleMarkUndriven = () =>
            this.markStreetSegment(layer, "undriven");
          const handleMarkUndriveable = () =>
            this.markStreetSegment(layer, "undriveable");
          const handleMarkDriveable = () =>
            this.markStreetSegment(layer, "driveable");

          // Store handlers on the layer object for removal later
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

          // --- Add Popup Open/Close Listeners for Button Handlers ---
          layer.on("popupopen", (e) => {
            const popupEl = e.popup.getElement();
            if (!popupEl) return;
            // Attach listeners using the stored handlers
            popupEl
              .querySelector(".mark-driven-btn")
              ?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkDriven,
              );
            popupEl
              .querySelector(".mark-undriven-btn")
              ?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriven,
              );
            popupEl
              .querySelector(".mark-undriveable-btn")
              ?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriveable,
              );
            popupEl
              .querySelector(".mark-driveable-btn")
              ?.addEventListener(
                "click",
                layer._popupHandlers.handleMarkDriveable,
              );
          });

          layer.on("popupclose", (e) => {
            const popupEl = e.popup.getElement();
            if (!popupEl || !layer._popupHandlers) return;
            // Remove listeners using the stored handlers
            popupEl
              .querySelector(".mark-driven-btn")
              ?.removeEventListener(
                "click",
                layer._popupHandlers.handleMarkDriven,
              );
            popupEl
              .querySelector(".mark-undriven-btn")
              ?.removeEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriven,
              );
            popupEl
              .querySelector(".mark-undriveable-btn")
              ?.removeEventListener(
                "click",
                layer._popupHandlers.handleMarkUndriveable,
              );
            popupEl
              .querySelector(".mark-driveable-btn")
              ?.removeEventListener(
                "click",
                layer._popupHandlers.handleMarkDriveable,
              );
          });
        }, // end onEachFeature
      }); // end L.geoJSON

      // Add the main layer to the map *indirectly* through the layer group used for filtering
      this.streetLayers.addLayer(this.streetsGeoJsonLayer);

      // Store bounds for fitting view
      this.mapBounds = this.streetsGeoJsonLayer.getBounds();
    }

    /**
     * Creates the HTML content for a street segment's popup.
     * Note: Event listeners are attached in 'popupopen' handler, not here.
     * @param {L.Layer} layer - The Leaflet layer representing the street segment.
     * @returns {HTMLElement} The DOM element for the popup content.
     */
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
      // IMPORTANT: Event listeners are added in the 'popupopen' handler in addStreetsToMap
      return popupContent;
    }

    /**
     * Resets the style of the currently click-highlighted layer.
     */
    clearHighlight() {
      if (this.highlightedLayer) {
        try {
          // Reset style using the stored original style
          this.highlightedLayer.setStyle(this.highlightedLayer.originalStyle);
        } catch (styleError) {
          console.warn(
            "Could not reset style on previously highlighted layer:",
            styleError,
          );
          // Attempt a default fallback style
          try {
            this.highlightedLayer.setStyle({
              weight: 3,
              opacity: 0.7,
              color: "#ff5252",
            }); // Example fallback
          } catch (fallbackError) {
            console.warn("Fallback style reset failed:", fallbackError);
          }
        }
        this.highlightedLayer = null; // Clear the reference
      }
    }

    /**
     * Resets the style of the currently hover-highlighted layer.
     */
    clearHoverHighlight() {
      if (this.hoverHighlightLayer) {
        try {
          // Only reset if it's not the currently click-highlighted layer
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
          // Attempt a default fallback style
          try {
            this.hoverHighlightLayer.setStyle({
              weight: 3,
              opacity: 0.7,
              color: "#ff5252",
            }); // Example fallback
          } catch (fallbackError) {
            console.warn("Fallback style reset failed:", fallbackError);
          }
        }
        this.hoverHighlightLayer = null; // Clear the reference
      }
    }

    /**
     * Creates the DOM element for the map info panel (initially hidden).
     */
    createMapInfoPanel() {
      // Ensure it doesn't already exist
      if (this.mapInfoPanel) return;

      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      // Append to the map container (or another suitable parent)
      document.getElementById("coverage-map")?.appendChild(this.mapInfoPanel);
    }

    /**
     * Updates the content of the map info panel.
     * @param {object} props - Feature properties.
     * @param {boolean} [isHover=false] - Whether this update is triggered by hover.
     */
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

    /**
     * Adds or updates the coverage summary control on the map.
     * @param {object} coverage - The coverage data object.
     */
    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;

      // Remove existing control first to prevent duplicates
      if (this.coverageSummaryControl) {
        this.coverageMap.removeControl(this.coverageSummaryControl);
        this.coverageSummaryControl = null;
      }

      // Define the custom Leaflet control
      const CoverageSummaryControl = L.Control.extend({
        options: { position: "topright" }, // Position control
        onAdd: () => {
          const container = L.DomUtil.create(
            "div",
            "coverage-summary-control leaflet-bar",
          );
          // Disable map interactions on the control
          L.DomEvent.disableClickPropagation(container);
          L.DomEvent.disableScrollPropagation(container);

          // Extract and format data
          const coveragePercentage =
            coverage.coverage_percentage?.toFixed(1) || "0.0";
          const totalMiles = this.distanceInUserUnits(
            coverage.total_length || 0,
          );
          const drivenMiles = this.distanceInUserUnits(
            coverage.driven_length || 0,
          );

          // Determine bar color
          let barColor = "bg-success";
          if (
            coverage.status === STATUS.ERROR ||
            coverage.status === STATUS.CANCELED
          )
            barColor = "bg-secondary";
          else if (parseFloat(coveragePercentage) < 25) barColor = "bg-danger";
          else if (parseFloat(coveragePercentage) < 75) barColor = "bg-warning";

          // Populate control HTML
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
        onRemove: () => {
          // Cleanup if needed
        },
      });

      // Create and add the control to the map
      this.coverageSummaryControl = new CoverageSummaryControl();
      this.coverageSummaryControl.addTo(this.coverageMap);
    }

    /**
     * Handles marking a street segment status (driven, undriven, etc.) via API call.
     * @param {L.Layer} layer - The Leaflet layer of the segment.
     * @param {string} action - The action to perform ('driven', 'undriven', 'undriveable', 'driveable').
     */
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

      // Determine API endpoint and optimistic state changes
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
          break; // Keep undriveable status if marking undriven
        case "undriveable":
          apiEndpoint = "/api/street_segments/mark_undriveable";
          statusText = "undriveable";
          optimisticDriven = props.driven;
          optimisticUndriveable = true;
          break; // Keep driven status if marking undriveable
        case "driveable":
          apiEndpoint = "/api/street_segments/mark_driveable";
          statusText = "driveable";
          optimisticDriven = props.driven;
          optimisticUndriveable = false;
          break; // Keep driven status
        default:
          this.notificationManager.show("Invalid action specified", "danger");
          return;
      }

      const streetName = props.name || props.street_name || "Unnamed Street";
      const originalStyle = layer.originalStyle; // Store original style before optimistic update

      // --- Optimistic UI Update ---
      layer.featureProperties.driven = optimisticDriven;
      layer.featureProperties.undriveable = optimisticUndriveable;
      const newStyle = this.styleStreet({
        properties: layer.featureProperties,
      });
      layer.setStyle(newStyle);
      // Update the stored original style to reflect the new base state IF successful
      // We'll do this after the API call succeeds.

      // Update info panel if this segment is currently highlighted
      if (this.highlightedLayer === layer && this.mapInfoPanel) {
        this.updateMapInfoPanel(layer.featureProperties);
      }
      this.coverageMap?.closePopup(); // Close popup after action

      try {
        this.notificationManager.show(
          `Marking ${streetName} as ${statusText}...`,
          "info",
        );

        // --- API Call ---
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

        // --- Success ---
        this.notificationManager.show(
          `Marked ${streetName} as ${statusText}.`,
          "success",
        );
        // Update the layer's stored original style to the new state
        layer.originalStyle = { ...newStyle };
        // Refresh overall coverage stats after successful update
        await this.refreshCoverageStats();
      } catch (error) {
        // --- Revert Optimistic Update on Error ---
        console.error(`Error marking segment as ${statusText}:`, error);
        this.notificationManager.show(
          `Failed to mark segment: ${error.message}`,
          "danger",
        );

        // Revert properties and style
        layer.featureProperties.driven = props.driven; // Revert to original props state
        layer.featureProperties.undriveable = props.undriveable;
        layer.setStyle(originalStyle); // Re-apply original style

        // Revert info panel if needed
        if (this.highlightedLayer === layer && this.mapInfoPanel) {
          this.updateMapInfoPanel(layer.featureProperties);
        }
      }
    }

    /**
     * Refreshes the coverage statistics for the currently selected location.
     * @returns {Promise<object|undefined>} The updated coverage data or undefined on error.
     */
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

        // Update the stored selected location data with refreshed stats
        this.selectedLocation = { ...this.selectedLocation, ...data.coverage };

        // Update relevant UI components
        this.updateDashboardStats(this.selectedLocation);
        // Map summary control is updated within updateDashboardStats
        // Chart and breakdown list might need updating if street_types data changed
        this.createStreetTypeChart(this.selectedLocation.street_types);
        this.updateStreetTypeCoverage(this.selectedLocation.street_types);

        this.notificationManager.show("Coverage statistics refreshed.", "info");
        return data.coverage; // Return updated data
      } catch (error) {
        console.error("Error refreshing coverage stats:", error);
        this.notificationManager.show(
          `Failed to refresh stats: ${error.message}`,
          "warning",
        );
        return undefined;
      }
    }

    /**
     * Fits the map view to the bounds of the loaded street data.
     */
    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, { padding: [40, 40] }); // Add some padding
      } else if (this.coverageMap) {
        // Fallback if bounds are invalid or not set
        this.coverageMap.setView([31.55, -97.15], 11); // Example fallback view
        console.warn("Map bounds invalid or not set, using default view.");
      }
    }

    /**
     * Creates or updates the street type breakdown chart using Chart.js.
     * @param {Array<object>} streetTypes - Array of street type statistics.
     */
    createStreetTypeChart(streetTypes) {
      const chartContainer = document.getElementById("street-type-chart");
      if (!chartContainer) return;

      // Destroy existing chart instance if it exists
      if (this.streetTypeChartInstance) {
        this.streetTypeChartInstance.destroy();
        this.streetTypeChartInstance = null;
      }

      // Check if data is available
      if (!streetTypes || !streetTypes.length) {
        chartContainer.innerHTML =
          '<div class="alert alert-secondary small p-2">No street type data for chart.</div>';
        return;
      }

      // Check if Chart.js library is loaded
      if (typeof Chart === "undefined") {
        console.error("Chart.js is not loaded");
        chartContainer.innerHTML =
          '<div class="alert alert-warning">Chart library not found.</div>';
        return;
      }

      // Prepare data for the chart
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.driveable_length_m || 0) - (a.driveable_length_m || 0), // Sort by driveable length
      );
      const topTypes = sortedTypes.slice(0, 7); // Show top 7 types

      const labels = topTypes.map((t) =>
        CoverageManager.formatStreetType(t.type),
      );
      const parseDist = (distStr) => parseFloat(distStr.split(" ")[0]) || 0; // Helper to parse "X mi" string

      // Extract driven and calculate not-driven lengths
      const drivenLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.covered_length_m || 0)),
      );
      const driveableLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.driveable_length_m || 0)),
      );
      const notDrivenLengths = driveableLengths.map((total, i) =>
        parseFloat(Math.max(0, total - drivenLengths[i]).toFixed(2)),
      );

      const lengthUnit = "mi"; // Define the unit used

      // Create canvas for the chart
      chartContainer.innerHTML = "<canvas></canvas>";
      const ctx = chartContainer.querySelector("canvas").getContext("2d");

      // Define colors
      const drivenColor = "rgba(76, 175, 80, 0.8)"; // Green
      const notDrivenColor = "rgba(255, 82, 82, 0.7)"; // Red

      // Create the Chart.js instance
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
          indexAxis: "y", // Horizontal bars
          scales: {
            x: {
              // Now the value axis
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
              // Now the category axis
              stacked: true,
              ticks: { color: "#eee", font: { size: 11 } },
              grid: { display: false }, // Hide vertical grid lines
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
                  const total = driveableLengths[context.dataIndex]; // Get total for percentage
                  const percentage =
                    total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                  return `${label}: ${value.toFixed(2)} ${lengthUnit} (${percentage}%)`;
                },
                footer: (tooltipItems) => {
                  // Add total driveable length to footer
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
            title: { display: false }, // No main chart title needed
          },
        },
      });
    }

    /**
     * Exports the current coverage map view as a PNG image.
     * Requires the leaflet-image library to be loaded.
     */
    exportCoverageMap() {
      // Check if map and export library exist
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

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const locationName = this.selectedLocation.location_name
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const filename = `coverage_map_${locationName}_${timestamp}.png`;

      this.notificationManager.show("Generating map image...", "info");

      // Ensure the correct filter is applied before exporting
      this.setMapFilter(this.currentFilter || "all", false); // false to avoid button updates
      this.coverageMap.invalidateSize(); // Ensure map size is correct

      // Use leafletImage after a short delay to allow rendering updates
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
            // Trigger download
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
          { preferCanvas: true }, // Use canvas renderer for potentially better results
        );
      }, 1000); // Delay to allow map to potentially redraw
    }

    /**
     * Applies a filter to the displayed street segments on the map.
     * @param {string} filterType - The filter type ('all', 'driven', 'undriven').
     * @param {boolean} [updateButtons=true] - Whether to update the filter button UI states.
     */
    setMapFilter(filterType, updateButtons = true) {
      // Ensure necessary components are initialized
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

      // Iterate through each layer within the main GeoJSON layer
      this.streetsGeoJsonLayer.eachLayer((layer) => {
        const props = layer.featureProperties;
        let isVisible = false;

        // Determine visibility based on filter type and properties
        if (filterType === "driven") {
          isVisible = props.driven === true && !props.undriveable;
        } else if (filterType === "undriven") {
          isVisible = props.driven === false && !props.undriveable;
        } else {
          // 'all' or unknown filter shows everything
          isVisible = true;
        }

        // Manage layer visibility and style resets
        if (isVisible) {
          // If becoming visible, add it to the display group if not already there
          if (!this.streetLayers.hasLayer(layer)) {
            // Reset style to original before adding back
            try {
              layer.setStyle(layer.originalStyle);
            } catch (e) {
              console.warn("Style reset failed on add");
            }
            this.streetLayers.addLayer(layer);
          }
          // If this is the currently click-highlighted layer, ensure its highlight style is applied
          if (layer === this.highlightedLayer) {
            layer.setStyle(this.styleStreet(layer.feature, false, true));
            layer.bringToFront(); // Ensure highlighted is on top
          }
          visibleCount++;
        } else {
          // Layer should be hidden
          // If hiding the currently highlighted layer, clear the highlight state first
          if (layer === this.highlightedLayer) {
            this.clearHighlight(); // Resets style and clears reference
          }
          // If hiding the currently hover-highlighted layer
          if (layer === this.hoverHighlightLayer) {
            this.clearHoverHighlight(); // Resets style and clears reference
          }

          // Remove the layer from the display group if it's currently there
          if (this.streetLayers.hasLayer(layer)) {
            // Reset style to original *before* removing, just in case
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

      // Update the UI state of the filter buttons if requested
      if (updateButtons) {
        this.updateFilterButtonStates();
      }
    }

    /**
     * Updates the visual state (active class, colors) of the map filter buttons.
     */
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

        // Reset classes
        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
          "btn-outline-secondary",
        );
        // Default style
        btn.classList.add("btn-outline-secondary");

        // Apply active style if this button matches the current filter
        if (key === this.currentFilter) {
          btn.classList.add("active");
          btn.classList.remove("btn-outline-secondary");
          // Apply specific color based on filter type
          if (key === "driven") btn.classList.add("btn-success");
          else if (key === "undriven") btn.classList.add("btn-danger");
          else btn.classList.add("btn-primary"); // 'all' uses primary
        }
      });
    }

    // --- Static Helper Methods ---

    /** Static helper to get an icon class based on task stage. */
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
      return icons[stage] || '<i class="fas fa-question-circle"></i>'; // Default icon
    }

    /** Static helper to get a text color class based on task stage. */
    static getStageTextClass(stage) {
      const classes = {
        [STATUS.COMPLETE]: "text-success",
        [STATUS.COMPLETED]: "text-success",
        [STATUS.ERROR]: "text-danger",
        [STATUS.WARNING]: "text-warning",
        [STATUS.CANCELED]: "text-warning",
      };
      return classes[stage] || "text-info"; // Default color
    }

    /** Static helper to format a stage key into a human-readable name. */
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
      // Fallback for unknown stages
      return (
        stageNames[stage] ||
        stage.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
      );
    }

    /** Static helper to format a street type key into a human-readable name. */
    static formatStreetType(type) {
      if (!type) return "Unknown";
      // Replace underscores with spaces and capitalize words
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  } // End CoverageManager Class

  // --- Initialization ---
  document.addEventListener("DOMContentLoaded", () => {
    // Check for required libraries (Leaflet, Chart.js)
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
      return; // Stop initialization
    }

    // Instantiate the manager and make it globally accessible (if needed)
    // This now runs *after* DOM is loaded.
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized.");
  });
})(); // End IIFE
