/* global bootstrap, notificationManager, confirmationDialog, L, leafletImage, Chart */
"use strict";

// Define constants for status strings to avoid typos
const STATUS = {
  INITIALIZING: "initializing",
  PREPROCESSING: "preprocessing",
  LOADING_STREETS: "loading_streets",
  INDEXING: "indexing",
  COUNTING_TRIPS: "counting_trips",
  PROCESSING_TRIPS: "processing_trips",
  CALCULATING: "calculating", // Generic calculation/processing
  FINALIZING: "finalizing",
  GENERATING_GEOJSON: "generating_geojson",
  COMPLETE_STATS: "complete_stats",
  COMPLETE: "complete",
  COMPLETED: "completed", // Sometimes used by backend? Standardize if possible.
  ERROR: "error",
  WARNING: "warning",
  CANCELED: "canceled",
  UNKNOWN: "unknown",
  POLLING_CHECK: "polling_check", // Internal state for polling
};

// Add CSS styles for activity indicator and map interactions
(() => {
  const style = document.createElement("style");
  style.id = "coverage-manager-dynamic-styles"; // Add ID to prevent duplicates
  style.textContent = `
    /* --- Progress Modal --- */
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
      color: #adb5bd; /* Lighter gray for dark theme */
      font-size: 0.9em;
      margin-top: 5px;
    }
    .stats-info {
      font-size: 0.9em;
    }
    .stats-info small {
       color: #ced4da; /* Slightly lighter text */
    }
    .stats-info .text-info { color: #3db9d5 !important; }
    .stats-info .text-success { color: #4caf50 !important; }
    .stats-info .text-primary { color: #59a6ff !important; }

    /* --- Map Styling --- */
    .leaflet-popup-content-wrapper {
      background-color: rgba(51, 51, 51, 0.95); /* Slightly more opaque */
      color: #eee;
      box-shadow: 0 3px 14px rgba(0, 0, 0, 0.5);
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .leaflet-popup-tip {
      background: rgba(51, 51, 51, 0.95);
      box-shadow: none;
    }
    .leaflet-popup-content {
        margin: 10px 15px; /* More padding */
        line-height: 1.5;
    }
    .leaflet-popup-content h6 {
        margin-bottom: 8px;
        color: #59a6ff; /* Header color */
        font-size: 1.1em;
    }
     .leaflet-popup-content hr {
        border-top: 1px solid rgba(255, 255, 255, 0.2);
        margin: 8px 0;
    }
    .leaflet-popup-content small {
        font-size: 0.9em;
        color: #ced4da;
    }
    .leaflet-popup-content .street-actions button {
        font-size: 0.75rem;
        padding: 0.2rem 0.5rem;
    }
    .leaflet-popup-content .text-success { color: #4caf50 !important; }
    .leaflet-popup-content .text-danger { color: #ff5252 !important; }
    .leaflet-popup-content .text-warning { color: #ffc107 !important; }
    .leaflet-popup-content .text-info { color: #17a2b8 !important; }


    /* Map Info Panel (Hover/Click) */
    .map-info-panel {
      position: absolute;
      top: 10px; /* Position it relative to the map container */
      left: 10px;
      z-index: 1000;
      background: rgba(40, 40, 40, 0.9);
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none; /* Allow clicks to pass through */
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
      max-width: 250px; /* Slightly wider */
      border-left: 3px solid #007bff;
      display: none; /* Initially hidden */
    }
    .map-info-panel strong { color: #fff; }
    .map-info-panel .text-success { color: #4caf50 !important; }
    .map-info-panel .text-danger { color: #ff5252 !important; }
    .map-info-panel .text-info { color: #17a2b8 !important; }
    .map-info-panel .text-warning { color: #ffc107 !important; }
    .map-info-panel .text-muted { color: #adb5bd !important; }
    .map-info-panel hr.panel-divider {
        border-top: 1px solid rgba(255, 255, 255, 0.2);
        margin: 5px 0;
    }

    /* Coverage Summary Control */
    .coverage-summary-control {
        background: rgba(40, 40, 40, 0.9);
        color: white;
        padding: 10px;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        min-width: 150px;
    }
    .summary-title { font-size: 12px; font-weight: bold; margin-bottom: 5px; color: #ccc; text-transform: uppercase; letter-spacing: 0.5px;}
    .summary-percentage { font-size: 24px; font-weight: bold; margin-bottom: 5px; color: #fff; }
    .summary-progress { margin-bottom: 8px; }
    .summary-details { font-size: 11px; color: #ccc; text-align: right; }

    /* Street Highlight Styles */
    .street-highlighted {
        /* Define a specific class for highlighting if needed,
           otherwise rely on setStyle changes */
    }
  `;
  // Add only if not already present
  if (!document.getElementById(style.id)) {
    document.head.appendChild(style);
  }
})();

(() => {
  class CoverageManager {
    constructor() {
      this.map = null; // General map (if any) - currently unused
      this.coverageMap = null; // Specific map for coverage display
      this.streetLayers = null; // Layer group for street features on the map
      this.streetsGeoJson = null; // Store the raw GeoJSON data for filtering
      this.streetsGeoJsonLayer = null; // Store the Leaflet GeoJSON layer instance
      this.mapBounds = null; // Store bounds for fitting map
      this.selectedLocation = null; // Stores the full data of the currently displayed location
      this.currentProcessingLocation = null; // Location being processed via modal
      this.processingStartTime = null;
      this.lastProgressUpdate = null; // Store last data point for timing estimates
      this.progressTimer = null;
      this.activeTaskIds = new Set(); // Keep track of tasks being polled
      this.validatedLocation = null; // Stores result from /api/validate_location
      this.currentFilter = "all"; // Track current map filter ('all', 'driven', 'undriven')
      this.tooltips = []; // Store Bootstrap tooltip instances
      this.highlightedLayer = null; // Track the currently highlighted map layer (on click)
      this.hoverHighlightLayer = null; // Track the currently hovered map layer
      this.mapInfoPanel = null; // Reference to the hover/click info panel element
      this.coverageSummaryControl = null; // Reference to the map summary control
      this.streetTypeChartInstance = null; // Reference to the Chart.js instance
      this.lastActivityTime = null; // Track when last activity happened for modal indicator

      // --- Removed useMiles --- Units are always miles now

      // Check for notification manager
      if (typeof window.notificationManager === "undefined") {
        console.warn(
          "notificationManager not found, fallbacks will use console.log",
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
          "confirmationDialog not found, fallbacks will use standard confirm()",
        );
        // Simple fallback
        window.confirmationDialog = {
          show: async (options) => {
            // Basic confirmation, doesn't support all options like title/button class
            return confirm(options.message || "Are you sure?");
          },
        };
      }

      // Initialize modals once DOM is ready
      document.addEventListener("DOMContentLoaded", () => {
        this.setupAutoRefresh();
        this.checkForInterruptedTasks(); // Check for interrupted tasks on page load
        this.setupConnectionMonitoring(); // Setup connection status monitoring
        this.initTooltips(); // Initialize tooltips
        this.createMapInfoPanel(); // Create the hover/click info panel element
      });

      this.setupEventListeners();
      this.loadCoverageAreas();
    }

    // --- Unit Conversion ---
    /**
     * Converts meters to miles and formats as a string.
     * @param {number} meters - The distance in meters.
     * @param {number} [fixed=2] - The number of decimal places.
     * @returns {string} Distance in miles (e.g., "1.23 mi").
     */
    distanceInUserUnits(meters, fixed = 2) {
      if (typeof meters !== "number" || isNaN(meters)) {
        meters = 0;
      }
      // Convert meters to miles (1 meter = 0.000621371 miles)
      return (meters * 0.000621371).toFixed(fixed) + " mi";
    }

    // --- Initialization and Setup ---

    setupConnectionMonitoring() {
      const handleConnectionChange = () => {
        const isOnline = navigator.onLine;
        const alertsContainer = document.querySelector("#alerts-container");
        if (!alertsContainer) return;

        // Remove existing status bars first
        alertsContainer
          .querySelectorAll(".connection-status")
          .forEach((el) => el.remove());

        if (!isOnline) {
          const statusBar = document.createElement("div");
          statusBar.className =
            "connection-status alert alert-danger alert-dismissible fade show";
          statusBar.innerHTML = `
            <i class="fas fa-exclamation-triangle me-2"></i>
            <strong>Offline</strong> - Changes cannot be saved while offline.
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
          `;
          alertsContainer.insertBefore(statusBar, alertsContainer.firstChild); // Add to top
        } else {
          // Optionally show a temporary "Connected" message
          const statusBar = document.createElement("div");
          statusBar.className =
            "connection-status alert alert-success alert-dismissible fade show";
          statusBar.innerHTML = `
            <i class="fas fa-wifi me-2"></i>
            <strong>Connected</strong>
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
          `;
          alertsContainer.insertBefore(statusBar, alertsContainer.firstChild);
          // Auto-hide after 5 seconds
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

      // Check initial state
      handleConnectionChange(); // Run once on load
    }

    initTooltips() {
      // Dispose any existing tooltips
      this.tooltips.forEach((tooltip) => {
        if (tooltip && typeof tooltip.dispose === "function") {
          tooltip.dispose();
        }
      });
      this.tooltips = [];

      // Initialize tooltips on elements with data-bs-toggle="tooltip"
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
        // Add data-labels for mobile view
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
      // Refresh the table periodically if any area is processing
      setInterval(async () => {
        // Check if any row has the processing class OR if the modal is showing a processing state
        const isProcessingRow = document.querySelector(".processing-row");
        const isModalProcessing =
          this.currentProcessingLocation &&
          document
            .getElementById("taskProgressModal")
            ?.classList.contains("show");

        if (isProcessingRow || isModalProcessing) {
          await this.loadCoverageAreas();
        }
      }, 10000); // Refresh every 10 seconds if something is processing
    }

    setupEventListeners() {
      // --- Add New Area ---
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

      // --- Progress Modal ---
      document.getElementById("cancel-processing")?.addEventListener(
        "click",
        () => this.cancelProcessing(this.currentProcessingLocation), // Use current context
      );

      document
        .getElementById("taskProgressModal")
        ?.addEventListener("hidden.bs.modal", () => {
          // Only refresh if the task wasn't canceled or errored out before closing
          if (
            this.currentProcessingLocation &&
            this.currentProcessingLocation.status !== STATUS.CANCELED &&
            this.currentProcessingLocation.status !== STATUS.ERROR
          ) {
            this.loadCoverageAreas();
          }
          this.clearProcessingContext(); // Clear context and timer when modal hides
        });

      // Save state on page unload ONLY if modal is actively processing
      window.addEventListener("beforeunload", () => {
        if (this.currentProcessingLocation) {
          this.saveProcessingState();
        }
      });

      // --- Table Actions (Event Delegation) ---
      document
        .querySelector("#coverage-areas-table")
        ?.addEventListener("click", (e) => {
          const targetButton = e.target.closest("button[data-action]"); // Target buttons with data-action
          const targetLink = e.target.closest("a.location-name-link");

          if (targetButton) {
            e.preventDefault();
            const action = targetButton.dataset.action;
            const locationId = targetButton.dataset.locationId;
            const locationStr = targetButton.dataset.location; // Get stringified location for delete/cancel

            if (!locationId && !locationStr) {
              console.error("Action button missing location identifier.");
              window.notificationManager.show(
                "Action failed: Missing location identifier.",
                "danger",
              );
              return;
            }

            // Find the full area data from the table row if needed (for delete/cancel)
            let locationData = null;
            if (locationStr) {
              try {
                locationData = JSON.parse(locationStr);
              } catch (parseError) {
                console.error(
                  "Failed to parse location data from button:",
                  parseError,
                );
                window.notificationManager.show(
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
                if (locationData) this.deleteArea(locationData); // Delete needs display_name
                break;
              case "cancel":
                if (locationData) this.cancelProcessing(locationData); // Cancel needs display_name
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

      // --- Dashboard Actions (Event Delegation on Document) ---
      document.addEventListener("click", (e) => {
        // Handle clicks on the "Update Missing Data" button within the dashboard
        const updateMissingDataBtn = e.target.closest(
          ".update-missing-data-btn",
        );
        if (updateMissingDataBtn) {
          e.preventDefault();
          const locationId = updateMissingDataBtn.dataset.locationId;
          if (locationId) {
            // Trigger a full update when data is missing
            this.updateCoverageForArea(locationId, "full");
          } else {
            console.error("Missing location ID on update button.");
            window.notificationManager.show(
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
          // No need to call toggleFilterButtonState separately, setMapFilter handles it
        }

        // Handle map export button
        const exportButton = e.target.closest("#export-coverage-map");
        if (exportButton) {
          this.exportCoverageMap();
        }
      });

      // --- Map Interaction (specific listeners added when map initializes) ---
    }

    // --- Interrupted Task Handling ---

    checkForInterruptedTasks() {
      const savedProgress = localStorage.getItem("coverageProcessingState");
      if (savedProgress) {
        try {
          const progressData = JSON.parse(savedProgress);
          const now = new Date();
          const savedTime = new Date(progressData.timestamp);

          // Only restore if the saved state is recent (< 1 hour)
          if (now - savedTime < 60 * 60 * 1000) {
            // Check if task is still active on backend? (Optional, more complex)
            // For now, assume we should offer to resume if recent.

            const location = progressData.location; // Should contain display_name etc.
            const taskId = progressData.taskId;

            if (!location || !location.display_name || !taskId) {
              console.warn(
                "Incomplete saved progress data found.",
                progressData,
              );
              localStorage.removeItem("coverageProcessingState");
              return;
            }

            // Show notification with option to resume
            const notification = document.createElement("div");
            notification.className =
              "alert alert-info alert-dismissible fade show mt-3"; // Added margin top
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

            // Add event listeners
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

            // Insert at top of alerts container
            document.querySelector("#alerts-container")?.prepend(notification); // Use prepend
          } else {
            // If too old, just remove it
            localStorage.removeItem("coverageProcessingState");
          }
        } catch (e) {
          console.error("Error restoring saved progress:", e);
          localStorage.removeItem("coverageProcessingState");
        }
      }
    }

    resumeInterruptedTask(savedData) {
      // Re-initiate polling for the saved task ID
      const location = savedData.location;
      const taskId = savedData.taskId;

      if (!location || !location.display_name || !taskId) {
        window.notificationManager.show(
          "Cannot resume task: Incomplete data.",
          "warning",
        );
        localStorage.removeItem("coverageProcessingState");
        return;
      }

      this.currentProcessingLocation = location; // Set context
      this.task_id = taskId; // Set task ID for saving state again if needed
      this.showProgressModal(
        `Checking status for ${location.display_name}...`,
        savedData.progress || 0, // Start with saved progress
      );
      this.activeTaskIds.add(taskId); // Track polling

      // Immediately start polling
      this.pollCoverageProgress(taskId)
        .then(async (finalData) => {
          // Polling finished (successfully or with backend error state)
          if (finalData?.stage !== STATUS.ERROR) {
            window.notificationManager.show(
              `Task for ${location.display_name} completed.`,
              "success",
            );
          }
          // Modal might already be showing final state, don't hide automatically
          // Refresh lists and potentially dashboard
          await this.loadCoverageAreas();
          // If this location was selected, refresh dashboard
          if (
            this.selectedLocation?.location?.display_name ===
            location.display_name
          ) {
            await this.displayCoverageDashboard(this.selectedLocation._id);
          }
        })
        .catch(async (pollError) => {
          // Polling itself failed (network error, timeout, etc.) or task ended in error
          window.notificationManager.show(
            `Failed to resume task for ${location.display_name}: ${pollError.message || pollError}`,
            "danger",
          );
          // Modal might show error state, don't hide automatically here, let user close
          await this.loadCoverageAreas(); // Refresh table to show error status
        })
        .finally(() => {
          this.activeTaskIds.delete(taskId);
          // Don't clear context or hide modal here, let modal close event handle it
          // Remove saved state ONLY if polling didn't fail immediately
          // localStorage.removeItem("coverageProcessingState"); // Let modal close handle this
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
          location: this.currentProcessingLocation, // Store the whole location object used to start
          taskId: this.task_id,
          stage: progressMessageEl?.dataset.stage || STATUS.UNKNOWN, // Store the raw stage string if available
          progress: parseInt(progressBar?.getAttribute("aria-valuenow") || "0"),
          timestamp: new Date().toISOString(),
        };

        localStorage.setItem(
          "coverageProcessingState",
          JSON.stringify(saveData),
        );
        console.log("Saved processing state:", saveData);
      } else {
        // If context is missing, ensure saved state is cleared
        localStorage.removeItem("coverageProcessingState");
      }
    }

    clearProcessingContext() {
      // Clear timer
      if (this.progressTimer) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
      // Remove saved state from local storage
      localStorage.removeItem("coverageProcessingState");
      // Remove unload listener
      window.removeEventListener("beforeunload", this.saveProcessingState); // Use bound function or arrow fn if needed

      // Clear processing context variables
      this.currentProcessingLocation = null;
      this.processingStartTime = null;
      this.lastProgressUpdate = null;
      this.task_id = null; // Clear task ID
      this.lastActivityTime = null;
      console.log("Processing context cleared.");
    }

    // --- API Interaction ---

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

      // Clear previous validation state
      locationInputEl.classList.remove("is-invalid", "is-valid");
      addButton.disabled = true;
      this.validatedLocation = null;

      if (!locationInput) {
        locationInputEl.classList.add("is-invalid");
        window.notificationManager.show("Please enter a location.", "warning");
        return;
      }
      if (!locType) {
        window.notificationManager.show(
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

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Validation request failed (HTTP ${response.status})`,
          );
        }

        // API returns the validated location object on success
        if (!data || !data.osm_id || !data.display_name) {
          locationInputEl.classList.add("is-invalid");
          window.notificationManager.show(
            "Location not found or invalid response. Check input.",
            "warning",
          );
        } else {
          // Success
          locationInputEl.classList.add("is-valid");
          this.validatedLocation = data; // Store the whole validated object
          addButton.disabled = false;
          window.notificationManager.show(
            `Location validated: ${data.display_name}`,
            "success",
          );
        }
      } catch (error) {
        console.error("Error validating location:", error);
        locationInputEl.classList.add("is-invalid");
        window.notificationManager.show(
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
        window.notificationManager.show(
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

      // Use the validated location data directly
      const locationToAdd = { ...this.validatedLocation };

      try {
        // Check if area already exists (fetch current list)
        const currentAreasResponse = await fetch("/api/coverage_areas");
        if (!currentAreasResponse.ok)
          throw new Error("Failed to fetch current coverage areas");
        const { areas } = await currentAreasResponse.json();

        const exists = areas.some(
          (area) => area.location?.display_name === locationToAdd.display_name,
        );

        if (exists) {
          window.notificationManager.show(
            "This area is already tracked.",
            "warning",
          );
          addButton.innerHTML = originalButtonText; // Reset button text
          // Don't disable, allow re-validation if needed
          return;
        }

        // --- Start Processing ---
        this.currentProcessingLocation = locationToAdd; // Set context
        this.task_id = null; // Reset task ID
        this.showProgressModal(
          `Starting processing for ${locationToAdd.display_name}...`,
          0,
        );
        // Add unload listener *after* starting processing
        window.addEventListener("beforeunload", this.saveProcessingState);

        // Trigger the backend preprocessing
        const preprocessResponse = await fetch("/api/preprocess_streets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locationToAdd), // Send the validated location object
        });

        const taskData = await preprocessResponse.json();

        if (!preprocessResponse.ok) {
          this.hideProgressModal(); // Hide modal on initial failure
          throw new Error(
            taskData.detail ||
              `Failed to start processing (HTTP ${preprocessResponse.status})`,
          );
        }

        window.notificationManager.show(
          "Coverage area processing started.",
          "info",
        );

        // Start polling if we got a task ID
        if (taskData?.task_id) {
          this.task_id = taskData.task_id; // Store the task ID for state saving
          this.activeTaskIds.add(taskData.task_id);
          this.saveProcessingState(); // Save state now that we have a task ID

          await this.pollCoverageProgress(taskData.task_id);
          // Polling finished (successfully or with backend error state)
          window.notificationManager.show(
            `Processing for ${locationToAdd.display_name} completed.`,
            "success",
          );
          // Modal will show final state, don't hide automatically
          await this.loadCoverageAreas(); // Refresh table
        } else {
          // No task ID returned (shouldn't happen on success?)
          this.hideProgressModal(); // Hide if no task ID
          window.notificationManager.show(
            "Processing started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas();
        }

        // Reset input form ONLY on successful initiation
        const locationInput = document.getElementById("location-input");
        if (locationInput) {
          locationInput.value = "";
          locationInput.classList.remove("is-valid", "is-invalid");
        }
        this.validatedLocation = null;
      } catch (error) {
        // Error during initial API call or setup
        console.error("Error adding coverage area:", error);
        window.notificationManager.show(
          `Failed to add coverage area: ${error.message}`,
          "danger",
        );
        this.hideProgressModal(); // Hide modal on error
        await this.loadCoverageAreas(); // Refresh table to remove temp row if any
      } finally {
        // Only reset button state here, context/modal handled by specific paths/events
        addButton.disabled = true; // Keep disabled until next validation
        addButton.innerHTML = originalButtonText;
      }
    }

    async updateCoverageForArea(locationId, mode = "full") {
      if (!locationId) {
        window.notificationManager.show(
          "Invalid location ID provided for update.",
          "warning",
        );
        return;
      }

      // Fetch the location details first to ensure we have the correct object for context
      let locationData;
      try {
        const response = await fetch(`/api/coverage_areas/${locationId}`);
        const data = await response.json();
        if (!data.success || !data.coverage || !data.coverage.location) {
          throw new Error(
            data.error || "Failed to fetch location details for update.",
          );
        }
        locationData = data.coverage.location; // Get the location object
        if (!locationData.display_name)
          throw new Error("Location details missing display name.");
      } catch (fetchError) {
        window.notificationManager.show(
          `Failed to start update: ${fetchError.message}`,
          "danger",
        );
        return;
      }

      // Prevent multiple updates on the same location simultaneously
      if (
        this.currentProcessingLocation?.display_name ===
        locationData.display_name
      ) {
        window.notificationManager.show(
          `Update already in progress for ${locationData.display_name}.`,
          "info",
        );
        // Optionally bring the existing modal to the front if hidden
        this.showProgressModal(
          `Update already running for ${locationData.display_name}...`,
        );
        return;
      }

      // Store the location for the entire process
      const processingLocation = { ...locationData };

      try {
        this.currentProcessingLocation = processingLocation;
        this.task_id = null; // Reset task ID

        // Check if we are updating the currently displayed dashboard location
        const isUpdatingDisplayedLocation =
          this.selectedLocation?._id === locationId;

        this.showProgressModal(
          `Requesting coverage update (${mode}) for ${processingLocation.display_name}...`,
        );
        // Add unload listener *after* starting processing
        window.addEventListener("beforeunload", this.saveProcessingState);

        const endpoint =
          mode === "incremental"
            ? "/api/street_coverage/incremental"
            : "/api/street_coverage";

        // Send location properties directly (not nested) as expected by the API
        // Assuming API expects the LocationModel structure directly
        const payload = { ...processingLocation };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (!response.ok) {
          // Handle specific errors like 422 Validation Error
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
          this.task_id = data.task_id; // Store task ID
          this.activeTaskIds.add(data.task_id);
          this.saveProcessingState(); // Save state now

          await this.pollCoverageProgress(data.task_id);
          // Polling finished
          window.notificationManager.show(
            `Coverage update for ${processingLocation.display_name} completed.`,
            "success",
          );
          // Modal shows final state, don't hide automatically
          await this.loadCoverageAreas(); // Refresh table
          if (isUpdatingDisplayedLocation) {
            await this.displayCoverageDashboard(locationId); // Refresh dashboard
          }
        } else {
          this.hideProgressModal(); // Hide if no task ID
          window.notificationManager.show(
            "Update started, but no task ID received for progress tracking.",
            "warning",
          );
          await this.loadCoverageAreas();
        }
      } catch (error) {
        console.error("Error updating coverage:", error);
        window.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
        this.hideProgressModal(); // Hide modal on error
        await this.loadCoverageAreas(); // Refresh table to show potential error status
      }
      // No finally block to hide modal - let close event handle context cleanup
    }

    async cancelProcessing(location = null) {
      const locationToCancel = location || this.currentProcessingLocation;
      if (!locationToCancel || !locationToCancel.display_name) {
        window.notificationManager.show(
          "No active processing context found to cancel.",
          "warning",
        );
        return;
      }

      // Add confirmation dialog
      const confirmed = await window.confirmationDialog.show({
        title: "Cancel Processing",
        message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>? This cannot be undone.`,
        confirmText: "Yes, Cancel",
        cancelText: "No, Continue",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      window.notificationManager.show(
        `Attempting to cancel processing for ${locationToCancel.display_name}...`,
        "info",
      );

      try {
        // API expects the LocationModel structure
        const payload = { display_name: locationToCancel.display_name }; // Send only needed field if possible

        const response = await fetch("/api/coverage_areas/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail ||
              `Failed to send cancel request (HTTP ${response.status})`,
          );
        }

        window.notificationManager.show(
          `Processing for ${locationToCancel.display_name} cancelled.`,
          "success",
        );
        this.hideProgressModal(); // Close the progress modal
        await this.loadCoverageAreas(); // Refresh the table to show 'canceled' status
      } catch (error) {
        console.error("Error cancelling processing:", error);
        window.notificationManager.show(
          `Failed to cancel processing: ${error.message}`,
          "danger",
        );
        // Don't hide modal on failure, maybe the task is still running
      } finally {
        // Clear context only if cancellation was attempted for the *current* processing location
        if (
          this.currentProcessingLocation?.display_name ===
          locationToCancel.display_name
        ) {
          // Context cleared via hideProgressModal -> hidden.bs.modal event
        }
      }
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
        message: `Are you sure you want to delete <strong>${location.display_name}</strong>?<br><br>This will permanently delete all associated street data, statistics, and history. This action cannot be undone.`,
        confirmText: "Delete Permanently",
        confirmButtonClass: "btn-danger",
      });

      if (!confirmed) return;

      try {
        window.notificationManager.show(
          `Deleting coverage area: ${location.display_name}...`,
          "info",
        );

        // API expects LocationModel structure
        const payload = { display_name: location.display_name }; // Send minimal data

        const response = await fetch("/api/coverage_areas/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json(); // Try parsing JSON regardless of status

        if (!response.ok) {
          throw new Error(
            data.detail || `Failed to delete area (HTTP ${response.status})`,
          );
        }

        await this.loadCoverageAreas(); // Refresh the table

        // Hide dashboard if the deleted location was being viewed
        if (
          this.selectedLocation?.location?.display_name ===
          location.display_name
        ) {
          const dashboard = document.getElementById("coverage-dashboard");
          if (dashboard) dashboard.style.display = "none";
          this.selectedLocation = null; // Clear selected location
          if (this.coverageMap) {
            this.coverageMap.remove();
            this.coverageMap = null;
          }
          this.clearDashboardUI(); // Clear stats, chart etc.
        }

        window.notificationManager.show(
          `Coverage area '${location.display_name}' deleted.`,
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

        this.constructor.updateCoverageTable(data.areas, this); // Pass instance for distance formatting

        // Apply responsive enhancements after table update
        this.enhanceResponsiveTables();

        // Re-initialize tooltips after table update
        this.initTooltips();
      } catch (error) {
        console.error("Error loading coverage areas:", error);
        window.notificationManager.show(
          `Failed to load coverage areas: ${error.message}.`,
          "danger",
        );
        // Show error in table body
        const tableBody = document.querySelector("#coverage-areas-table tbody");
        if (tableBody) {
          tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Error loading data: ${error.message}</td></tr>`;
        }
      }
    }

    // --- Progress Polling ---

    async pollCoverageProgress(taskId) {
      const maxRetries = 360; // ~30 minutes (5s interval)
      let retries = 0;
      let lastStage = null;
      let consecutiveSameStage = 0;

      while (retries < maxRetries) {
        if (!this.activeTaskIds.has(taskId)) {
          console.log(
            `Polling stopped for task ${taskId} as it's no longer active.`,
          );
          throw new Error("Polling canceled"); // Or return specific status
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
              // Handle potentially incomplete final responses gracefully
              if (response.ok && retries > 5) {
                // If OK and polled a few times
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

          // Update modal UI
          this.updateModalContent(data);
          this.updateStepIndicators(data.stage, data.progress);
          this.lastActivityTime = new Date(); // Update activity time on successful poll
          this.saveProcessingState(); // Save state after UI update

          // Check for terminal states
          if (
            data.stage === STATUS.COMPLETE ||
            data.stage === STATUS.COMPLETED
          ) {
            console.log(`Task ${taskId} completed successfully.`);
            this.updateModalContent({ ...data, progress: 100 }); // Ensure 100%
            this.updateStepIndicators(STATUS.COMPLETE, 100);
            return data; // Success
          } else if (data.stage === STATUS.ERROR) {
            console.error(
              `Task ${taskId} failed with error: ${data.error || data.message || "Unknown error"}`,
            );
            throw new Error(
              data.error || data.message || "Coverage calculation failed",
            );
          } else if (data.stage === STATUS.CANCELED) {
            console.log(`Task ${taskId} was canceled.`);
            throw new Error("Task was canceled");
          }

          // Check for stalled progress
          if (data.stage === lastStage) {
            consecutiveSameStage++;
            if (consecutiveSameStage > 12) {
              // Stalled for > 1 minute
              console.warn(
                `Task ${taskId} seems stalled at stage: ${data.stage}`,
              );
              // Optionally add warning to modal?
            }
          } else {
            lastStage = data.stage;
            consecutiveSameStage = 0;
          }

          // Wait before next poll
          await new Promise((resolve) => setTimeout(resolve, 5000)); // 5-second interval
          retries++;
        } catch (error) {
          // Handle polling errors (network, parse, 404, backend error state)
          console.error(
            `Error polling coverage progress for task ${taskId}:`,
            error,
          );
          this.updateModalContent({
            stage: STATUS.ERROR,
            progress: this.currentProcessingLocation?.progress || 0, // Keep last known progress
            message: `Polling failed: ${error.message}`,
            error: error.message,
            metrics: {},
          });
          this.updateStepIndicators(
            STATUS.ERROR,
            this.currentProcessingLocation?.progress || 0,
          );
          this.activeTaskIds.delete(taskId); // Stop polling this task
          throw error; // Re-throw to signal failure to the caller
        }
      } // End while loop

      // If loop finishes without completion (timeout)
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

    // --- UI Updates (Table, Modal, Dashboard) ---

    static updateCoverageTable(areas, instance) {
      const tableBody = document.querySelector("#coverage-areas-table tbody");
      if (!tableBody) return;

      tableBody.innerHTML = ""; // Clear existing rows

      if (!areas || areas.length === 0) {
        tableBody.innerHTML =
          '<tr><td colspan="7" class="text-center fst-italic text-muted py-4">No coverage areas defined yet.</td></tr>';
        return;
      }

      // Sort areas by name
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
        // Use the instance's method for conversion - API provides meters
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

        // Escape location data for delete/cancel actions (needs display_name)
        const escapedLocation = JSON.stringify({
          display_name: area.location?.display_name || "",
        }).replace(/'/g, "&apos;");
        const locationId = area._id; // Use ID for updates/viewing

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
      const progressDetails = modalElement.querySelector(".progress-details"); // Container for stage, stats, time
      const cancelBtn = document.getElementById("cancel-processing");

      // Ensure details container exists
      if (!progressDetails) {
        console.error("Progress details container not found in modal.");
        return;
      }

      // Reset modal state visually
      if (modalTitle)
        modalTitle.textContent = this.currentProcessingLocation?.display_name
          ? `Processing: ${this.currentProcessingLocation.display_name}`
          : "Processing Coverage";

      if (modalProgressBar) {
        modalProgressBar.style.width = `${progress}%`;
        modalProgressBar.setAttribute("aria-valuenow", progress);
        modalProgressBar.classList.remove(
          "bg-success",
          "bg-danger",
          "bg-warning",
        ); // Reset color
        modalProgressBar.classList.add(
          "progress-bar-striped",
          "progress-bar-animated",
        );
      }
      if (progressMessage) {
        progressMessage.textContent = message;
        progressMessage.classList.remove("text-danger", "text-success");
        progressMessage.removeAttribute("data-stage"); // Clear stage data attribute
      }

      // Clear previous details
      progressDetails.querySelector(".stage-info").innerHTML = "";
      progressDetails.querySelector(".stats-info").innerHTML = "";
      progressDetails.querySelector(".elapsed-time").textContent =
        "Elapsed: 0s";
      progressDetails.querySelector(".estimated-time").textContent = ""; // No estimation

      if (cancelBtn) cancelBtn.disabled = false; // Enable cancel button initially

      // Start timer only if not already running
      if (!this.progressTimer) {
        this.processingStartTime = Date.now();
        this.lastActivityTime = Date.now();
        this.progressTimer = setInterval(() => {
          this.updateTimingInfo();
          this.updateActivityIndicator();
        }, 1000);
        // Run immediately to set initial values
        this.updateTimingInfo();
        this.updateActivityIndicator();
      }

      // Show the modal using Bootstrap API
      const bsModal = bootstrap.Modal.getOrCreateInstance(modalElement, {
        backdrop: "static", // Prevent closing on backdrop click
        keyboard: false, // Prevent closing with Esc key
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
        // Fallback if instance not found (shouldn't happen with getOrCreateInstance)
        modalElement.style.display = "none";
        modalElement.classList.remove("show");
        document.body.classList.remove("modal-open");
        const backdrop = document.querySelector(".modal-backdrop");
        if (backdrop) backdrop.remove();
      }
      // Context cleanup happens on 'hidden.bs.modal' event
    }

    updateModalContent(data) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement || !this.currentProcessingLocation) return; // Only update if modal is relevant

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

      // Update progress bar
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.setAttribute("aria-valuenow", progress);
        progressBar.classList.remove(
          "progress-bar-striped",
          "progress-bar-animated",
          "bg-success",
          "bg-danger",
        );
        if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
          progressBar.classList.add("bg-success");
        } else if (stage === STATUS.ERROR) {
          progressBar.classList.add("bg-danger");
        } else {
          progressBar.classList.add(
            "progress-bar-striped",
            "progress-bar-animated",
          );
        }
      }

      // Update main message and store stage
      if (progressMessageEl) {
        progressMessageEl.textContent = error ? `Error: ${error}` : message;
        progressMessageEl.dataset.stage = stage; // Store stage for state saving
        progressMessageEl.classList.toggle(
          "text-danger",
          stage === STATUS.ERROR,
        );
        progressMessageEl.classList.toggle(
          "text-success",
          stage === STATUS.COMPLETE || stage === STATUS.COMPLETED,
        );
      }

      // Update stage info (e.g., "Step 3/5: Indexing Streets")
      if (stageInfoEl) {
        const stageName = this.constructor.formatStageName(stage);
        const stageIcon = this.constructor.getStageIcon(stage);
        stageInfoEl.innerHTML = `${stageIcon} ${stageName}`;
        stageInfoEl.className = `stage-info mb-2 text-${this.constructor.getStageTextClass(stage)}`;
      }

      // Update detailed stats
      if (statsInfoEl) {
        statsInfoEl.innerHTML = this.formatMetricStats(stage, metrics);
      }

      // Disable cancel button on final states
      if (cancelBtn) {
        cancelBtn.disabled =
          stage === STATUS.COMPLETE ||
          stage === STATUS.COMPLETED ||
          stage === STATUS.ERROR ||
          stage === STATUS.CANCELED;
      }

      // Stop timer and animation on final states
      if (
        stage === STATUS.COMPLETE ||
        stage === STATUS.COMPLETED ||
        stage === STATUS.ERROR ||
        stage === STATUS.CANCELED
      ) {
        if (this.progressTimer) {
          clearInterval(this.progressTimer);
          this.progressTimer = null;
          // Ensure final elapsed time is displayed correctly
          this.updateTimingInfo();
          // Clear estimated time display
          const estimatedTimeEl = modalElement.querySelector(".estimated-time");
          if (estimatedTimeEl) estimatedTimeEl.textContent = "";
        }
        this.updateActivityIndicator(false); // Set indicator to inactive
      }
    }

    updateStepIndicators(stage, progress) {
      const modalElement = document.getElementById("taskProgressModal");
      if (!modalElement) return;

      const steps = {
        initializing: modalElement.querySelector(".step-initializing"),
        preprocessing: modalElement.querySelector(".step-preprocessing"),
        indexing: modalElement.querySelector(".step-indexing"),
        calculating: modalElement.querySelector(".step-calculating"), // Represents trip processing
        complete: modalElement.querySelector(".step-complete"), // Represents finalizing/generating GeoJSON/completion
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

      if (stage === STATUS.ERROR) {
        // Try to mark the step where the error likely occurred
        // This mapping is approximate
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
          // Error during final stages
          markComplete("initializing");
          markComplete("preprocessing");
          markComplete("indexing");
          markComplete("calculating");
          markError("complete");
        }
      } else if (stage === STATUS.COMPLETE || stage === STATUS.COMPLETED) {
        Object.keys(steps).forEach(markComplete); // Mark all as complete
      } else {
        // Mark progress based on current stage
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
          // Default or unknown stage - mark initial as active
          markActive("initializing");
        }
      }
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

      // Update time display elements within the modal
      const elapsedTimeEl = document.querySelector(
        "#taskProgressModal .elapsed-time",
      );
      const estimatedTimeEl = document.querySelector(
        "#taskProgressModal .estimated-time",
      ); // Keep reference if needed elsewhere

      if (elapsedTimeEl) elapsedTimeEl.textContent = `Elapsed: ${elapsedText}`;
      if (estimatedTimeEl) estimatedTimeEl.textContent = ""; // Estimation removed
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
          this.lastActivityTime && now - this.lastActivityTime < 10000; // Active if polled within last 10s
      }

      if (currentlyActive) {
        activityIndicator.classList.add("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-circle-notch fa-spin text-info me-1"></i>Active';
        if (this.lastActivityTime) {
          lastUpdateEl.textContent = `Last update: ${this.formatTimeAgo(this.lastActivityTime)}`;
        } else {
          lastUpdateEl.textContent = "";
        }
      } else {
        activityIndicator.classList.remove("pulsing");
        activityIndicator.innerHTML =
          '<i class="fas fa-hourglass-half text-secondary me-1"></i>Idle';
        if (this.lastActivityTime) {
          lastUpdateEl.textContent = `Last update: ${this.formatTimeAgo(this.lastActivityTime)}`;
        } else {
          lastUpdateEl.textContent = "No recent activity";
        }
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

      // Display relevant metrics based on stage
      if (
        stage === STATUS.INDEXING ||
        stage === STATUS.PREPROCESSING ||
        stage === STATUS.LOADING_STREETS
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
        stage === STATUS.PROCESSING_TRIPS ||
        stage === STATUS.CALCULATING ||
        stage === STATUS.COUNTING_TRIPS
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

    // --- Dashboard Display ---

    async displayCoverageDashboard(locationId) {
      const dashboardContainer = document.getElementById("coverage-dashboard");
      const dashboardLocationName = document.getElementById(
        "dashboard-location-name",
      );
      const mapContainer = document.getElementById("coverage-map");
      const chartContainer = document.getElementById("street-type-chart");
      const statsContainer = document.querySelector(
        ".dashboard-stats-card .stats-container",
      ); // Target stats container
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
        return;
      }

      // --- Show Loading State ---
      dashboardContainer.style.display = "block";
      dashboardLocationName.innerHTML =
        '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span> Loading...';
      mapContainer.innerHTML = this.constructor.createLoadingIndicator(
        "Loading map data...",
      );
      chartContainer.innerHTML = this.constructor.createLoadingIndicator(
        "Loading chart data...",
      );
      statsContainer.innerHTML = this.constructor.createLoadingIndicator(
        "Loading statistics...",
      );
      streetTypeCoverageEl.innerHTML = this.constructor.createLoadingIndicator(
        "Loading breakdown...",
      );
      // Scroll to dashboard smoothly after setting loading states
      dashboardContainer.scrollIntoView({ behavior: "smooth", block: "start" });

      try {
        // Fetch detailed data using the location ID
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

        this.selectedLocation = data.coverage; // Store full data
        const coverage = data.coverage;

        // --- Populate UI ---
        const locationName = coverage.location_name || "Coverage Details";
        dashboardLocationName.textContent = locationName; // Update title (no badges here yet)

        // Update stats (pass the whole coverage object)
        this.updateDashboardStats(coverage);

        // Handle map and chart data availability
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
          // Show status message instead of map/chart
          let statusMessageHtml;
          let chartMessageHtml =
            '<div class="alert alert-secondary small p-2">Chart requires map data.</div>';
          let notificationType = "info";
          let notificationMessage = `Map data unavailable for ${locationName}.`;

          if (hasError) {
            statusMessageHtml = this.constructor.createAlertMessage(
              "Error in Last Calculation",
              coverage.error_message || "An unexpected error occurred.",
              "danger",
              locationId, // Pass ID for the update button
            );
            notificationType = "danger";
            notificationMessage = `Error loading map for ${locationName}.`;
          } else if (isCurrentlyProcessing) {
            statusMessageHtml = this.constructor.createAlertMessage(
              "Processing in Progress",
              `Coverage data for ${locationName} is currently being processed (Status: ${this.constructor.formatStageName(status)}). The map will be available once complete.`,
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Chart data will be available after processing.</div>';
            notificationMessage = `Processing map data for ${locationName}...`;
            // Auto-refresh dashboard if processing
            setTimeout(() => this.displayCoverageDashboard(locationId), 15000); // Refresh after 15 seconds
          } else if (status === STATUS.COMPLETED && !hasStreetData) {
            statusMessageHtml = this.constructor.createAlertMessage(
              "Finalizing Map Data",
              "Coverage statistics calculated. Generating detailed map data...",
              "info",
            );
            chartMessageHtml =
              '<div class="alert alert-info small p-2">Generating chart data...</div>';
            notificationMessage = `Finalizing map data for ${locationName}.`;
            // Auto-refresh
            setTimeout(() => this.displayCoverageDashboard(locationId), 10000); // Refresh after 10 seconds
          } else {
            // Needs reprocessing or other non-error state without data
            statusMessageHtml = this.constructor.createAlertMessage(
              "Map Data Not Available",
              "Please update the coverage data to generate the map.",
              "warning",
              locationId, // Pass ID for the update button
            );
            notificationType = "warning";
            notificationMessage = `Map data needs to be generated for ${locationName}.`;
          }

          mapContainer.innerHTML = statusMessageHtml;
          chartContainer.innerHTML = chartMessageHtml; // Clear chart area or show message
          window.notificationManager.show(
            notificationMessage,
            notificationType,
          );
        } else {
          // --- Success Path: Has Street Data ---
          window.notificationManager.show(
            `Loaded coverage map for ${locationName}`,
            "success",
          );

          // Initialize map and chart
          this.initializeCoverageMap(coverage); // Handles clearing/creating map
          this.createStreetTypeChart(coverage.street_types); // Handles clearing/creating chart
          this.updateStreetTypeCoverage(coverage.street_types); // Update breakdown list

          // Ensure map fits bounds after initialization
          this.fitMapToBounds();
        }

        // Re-initialize tooltips after dashboard potentially updated
        this.initTooltips();
      } catch (error) {
        console.error("Error displaying coverage dashboard:", error);
        dashboardLocationName.textContent = "Error Loading Data";
        mapContainer.innerHTML = `<div class="alert alert-danger p-4"><strong>Error:</strong> ${error.message}</div>`;
        chartContainer.innerHTML = ""; // Clear chart area
        statsContainer.innerHTML = `<div class="text-danger p-2">Failed to load stats.</div>`;
        streetTypeCoverageEl.innerHTML = `<div class="text-danger p-2">Failed to load breakdown.</div>`;
        window.notificationManager.show(
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

      // API provides lengths in meters
      const totalLengthM = coverage.total_length || 0;
      const drivenLengthM = coverage.driven_length || 0;
      // Assume driveable_length_m might be in street_types or calculated implicitly
      // Let's use the main driven/total for the primary stats display
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

      // Update the separate street type coverage breakdown list
      this.updateStreetTypeCoverage(coverage.street_types);

      // Update map summary control if map exists
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

      // Sort by total length (assuming total_length_m exists in streetTypes)
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.total_length_m || 0) - (a.total_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 6); // Show top 6

      let html = "";
      topTypes.forEach((type) => {
        const coveragePct = type.coverage_percentage?.toFixed(1) || "0.0";
        // Use metric fields and unit conversion
        // Assume covered_length_m and driveable_length_m exist in streetTypes
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
                        <small><strong>${this.constructor.formatStreetType(type.type)}</strong></small>
                        <small>${coveragePct}% (${coveredDist} / ${driveableDist})</small>
                    </div>
                    <div class="progress" style="height: 8px;" title="${this.constructor.formatStreetType(type.type)}: ${coveragePct}% Covered">
                        <div class="progress-bar ${barColor}" role="progressbar" style="width: ${coveragePct}%"
                             aria-valuenow="${coveragePct}" aria-valuemin="0" aria-valuemax="100"></div>
                    </div>
                </div>
            `;
      });

      streetTypeCoverageEl.innerHTML = html;
    }

    clearDashboardUI() {
      // Clear stats, chart, map, etc. when dashboard is hidden or data removed
      document.getElementById("dashboard-location-name").textContent =
        "Select a location";
      document.querySelector(
        ".dashboard-stats-card .stats-container",
      ).innerHTML = "";
      document.getElementById("street-type-chart").innerHTML = "";
      document.getElementById("street-type-coverage").innerHTML = "";
      const mapContainer = document.getElementById("coverage-map");
      if (mapContainer) mapContainer.innerHTML = ""; // Clear map container
      if (this.coverageMap) {
        this.coverageMap.remove();
        this.coverageMap = null;
      }
      this.selectedLocation = null;
      this.streetsGeoJson = null;
      this.streetsGeoJsonLayer = null;
      this.highlightedLayer = null;
      this.hoverHighlightLayer = null;
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

    // --- Map Interaction and Display ---

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
        // Prefer canvas for performance with many lines, but SVG needed for some interactions/styling
        // Let Leaflet decide for now, or choose based on testing:
        // preferCanvas: true
      });

      // Add dark base layer
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

      // Add custom attribution control
      L.control.attribution({ prefix: false }).addTo(this.coverageMap);

      // Add streets layer
      this.addStreetsToMap(coverage.streets_geojson); // This also sets this.mapBounds

      // Add hover effects (now implemented)
      this.addMapHoverEffects();

      // Add summary control
      this.addCoverageSummary(coverage);

      // Re-apply filter on zoom/move end to potentially optimize rendering? (Maybe not needed with style approach)
      // this.coverageMap.off("moveend").on("moveend", () => {
      //    this.setMapFilter(this.currentFilter || "all", false); // Pass false to avoid redundant button updates
      // });

      // Add listener to clear highlight when map background is clicked
      this.coverageMap.on("click", () => {
        this.clearHighlight();
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
      });
    }

    styleStreet(feature, isHover = false, isHighlight = false) {
      const props = feature.properties;
      const isDriven = props.driven;
      const isUndriveable = props.undriveable;
      // Use 'highway' or 'inferred_highway_type' or default
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      const baseWeight = 3;
      let weight = baseWeight;

      // Adjust weight based on type for visual hierarchy
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

      let color;
      let opacity = 0.75; // Base opacity
      let dashArray = null;

      if (isUndriveable) {
        color = "#607d8b"; // Muted blue-gray for undriveable
        opacity = 0.6;
        dashArray = "4, 4";
      } else if (isDriven) {
        color = "#4caf50"; // Green for driven
      } else {
        color = "#ff5252"; // Red for undriven
      }

      // Apply hover/highlight styles
      if (isHighlight) {
        weight += 2;
        opacity = 1;
        color = "#ffff00"; // Yellow highlight on click
      } else if (isHover) {
        weight += 1.5;
        opacity = 0.95;
        // Keep original color on hover, just make thicker/more opaque
      }

      return {
        color: color,
        weight: weight,
        opacity: opacity,
        dashArray: dashArray,
        // className: className, // Less useful with direct styling
      };
    }

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
        return;
      }

      this.streetsGeoJsonLayer = L.geoJSON(geojson, {
        style: (feature) => this.styleStreet(feature), // Use base style initially
        onEachFeature: (feature, layer) => {
          // Store original style for resetting highlight/hover
          layer.originalStyle = this.styleStreet(feature);
          // Store feature properties for easy access in handlers
          layer.featureProperties = feature.properties;

          // --- Click Handler (Highlighting & Popup) ---
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
            // layer.openPopup();
          });

          // --- Hover Handlers ---
          layer.on("mouseover", (e) => {
            if (layer !== this.highlightedLayer) {
              // Don't apply hover if already click-highlighted
              this.clearHoverHighlight(); // Clear previous hover highlight
              this.hoverHighlightLayer = layer;
              layer.setStyle(this.styleStreet(feature, true, false)); // Apply hover style
              layer.bringToFront();
              // Optionally update info panel on hover too, or just highlight
              // this.updateMapInfoPanel(feature.properties, true); // Pass 'isHover=true'
              // if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
            }
          });
          layer.on("mouseout", (e) => {
            if (layer === this.hoverHighlightLayer) {
              this.clearHoverHighlight();
              // if (this.mapInfoPanel && layer !== this.highlightedLayer) {
              //     this.mapInfoPanel.style.display = 'none'; // Hide panel if it was shown on hover
              // }
            }
          });

          // --- Bind Popup (for manual marking actions) ---
          layer.bindPopup(() => this.createStreetPopupContent(layer), {
            closeButton: true, // Add close button
            minWidth: 240,
            className: "coverage-popup", // Custom class for styling
          });
        },
      }).addTo(this.streetLayers);

      // Store bounds and the layer itself
      this.mapBounds = this.streetsGeoJsonLayer.getBounds();
    }

    createStreetPopupContent(layer) {
      const props = layer.featureProperties;
      // Use 'name' if available, fallback to 'street_name', then default
      const streetName = props.name || props.street_name || "Unnamed Street";
      const streetType =
        props.highway || props.inferred_highway_type || "unknown";
      // Assume segment_length_m exists in properties
      const lengthMiles = this.distanceInUserUnits(props.segment_length_m || 0);
      const status = props.driven ? "Driven" : "Not Driven";
      const segmentId = props.segment_id || "N/A";

      const popupContent = document.createElement("div");
      popupContent.className = "street-popup-content"; // Use specific class
      popupContent.innerHTML = `
            <h6>${streetName}</h6>
            <hr>
            <small>
                <strong>Type:</strong> ${this.constructor.formatStreetType(streetType)}<br>
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

      // Add event listeners to the buttons within this specific popup instance
      const self = this; // Reference to CoverageManager instance
      popupContent
        .querySelector(".mark-driven-btn")
        ?.addEventListener("click", function () {
          self.markStreetSegment(layer, "driven");
        });
      popupContent
        .querySelector(".mark-undriven-btn")
        ?.addEventListener("click", function () {
          self.markStreetSegment(layer, "undriven");
        });
      popupContent
        .querySelector(".mark-undriveable-btn")
        ?.addEventListener("click", function () {
          self.markStreetSegment(layer, "undriveable");
        });
      popupContent
        .querySelector(".mark-driveable-btn")
        ?.addEventListener("click", function () {
          self.markStreetSegment(layer, "driveable");
        });

      return popupContent;
    }

    addMapHoverEffects() {
      // Hover effects are now added directly in onEachFeature using mouseover/mouseout listeners
      console.log("Map hover effects initialized via onEachFeature.");
    }

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
          // Fallback: try setting a default style
          this.highlightedLayer.setStyle({
            weight: 3,
            opacity: 0.7,
            color: "#ff5252",
          }); // Example fallback
        }
        this.highlightedLayer = null;
      }
    }

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
        }
        this.hoverHighlightLayer = null;
      }
    }

    createMapInfoPanel() {
      // Create the panel div but keep it hidden initially
      this.mapInfoPanel = document.createElement("div");
      this.mapInfoPanel.className = "map-info-panel";
      // Append it to the map container's parent or body to ensure correct positioning context
      // Or append directly to map container if position: relative is set on it
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
                <span class="text-info">${this.constructor.formatStreetType(streetType)}</span>
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
      // Position panel near mouse/feature? More complex. For now, fixed top-left.
    }

    addCoverageSummary(coverage) {
      if (!this.coverageMap) return;

      // Remove existing summary control if present
      if (this.coverageSummaryControl) {
        this.coverageMap.removeControl(this.coverageSummaryControl);
        this.coverageSummaryControl = null;
      }

      // Use L.Control for better integration
      const CoverageSummaryControl = L.Control.extend({
        options: { position: "topright" }, // Position top-right
        onAdd: () => {
          const container = L.DomUtil.create(
            "div",
            "coverage-summary-control leaflet-bar",
          );
          // Prevent map clicks when interacting with the control
          L.DomEvent.disableClickPropagation(container);
          L.DomEvent.disableScrollPropagation(container);

          const coveragePercentage =
            coverage.coverage_percentage?.toFixed(1) || "0.0";
          // Use instance method for conversion
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
        onRemove: () => {
          // Cleanup if needed
        },
      });

      this.coverageSummaryControl = new CoverageSummaryControl();
      this.coverageSummaryControl.addTo(this.coverageMap);
    }

    async markStreetSegment(layer, action) {
      const props = layer.featureProperties;
      if (!props || !props.segment_id) {
        window.notificationManager.show("Missing segment ID.", "danger");
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation._id) {
        window.notificationManager.show("Missing location context.", "danger");
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
          optimisticDriven = false; // Keep undriveable status as is unless explicitly changed
          optimisticUndriveable = props.undriveable;
          break;
        case "undriveable":
          apiEndpoint = "/api/street_segments/mark_undriveable";
          statusText = "undriveable";
          optimisticDriven = props.driven; // Keep driven status
          optimisticUndriveable = true;
          break;
        case "driveable":
          apiEndpoint = "/api/street_segments/mark_driveable";
          statusText = "driveable";
          optimisticDriven = props.driven; // Keep driven status
          optimisticUndriveable = false;
          break;
        default:
          window.notificationManager.show("Invalid action specified", "danger");
          return;
      }

      const streetName = props.name || props.street_name || "Unnamed Street";
      const originalStyle = layer.originalStyle; // Store before optimistic update

      // --- Optimistic UI Update ---
      layer.featureProperties.driven = optimisticDriven;
      layer.featureProperties.undriveable = optimisticUndriveable;
      const newStyle = this.styleStreet({
        properties: layer.featureProperties,
      });
      layer.setStyle(newStyle);
      layer.originalStyle = { ...newStyle }; // Update original style to reflect change

      // Update info panel if this layer is highlighted
      if (this.highlightedLayer === layer && this.mapInfoPanel) {
        this.updateMapInfoPanel(layer.featureProperties);
      }
      // Close popup
      this.coverageMap?.closePopup();

      try {
        window.notificationManager.show(
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

        window.notificationManager.show(
          `Marked ${streetName} as ${statusText}.`,
          "success",
        );

        // Refresh the coverage statistics from the backend
        await this.refreshCoverageStats();
      } catch (error) {
        console.error(`Error marking segment as ${statusText}:`, error);
        window.notificationManager.show(
          `Failed to mark segment: ${error.message}`,
          "danger",
        );

        // --- Revert Optimistic Update on Error ---
        layer.featureProperties.driven = props.driven; // Revert props
        layer.featureProperties.undriveable = props.undriveable;
        layer.setStyle(originalStyle); // Revert style
        layer.originalStyle = { ...originalStyle }; // Revert stored original style

        // Update info panel if this layer is highlighted
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

        // Update the main selectedLocation data
        this.selectedLocation = { ...this.selectedLocation, ...data.coverage };

        // Update the dashboard stats display
        this.updateDashboardStats(this.selectedLocation);
        // Update the map summary control
        this.addCoverageSummary(this.selectedLocation);
        // Update the chart? Might require re-fetching street_types if they changed
        this.createStreetTypeChart(this.selectedLocation.street_types);
        // Update the street type list
        this.updateStreetTypeCoverage(this.selectedLocation.street_types);

        window.notificationManager.show(
          "Coverage statistics refreshed.",
          "info",
        );
        return data;
      } catch (error) {
        console.error("Error refreshing coverage stats:", error);
        window.notificationManager.show(
          `Failed to refresh stats: ${error.message}`,
          "warning",
        );
        // Don't re-throw, allow UI to continue
      }
    }

    fitMapToBounds() {
      if (this.coverageMap && this.mapBounds && this.mapBounds.isValid()) {
        this.coverageMap.fitBounds(this.mapBounds, { padding: [40, 40] }); // Slightly more padding
      } else if (this.coverageMap) {
        // Fallback if bounds are invalid or not set yet
        this.coverageMap.setView([31.55, -97.15], 11); // Default view (Waco, TX)
        console.warn("Map bounds invalid or not set, using default view.");
      }
    }

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
          '<div class="alert alert-warning">Chart library not found.</div>';
        return;
      }

      // Prepare data (top 7 types based on driveable length)
      // Assume driveable_length_m exists in streetTypes
      const sortedTypes = [...streetTypes].sort(
        (a, b) => (b.driveable_length_m || 0) - (a.driveable_length_m || 0),
      );
      const topTypes = sortedTypes.slice(0, 7);
      const labels = topTypes.map((t) =>
        this.constructor.formatStreetType(t.type),
      );

      // Use distanceInUserUnits and parse the numeric part
      const parseDist = (distStr) => parseFloat(distStr.split(" ")[0]) || 0;
      // Assume covered_length_m and driveable_length_m exist
      const drivenLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.covered_length_m || 0)),
      );
      const driveableLengths = topTypes.map((t) =>
        parseDist(this.distanceInUserUnits(t.driveable_length_m || 0)),
      );
      const notDrivenLengths = driveableLengths.map((total, i) =>
        parseFloat(Math.max(0, total - drivenLengths[i]).toFixed(2)),
      );
      const lengthUnit = "mi"; // Always miles

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
          indexAxis: "y", // Horizontal bars
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
              grid: { display: false }, // Hide Y grid lines for clarity
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
                  // Find total driveable length for this bar (type)
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
            title: {
              // Use Chart.js title plugin
              display: false, // Title is in the card header now
              // text: "Driveable Coverage by Street Type (Top 7)",
              // color: "#eee", padding: { top: 5, bottom: 10 },
            },
          },
        },
      });
    }

    exportCoverageMap() {
      if (!this.coverageMap || typeof leafletImage === "undefined") {
        window.notificationManager.show(
          "Map export library (leaflet-image) not available.",
          "warning",
        );
        return;
      }
      if (!this.selectedLocation || !this.selectedLocation.location_name) {
        window.notificationManager.show(
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

      window.notificationManager.show("Generating map image...", "info");

      // Ensure layers are visible based on the current filter before exporting
      this.setMapFilter(this.currentFilter || "all", false); // false to prevent button state flicker

      // Force redraw and wait slightly longer
      this.coverageMap.invalidateSize();
      setTimeout(() => {
        leafletImage(
          this.coverageMap,
          (err, canvas) => {
            if (err) {
              console.error("Error generating map image:", err);
              window.notificationManager.show(
                `Failed to generate map image: ${err.message || err}`,
                "danger",
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
          { preferCanvas: true }, // Use canvas renderer for export consistency
        );
      }, 1000); // Wait 1 second
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
          // 'all' includes driven, undriven, and undriveable
          isVisible = true;
        }

        // Apply style based on visibility
        if (isVisible) {
          // Ensure the correct base style is applied (not hover/highlight)
          if (layer === this.highlightedLayer) {
            // Re-apply highlight style if it should be visible
            layer.setStyle(this.styleStreet(layer.feature, false, true));
          } else {
            // Apply original style
            layer.setStyle(layer.originalStyle);
          }
          // Ensure layer is added to the visible group (might be redundant if always in group)
          if (!this.streetLayers.hasLayer(layer)) {
            this.streetLayers.addLayer(layer);
          }
          visibleCount++;
        } else {
          // Hide the layer effectively by removing from the map group
          if (this.streetLayers.hasLayer(layer)) {
            this.streetLayers.removeLayer(layer);
          }
          // Or set style to transparent (less performant if many layers)
          // layer.setStyle({ opacity: 0, fillOpacity: 0, interactive: false });
        }
      });

      console.log(`Filter applied. Visible segments: ${visibleCount}`);

      // Update button states if requested
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

        // Reset styles
        btn.classList.remove(
          "active",
          "btn-primary",
          "btn-success",
          "btn-danger",
          "btn-outline-secondary",
        );
        btn.classList.add("btn-outline-secondary"); // Default outline

        // Apply active style
        if (key === this.currentFilter) {
          btn.classList.add("active");
          btn.classList.remove("btn-outline-secondary");
          if (key === "driven") btn.classList.add("btn-success");
          else if (key === "undriven") btn.classList.add("btn-danger");
          else btn.classList.add("btn-primary"); // 'all' is primary
        }
      });
    }

    // --- Static Helpers ---

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
      return classes[stage] || "text-info"; // Default to info
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
      // Capitalize first letter, replace underscores
      return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    }
  } // End of CoverageManager class

  // Initialize on DOM load
  document.addEventListener("DOMContentLoaded", () => {
    // Ensure Leaflet and Chart.js are loaded before initializing
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
    // Make instance globally accessible if needed, or manage scope differently
    window.coverageManager = new CoverageManager();
    console.log("Coverage Manager initialized.");
  });
})(); // IIFE
