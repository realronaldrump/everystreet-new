/**
 * Coverage Manager - Main Orchestrator
 * Coordinates all coverage management modules
 */

/* global bootstrap, Chart, mapboxgl, html2canvas */

import dateUtils from "../date-utils.js";
import COVERAGE_API from "./coverage-api.js";
import CoverageDrawing from "./coverage-drawing.js";
import CoverageMap from "./coverage-map.js";
import CoverageNavigation from "./coverage-navigation.js";
import CoverageProgress from "./coverage-progress.js";
import CoverageSelection from "./coverage-selection.js";
import CoverageUI from "./coverage-ui.js";

class CoverageManager {
  constructor() {
    // Initialize notification and confirmation dialog
    this.notificationManager = window.notificationManager || {
      show: (message, type, _duration = 3000) => {
        console.log(`[${type || "info"}] Notification: ${message}`);
      },
    };

    this.confirmationDialog = window.confirmationDialog || {
      show: async (options) => this.showEnhancedConfirmDialog(options),
    };

    // Initialize modules
    this.progress = new CoverageProgress(this.notificationManager);
    this.coverageMap = new CoverageMap(this.notificationManager);
    this.ui = new CoverageUI(this.notificationManager);
    this.drawing = new CoverageDrawing(this.notificationManager);
    this.selection = new CoverageSelection(
      this.coverageMap,
      this.notificationManager,
    );
    this.navigation = new CoverageNavigation(
      this.coverageMap,
      this.notificationManager,
    );

    // State
    this.selectedLocation = null;
    this.currentDashboardLocationId = null;
    this.currentProcessingLocation = null;
    this.validatedLocation = null;
    this.validatedCustomBoundary = null;
    this.currentAreaDefinitionType = "location";
    this.currentFilter = "all";
    this.showTripsActive = false;
    this.pendingOperations = new Map();
    this.dataCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000;

    // Initialize
    this.setupEventListeners();
    this.setupCustomEventListeners();
    this.loadCoverageAreas();
    this.initializeQuickActions();
    this.setupAccessibility();
    this.setupThemeListener();
    this.checkForInterruptedTasks();
    this.setupAutoRefresh();
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Location validation
    document
      .getElementById("validate-location")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.validateLocation();
      });

    // Drawing validation
    document
      .getElementById("validate-drawing")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.validateCustomBoundary();
      });

    // Clear drawing
    document.getElementById("clear-drawing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.drawing.clearDrawing();
    });

    // Add coverage area
    document
      .getElementById("add-coverage-area")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.addCoverageArea();
      });

    // Add custom area
    document
      .getElementById("add-custom-area")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.addCustomCoverageArea();
      });

    // Cancel processing
    document
      .getElementById("cancel-processing")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        this.cancelProcessing(this.currentProcessingLocation);
      });

    // Modal events
    document
      .getElementById("taskProgressModal")
      ?.addEventListener("hidden.bs.modal", () => {
        this.progress.clearProcessingContext();
      });

    document
      .getElementById("addAreaModal")
      ?.addEventListener("shown.bs.modal", () => {
        if (this.currentAreaDefinitionType === "draw") {
          this.drawing.initializeDrawingMap();
        }
      });

    document
      .getElementById("addAreaModal")
      ?.addEventListener("hidden.bs.modal", () => {
        this.drawing.cleanupDrawingMap();
        this.resetModalState();
      });

    // Area definition type change
    document
      .querySelectorAll('input[name="area-definition-type"]')
      .forEach((radio) => {
        radio.addEventListener("change", (e) => {
          this.handleAreaDefinitionTypeChange(e.target.value);
        });
      });

    // Table actions
    document
      .querySelector("#coverage-areas-table")
      ?.addEventListener("click", (e) => {
        const targetButton = e.target.closest("button[data-action]");
        const targetLink = e.target.closest("a.location-name-link");
        if (targetButton) {
          e.preventDefault();
          e.stopPropagation();
          this.handleTableAction(targetButton);
        } else if (targetLink) {
          e.preventDefault();
          e.stopPropagation();
          const { locationId } = targetLink.dataset;
          if (locationId) {
            this.displayCoverageDashboard(locationId);
          }
        }
      });

    // Dashboard controls
    document.addEventListener("click", (e) => {
      const filterButton = e.target.closest(
        ".map-controls button[data-filter]",
      );
      if (filterButton) {
        this.coverageMap.setMapFilter(filterButton.dataset.filter);
      }

      const exportButton = e.target.closest("#export-coverage-map");
      if (exportButton) {
        this.exportCoverageMap();
      }

      const tripToggle = e.target.closest("#toggle-trip-overlay");
      if (tripToggle) {
        this.handleTripOverlayToggle(tripToggle.checked);
      }
    });
  }

  /**
   * Setup custom event listeners
   */
  setupCustomEventListeners() {
    document.addEventListener("coverageToggleSegment", (e) => {
      this.selection.toggleSegmentSelection(e.detail);
    });

    document.addEventListener("coverageSegmentAction", (e) => {
      this.handleMarkSegmentAction(e.detail.action, e.detail.segmentId);
    });

    document.addEventListener("coverageBulkAction", (e) => {
      this.handleBulkMarkSegments(e.detail);
    });

    document.addEventListener("coverageShowStreet", (e) => {
      this.showStreetOnMap(e.detail);
    });

    document.addEventListener("coverageFilterChanged", (e) => {
      this.updateFilterButtonStates(e.detail);
    });

    document.addEventListener("coverageRetryTask", (e) => {
      if (e.detail.taskId) {
        this.progress.activeTaskIds.add(e.detail.taskId);
        this.progress._addBeforeUnloadListener();
        this.progress
          .pollCoverageProgress(e.detail.taskId, (_data) => {
            // Handle update
          })
          .catch(console.error);
      }
    });

    document.addEventListener("coverageClearEfficientMarkers", () => {
      this.navigation.clearEfficientStreetMarkers();
    });

    document.addEventListener("coverageTableRedrawn", () => {
      this.initTooltips();
    });

    document.addEventListener("coverageMapReady", () => {
      // Map is ready, ensure selection toolbar is created
      this.selection.createBulkActionToolbar();
    });
  }

  /**
   * Load coverage areas
   */
  async loadCoverageAreas(showLoading = true, silent = false) {
    const tableBody = document.querySelector("#coverage-areas-table tbody");
    if (!tableBody) return;

    if (showLoading && !silent) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center">
            <div class="empty-state">
              <div class="loading-indicator mb-3"></div>
              <p class="mb-0">Loading coverage areas...</p>
            </div>
          </td>
        </tr>
      `;
    }

    try {
      const areas = await COVERAGE_API.getAllAreas();
      this.ui.updateCoverageTable(
        areas,
        this.formatRelativeTime.bind(this),
        this.progress.formatStageName.bind(this.progress),
        this.distanceInUserUnits.bind(this),
      );
      this.ui.initializeDataTable();
      this.initTooltips();
      this.updateTotalAreasCount(areas.length);
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      if (!silent) {
        this.notificationManager.show(
          `Failed to load coverage areas: ${error.message}.`,
          "danger",
        );
      }
      if (tableBody) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="7" class="text-center text-danger">
              <div class="empty-state">
                <i class="fas fa-exclamation-circle mb-2"></i>
                <p>Error loading data: ${error.message}</p>
                <button class="btn btn-sm btn-primary mt-2" onclick="window.coverageManager.loadCoverageAreas()">
                  <i class="fas fa-redo me-1"></i>Retry
                </button>
              </div>
            </td>
          </tr>
        `;
      }
    }
  }

  /**
   * Display coverage dashboard
   */
  async displayCoverageDashboard(locationId) {
    this.currentDashboardLocationId = locationId;

    const dashboardElement = document.getElementById("coverage-dashboard");
    const locationNameElement = document.getElementById(
      "dashboard-location-name",
    );
    const mapContainer = document.getElementById("coverage-map");

    if (!dashboardElement || !locationNameElement || !mapContainer) {
      console.error("Essential dashboard elements not found.");
      this.notificationManager.show(
        "UI Error: Dashboard components missing.",
        "danger",
      );
      return;
    }

    this.ui.clearDashboardUI();
    dashboardElement.style.display = "block";
    dashboardElement.classList.add("fade-in-up");

    locationNameElement.innerHTML =
      '<span class="loading-skeleton" style="width: 150px; display: inline-block;"></span>';

    const chartContainer = document.getElementById("street-type-chart");
    if (chartContainer)
      chartContainer.innerHTML = this.ui.createLoadingSkeleton(180);
    const coverageEl = document.getElementById("street-type-coverage");
    if (coverageEl)
      coverageEl.innerHTML = this.ui.createLoadingSkeleton(100, 3);
    mapContainer.innerHTML = this.ui.createLoadingIndicator(
      "Loading map data...",
    );

    try {
      const cachedData = this.getCachedData(`dashboard-${locationId}`);
      let coverageData;

      if (cachedData) {
        coverageData = cachedData;
        this.notificationManager.show(
          "Loaded dashboard from cache.",
          "info",
          1500,
        );
      } else {
        coverageData = await COVERAGE_API.getArea(locationId);
        const streetsGeoJson = await COVERAGE_API.getStreets(locationId, true);
        coverageData.streets_geojson = streetsGeoJson;
        this.setCachedData(`dashboard-${locationId}`, coverageData);
      }

      this.selectedLocation = coverageData;
      locationNameElement.textContent =
        coverageData.location.display_name || "Unnamed Area";
      this.ui.updateDashboardStats(
        coverageData,
        this.distanceInUserUnits.bind(this),
        this.formatRelativeTime.bind(this),
      );
      this.ui.updateStreetTypeCoverage(
        coverageData.street_types || [],
        this.distanceInUserUnits.bind(this),
        this.formatStreetType.bind(this),
      );
      this.ui.createStreetTypeChart(
        coverageData.street_types || [],
        this.formatStreetType.bind(this),
        this.distanceInUserUnits.bind(this),
      );
      this.updateFilterButtonStates();

      this.coverageMap.initializeCoverageMap(coverageData);

      // Initialize bulk action toolbar after map is ready
      this.selection.createBulkActionToolbar();

      // Update undriven streets list
      if (coverageData.streets_geojson) {
        this.ui.updateUndrivenStreetsList(
          coverageData.streets_geojson,
          this.distanceInUserUnits.bind(this),
        );
      }

      this.showTripsActive =
        localStorage.getItem("showTripsOverlay") === "true";
      const tripToggle = document.getElementById("toggle-trip-overlay");
      if (tripToggle) tripToggle.checked = this.showTripsActive;
    } catch (error) {
      console.error("Error displaying coverage dashboard:", error);
      locationNameElement.textContent = "Error loading data";
      this.notificationManager.show(
        `Error loading dashboard: ${error.message}`,
        "danger",
      );
      mapContainer.innerHTML = this.ui.createAlertMessage(
        "Dashboard Load Error",
        error.message,
        "danger",
      );
    } finally {
      this.initTooltips();
    }
  }

  /**
   * Validate location
   */
  async validateLocation() {
    const locationInputEl = document.getElementById("location-input");
    const locationTypeEl = document.getElementById("location-type");
    const validateButton = document.getElementById("validate-location");
    const addButton = document.getElementById("add-coverage-area");

    if (!locationInputEl || !locationTypeEl || !validateButton || !addButton) {
      console.error("Validation form elements not found.");
      return;
    }

    const locationInput = locationInputEl.value.trim();
    const locType = locationTypeEl.value;

    locationInputEl.classList.remove("is-invalid", "is-valid");
    addButton.disabled = true;
    this.validatedLocation = null;

    if (!locationInput) {
      locationInputEl.classList.add("is-invalid", "shake-animation");
      this.notificationManager.show("Please enter a location.", "warning");
      return;
    }

    const originalButtonContent = validateButton.innerHTML;
    validateButton.disabled = true;
    validateButton.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Validating...';

    try {
      const data = await COVERAGE_API.validateLocation(locationInput, locType);

      if (!data || !data.osm_id || !data.display_name) {
        locationInputEl.classList.add("is-invalid");
        this.notificationManager.show(
          "Location not found. Please check your input.",
          "warning",
        );
      } else {
        locationInputEl.classList.add("is-valid");
        this.validatedLocation = data;
        addButton.disabled = false;

        const validationResult = document.getElementById("validation-result");
        if (validationResult) {
          validationResult.classList.remove("d-none");
          validationResult.querySelector(".validation-message").textContent =
            `Found: ${data.display_name}`;
        }

        this.notificationManager.show(
          `Location validated: ${data.display_name}`,
          "success",
        );
        addButton.focus();
      }
    } catch (error) {
      console.error("Error validating location:", error);
      locationInputEl.classList.add("is-invalid");
      this.notificationManager.show(
        `Validation failed: ${error.message}`,
        "danger",
      );
    } finally {
      validateButton.disabled = false;
      validateButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Add coverage area
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
    const modal = bootstrap.Modal.getInstance(
      document.getElementById("addAreaModal"),
    );

    if (!addButton) return;

    const originalButtonContent = addButton.innerHTML;
    addButton.disabled = true;
    addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

    const locationToAdd = { ...this.validatedLocation };
    const segLenEl = document.getElementById("segment-length-input");
    if (segLenEl?.value) {
      const val = parseInt(segLenEl.value, 10);
      if (!Number.isNaN(val) && val > 0)
        locationToAdd.segment_length_meters = val;
    }
    const bufEl = document.getElementById("match-buffer-input");
    if (bufEl?.value) {
      const v = parseFloat(bufEl.value);
      if (!Number.isNaN(v) && v > 0) locationToAdd.match_buffer_meters = v;
    }
    const minEl = document.getElementById("min-match-length-input");
    if (minEl?.value) {
      const v2 = parseFloat(minEl.value);
      if (!Number.isNaN(v2) && v2 > 0)
        locationToAdd.min_match_length_meters = v2;
    }

    try {
      const areas = await COVERAGE_API.getAllAreas();
      const exists = areas.some(
        (area) => area.location?.display_name === locationToAdd.display_name,
      );

      if (exists) {
        this.notificationManager.show(
          "This area is already being tracked.",
          "warning",
        );
        return;
      }

      if (modal) modal.hide();

      this.currentProcessingLocation = locationToAdd;
      this.progress.currentProcessingLocation = locationToAdd;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      this.progress.showProgressModal(
        `Starting processing for ${locationToAdd.display_name}...`,
        0,
      );

      const taskData = await COVERAGE_API.preprocessStreets(locationToAdd);

      this.notificationManager.show(
        "Coverage area processing started.",
        "info",
      );

      if (taskData?.task_id) {
        this.progress.currentTaskId = taskData.task_id;
        this.progress.activeTaskIds.add(taskData.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(taskData.task_id, (_data) => {
          // Progress updates handled by progress module
        });

        this.notificationManager.show(
          `Processing for ${locationToAdd.display_name} completed.`,
          "success",
        );

        await this.loadCoverageAreas();
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Processing started, but no task ID received.",
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
      this.updateTotalAreasCount();
    } catch (error) {
      console.error("Error adding coverage area:", error);
      this.notificationManager.show(
        `Failed to add coverage area: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
      await this.loadCoverageAreas();
    } finally {
      addButton.disabled = true;
      addButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Validate custom boundary
   */
  async validateCustomBoundary() {
    const customAreaNameInput = document.getElementById("custom-area-name");
    const validateButton = document.getElementById("validate-drawing");
    const addButton = document.getElementById("add-custom-area");

    if (!customAreaNameInput || !validateButton) {
      console.error("Required form elements not found.");
      return;
    }

    const areaName = customAreaNameInput.value.trim();
    if (!areaName) {
      customAreaNameInput.classList.add("is-invalid", "shake-animation");
      this.notificationManager.show("Please enter an area name.", "warning");
      return;
    }

    const drawnFeatures = this.drawing.getAllDrawnFeatures();
    if (!drawnFeatures.features || drawnFeatures.features.length === 0) {
      this.notificationManager.show(
        "Please draw a polygon boundary first.",
        "warning",
      );
      return;
    }

    const polygon = drawnFeatures.features[0];
    if (polygon.geometry.type !== "Polygon") {
      this.notificationManager.show(
        "Please draw a polygon boundary.",
        "warning",
      );
      return;
    }

    customAreaNameInput.classList.remove("is-invalid", "is-valid");
    if (addButton) addButton.disabled = true;
    this.validatedCustomBoundary = null;
    this.drawing.hideDrawingValidationResult();

    const originalButtonContent = validateButton.innerHTML;
    validateButton.disabled = true;
    validateButton.innerHTML =
      '<i class="fas fa-spinner fa-spin"></i> Validating...';

    try {
      const data = await COVERAGE_API.validateCustomBoundary(
        areaName,
        polygon.geometry,
      );

      if (!data || !data.valid) {
        customAreaNameInput.classList.add("is-invalid");
        this.notificationManager.show(
          "Custom boundary validation failed. Please check your drawing.",
          "warning",
        );
      } else {
        customAreaNameInput.classList.add("is-valid");
        this.validatedCustomBoundary = data;
        this.drawing.validatedCustomBoundary = data;
        if (addButton) addButton.disabled = false;

        this.drawing.showDrawingValidationResult(data);

        this.notificationManager.show(
          `Custom boundary "${data.display_name}" validated successfully!`,
          "success",
        );

        if (addButton) addButton.focus();
      }
    } catch (error) {
      console.error("Error validating custom boundary:", error);
      customAreaNameInput.classList.add("is-invalid");
      this.notificationManager.show(
        `Validation failed: ${error.message}`,
        "danger",
      );
    } finally {
      validateButton.disabled = false;
      validateButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Add custom coverage area
   */
  async addCustomCoverageArea() {
    if (
      !this.validatedCustomBoundary ||
      !this.validatedCustomBoundary.display_name
    ) {
      this.notificationManager.show(
        "Please validate your custom boundary first.",
        "warning",
      );
      return;
    }

    const addButton = document.getElementById("add-custom-area");
    const modal = bootstrap.Modal.getInstance(
      document.getElementById("addAreaModal"),
    );

    if (!addButton) return;

    const originalButtonContent = addButton.innerHTML;
    addButton.disabled = true;
    addButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

    const customAreaToAdd = { ...this.validatedCustomBoundary };
    const segLenEl2 = document.getElementById("segment-length-input");
    if (segLenEl2?.value) {
      const val2 = parseInt(segLenEl2.value, 10);
      if (!Number.isNaN(val2) && val2 > 0)
        customAreaToAdd.segment_length_meters = val2;
    }
    const bufElC = document.getElementById("match-buffer-input");
    if (bufElC?.value) {
      const v = parseFloat(bufElC.value);
      if (!Number.isNaN(v) && v > 0) customAreaToAdd.match_buffer_meters = v;
    }
    const minElC = document.getElementById("min-match-length-input");
    if (minElC?.value) {
      const v2 = parseFloat(minElC.value);
      if (!Number.isNaN(v2) && v2 > 0)
        customAreaToAdd.min_match_length_meters = v2;
    }

    try {
      const areas = await COVERAGE_API.getAllAreas();
      const exists = areas.some(
        (area) => area.location?.display_name === customAreaToAdd.display_name,
      );

      if (exists) {
        this.notificationManager.show(
          "This area name is already being tracked.",
          "warning",
        );
        return;
      }

      if (modal) modal.hide();

      this.currentProcessingLocation = customAreaToAdd;
      this.progress.currentProcessingLocation = customAreaToAdd;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      this.progress.showProgressModal(
        `Starting processing for ${customAreaToAdd.display_name}...`,
        0,
      );

      const taskData =
        await COVERAGE_API.preprocessCustomBoundary(customAreaToAdd);

      this.notificationManager.show(
        "Custom coverage area processing started.",
        "info",
      );

      if (taskData?.task_id) {
        this.progress.currentTaskId = taskData.task_id;
        this.progress.activeTaskIds.add(taskData.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(taskData.task_id);

        this.notificationManager.show(
          `Processing for ${customAreaToAdd.display_name} completed.`,
          "success",
        );

        await this.loadCoverageAreas();
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Processing started, but no task ID received.",
          "warning",
        );
        await this.loadCoverageAreas();
      }

      const customAreaName = document.getElementById("custom-area-name");
      if (customAreaName) {
        customAreaName.value = "";
      }
      this.validatedCustomBoundary = null;
      this.updateTotalAreasCount();
    } catch (error) {
      console.error("Error adding custom coverage area:", error);
      this.notificationManager.show(
        `Failed to add custom coverage area: ${error.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
      await this.loadCoverageAreas();
    } finally {
      addButton.disabled = true;
      addButton.innerHTML = originalButtonContent;
    }
  }

  /**
   * Update coverage for area
   */
  async updateCoverageForArea(
    locationId,
    mode = "full",
    showNotification = true,
  ) {
    if (!locationId) {
      this.notificationManager.show(
        "Invalid location ID provided for update.",
        "warning",
      );
      return;
    }

    if (this.pendingOperations.has(`update-${locationId}`)) {
      this.notificationManager.show(
        "Update already in progress for this location.",
        "info",
      );
      return;
    }

    try {
      this.pendingOperations.set(`update-${locationId}`, async () =>
        this.updateCoverageForArea(locationId, mode, showNotification),
      );

      const locationData = await COVERAGE_API.getArea(locationId);

      if (
        this.currentProcessingLocation?.display_name ===
        locationData.location.display_name
      ) {
        this.notificationManager.show(
          `Update already in progress for ${locationData.location.display_name}.`,
          "info",
        );
        this.progress.showProgressModal(
          `Update already running for ${locationData.location.display_name}...`,
        );
        return;
      }

      const processingLocation = { ...locationData.location };

      this.currentProcessingLocation = processingLocation;
      this.progress.currentProcessingLocation = processingLocation;
      this.progress.currentTaskId = null;
      this.progress._addBeforeUnloadListener();

      const isUpdatingDisplayedLocation =
        this.selectedLocation?._id === locationId;

      this.progress.showProgressModal(
        `Requesting ${mode} update for ${processingLocation.display_name}...`,
      );

      const data = await COVERAGE_API.updateCoverage(processingLocation, mode);

      if (data.task_id) {
        this.progress.currentTaskId = data.task_id;
        this.progress.activeTaskIds.add(data.task_id);
        this.progress.saveProcessingState();

        await this.progress.pollCoverageProgress(data.task_id);

        if (showNotification) {
          this.notificationManager.show(
            `Coverage update for ${processingLocation.display_name} completed.`,
            "success",
          );
        }

        await this.loadCoverageAreas();

        if (isUpdatingDisplayedLocation) {
          await this.displayCoverageDashboard(locationId);
        }
      } else {
        this.progress.hideProgressModal();
        this.notificationManager.show(
          "Update started, but no task ID received.",
          "warning",
        );
        await this.loadCoverageAreas();
      }
    } catch (error) {
      console.error("Error updating coverage:", error);
      if (showNotification) {
        this.notificationManager.show(
          `Coverage update failed: ${error.message}`,
          "danger",
        );
      }
      this.progress.hideProgressModal();
      await this.loadCoverageAreas();
      throw error;
    } finally {
      this.pendingOperations.delete(`update-${locationId}`);
    }
  }

  /**
   * Cancel processing
   */
  async cancelProcessing(location = null) {
    const locationToCancel = location || this.currentProcessingLocation;

    if (!locationToCancel || !locationToCancel.display_name) {
      this.notificationManager.show(
        "No active processing to cancel.",
        "warning",
      );
      return;
    }

    const confirmed = await this.confirmationDialog.show({
      title: "Cancel Processing",
      message: `Are you sure you want to cancel processing for <strong>${locationToCancel.display_name}</strong>?`,
      details:
        "This will stop the current operation. You can restart it later.",
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
      await COVERAGE_API.cancelProcessing(locationToCancel.display_name);

      this.notificationManager.show(
        `Processing for ${locationToCancel.display_name} cancelled.`,
        "success",
      );

      if (
        this.currentProcessingLocation?.display_name ===
        locationToCancel.display_name
      ) {
        if (this.progress.currentTaskId) {
          this.progress.activeTaskIds.delete(this.progress.currentTaskId);
          this.progress._removeBeforeUnloadListener();
        }
        this.progress.hideProgressModal();
      }

      await this.loadCoverageAreas();
    } catch (error) {
      console.error("Error cancelling processing:", error);
      this.notificationManager.show(
        `Failed to cancel processing: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Delete area
   */
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
      message: `Are you sure you want to delete <strong>${location.display_name}</strong>?`,
      details:
        "This will permanently delete all associated street data, statistics, and history. This action cannot be undone.",
      confirmText: "Delete Permanently",
      confirmButtonClass: "btn-danger",
    });

    if (!confirmed) return;

    try {
      this.notificationManager.show(
        `Deleting coverage area: ${location.display_name}...`,
        "info",
      );

      await COVERAGE_API.deleteArea(location.display_name);

      await this.loadCoverageAreas();

      if (
        this.selectedLocation?.location?.display_name === location.display_name
      ) {
        this.closeCoverageDashboard();
      }

      this.notificationManager.show(
        `Coverage area '${location.display_name}' deleted.`,
        "success",
      );

      this.updateTotalAreasCount();
    } catch (error) {
      console.error("Error deleting coverage area:", error);
      this.notificationManager.show(
        `Error deleting coverage area: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Handle table action
   */
  handleTableAction(button) {
    const { action } = button.dataset;
    const { locationId } = button.dataset;
    const locationStr = button.dataset.location;

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
      } catch (_parseError) {
        this.notificationManager.show(
          "Action failed: Invalid location data.",
          "danger",
        );
        return;
      }
    }

    button.classList.add("loading-pulse");
    button.disabled = true;

    const resetButton = () => {
      button.classList.remove("loading-pulse");
      button.disabled = false;
    };

    switch (action) {
      case "update-full":
        if (locationId) {
          this.updateCoverageForArea(locationId, "full").finally(resetButton);
        }
        break;
      case "update-incremental":
        if (locationId) {
          this.updateCoverageForArea(locationId, "incremental").finally(
            resetButton,
          );
        }
        break;
      case "delete":
        if (locationData) {
          this.deleteArea(locationData).finally(resetButton);
        }
        break;
      case "cancel":
        if (locationData) {
          this.cancelProcessing(locationData).finally(resetButton);
        }
        break;
      case "reprocess":
        if (locationId) {
          this.reprocessStreetsForArea(locationId).finally(resetButton);
        }
        break;
      default:
        this.notificationManager.show(
          `Unknown table action: ${action}`,
          "warning",
        );
        resetButton();
    }
  }

  /**
   * Handle mark segment action
   */
  async handleMarkSegmentAction(action, segmentId) {
    const activeLocationId =
      this.selectedLocation?._id || this.currentDashboardLocationId;
    if (!activeLocationId || !segmentId) {
      this.notificationManager.show(
        "Cannot perform action: Missing ID.",
        "warning",
      );
      return;
    }

    try {
      await COVERAGE_API.markSegment(activeLocationId, segmentId, action);
      this.notificationManager.show(
        `Segment marked as ${action}. Refreshing...`,
        "success",
        2000,
      );

      // Optimistic UI update
      if (
        this.coverageMap.streetsGeoJson?.features &&
        this.coverageMap.map?.getSource("streets")
      ) {
        const featureIndex = this.coverageMap.streetsGeoJson.features.findIndex(
          (f) => f.properties.segment_id === segmentId,
        );
        if (featureIndex !== -1) {
          const feature =
            this.coverageMap.streetsGeoJson.features[featureIndex];
          switch (action) {
            case "driven":
              feature.properties.driven = true;
              feature.properties.undriveable = false;
              break;
            case "undriven":
              feature.properties.driven = false;
              break;
            case "undriveable":
              feature.properties.undriveable = true;
              feature.properties.driven = false;
              break;
            case "driveable":
              feature.properties.undriveable = false;
              break;
          }
          const newGeoJson = {
            ...this.coverageMap.streetsGeoJson,
            features: [...this.coverageMap.streetsGeoJson.features],
          };
          newGeoJson.features[featureIndex] = { ...feature };
          this.coverageMap.map.getSource("streets").setData(newGeoJson);
          this.coverageMap.streetsGeoJson = newGeoJson;
          this.ui.updateUndrivenStreetsList(
            this.coverageMap.streetsGeoJson,
            this.distanceInUserUnits.bind(this),
          );
        }
      }

      await this.refreshDashboardData(activeLocationId);
      await this.loadCoverageAreas();
    } catch (error) {
      this.notificationManager.show(
        `Failed to mark segment: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Handle bulk mark segments
   */
  async handleBulkMarkSegments(action) {
    const segmentIds = this.selection.getSelectedSegmentIds();
    if (segmentIds.length === 0) return;

    const activeLocationId =
      this.selectedLocation?._id || this.currentDashboardLocationId;
    if (!activeLocationId) {
      this.notificationManager.show(
        "Cannot perform bulk action: No active location.",
        "warning",
      );
      return;
    }

    await Promise.allSettled(
      segmentIds.map((segId) =>
        COVERAGE_API.markSegment(activeLocationId, segId, action),
      ),
    );

    // Optimistic update
    segmentIds.forEach((segId) => {
      const idx = this.coverageMap.streetsGeoJson?.features?.findIndex(
        (f) => f.properties.segment_id === segId,
      );
      if (idx !== undefined && idx !== -1) {
        const feature = this.coverageMap.streetsGeoJson.features[idx];
        switch (action) {
          case "driven":
            feature.properties.driven = true;
            feature.properties.undriveable = false;
            break;
          case "undriven":
            feature.properties.driven = false;
            break;
          case "undriveable":
            feature.properties.undriveable = true;
            feature.properties.driven = false;
            break;
          case "driveable":
            feature.properties.undriveable = false;
            break;
        }
        this.coverageMap.streetsGeoJson.features[idx] = { ...feature };
      }
    });

    if (this.coverageMap.map?.getSource("streets")) {
      this.coverageMap.map
        .getSource("streets")
        .setData(this.coverageMap.streetsGeoJson);
    }

    this.notificationManager.show(
      `${segmentIds.length} segments marked as ${action}.`,
      "success",
      2500,
    );

    await this.refreshDashboardData(activeLocationId);
    await this.loadCoverageAreas();

    this.selection.clearSelection();
  }

  /**
   * Refresh dashboard data
   */
  async refreshDashboardData(locationId) {
    try {
      const refreshData = await COVERAGE_API.refreshStats(locationId);
      if (refreshData.coverage) {
        this.selectedLocation = refreshData.coverage;
        this.ui.updateDashboardStats(
          refreshData.coverage,
          this.distanceInUserUnits.bind(this),
          this.formatRelativeTime.bind(this),
        );
        this.coverageMap.addCoverageSummary(refreshData.coverage);
        this.ui.updateStreetTypeCoverage(
          refreshData.coverage.street_types || [],
          this.distanceInUserUnits.bind(this),
          this.formatStreetType.bind(this),
        );
        if (this.ui.streetTypeChartInstance)
          this.ui.streetTypeChartInstance.destroy();
        this.ui.createStreetTypeChart(
          refreshData.coverage.street_types || [],
          this.formatStreetType.bind(this),
          this.distanceInUserUnits.bind(this),
        );
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
  }

  /**
   * Show street on map
   */
  showStreetOnMap(streetName) {
    if (!this.coverageMap.map || !this.coverageMap.streetsGeoJson) return;

    const matchingFeatures = this.coverageMap.streetsGeoJson.features.filter(
      (f) => (f.properties?.street_name || "Unnamed") === streetName,
    );

    if (!matchingFeatures.length) {
      this.notificationManager?.show(
        `No geometry found for '${streetName}'.`,
        "warning",
      );
      return;
    }

    const selSource = "selected-street";
    const selLayer = "selected-street-layer";
    if (this.coverageMap.map.getLayer(selLayer))
      this.coverageMap.map.removeLayer(selLayer);
    if (this.coverageMap.map.getSource(selSource))
      this.coverageMap.map.removeSource(selSource);

    this.coverageMap.map.addSource(selSource, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: matchingFeatures,
      },
    });

    this.coverageMap.map.addLayer({
      id: selLayer,
      type: "line",
      source: selSource,
      paint: {
        "line-color": "#00e5ff",
        "line-width": 6,
        "line-opacity": 0.9,
      },
      layout: { "line-cap": "round", "line-join": "round" },
    });

    const bounds = new mapboxgl.LngLatBounds();
    matchingFeatures.forEach((f) => {
      const geom = f.geometry;
      if (!geom) return;
      const extendCoord = (coord) => bounds.extend(coord);
      if (geom.type === "LineString") geom.coordinates.forEach(extendCoord);
      else if (geom.type === "MultiLineString")
        geom.coordinates.forEach((line) => line.forEach(extendCoord));
    });
    if (!bounds.isEmpty()) {
      this.coverageMap.map.fitBounds(bounds, {
        padding: 40,
        maxZoom: 18,
        duration: 800,
      });
    }
  }

  /**
   * Handle area definition type change
   */
  handleAreaDefinitionTypeChange(type) {
    this.currentAreaDefinitionType = type;

    const locationSearchForm = document.getElementById("location-search-form");
    const drawingInterface = document.getElementById("drawing-interface");
    const locationSearchButtons = document.getElementById(
      "location-search-buttons",
    );
    const drawingButtons = document.getElementById("drawing-buttons");

    if (type === "location") {
      locationSearchForm?.classList.remove("d-none");
      drawingInterface?.classList.add("d-none");
      locationSearchButtons?.classList.remove("d-none");
      drawingButtons?.classList.add("d-none");
      this.drawing.cleanupDrawingMap();
    } else if (type === "draw") {
      locationSearchForm?.classList.add("d-none");
      drawingInterface?.classList.remove("d-none");
      locationSearchButtons?.classList.add("d-none");
      drawingButtons?.classList.remove("d-none");
      this.drawing.initializeDrawingMap();
    }

    this.resetModalValidationState();
  }

  /**
   * Reset modal state
   */
  resetModalState() {
    const locationRadio = document.getElementById("area-type-location");
    if (locationRadio) {
      locationRadio.checked = true;
      this.handleAreaDefinitionTypeChange("location");
    }

    const locationInput = document.getElementById("location-input");
    const customAreaName = document.getElementById("custom-area-name");

    if (locationInput) {
      locationInput.value = "";
      locationInput.classList.remove("is-valid", "is-invalid");
    }

    if (customAreaName) {
      customAreaName.value = "";
    }

    this.resetModalValidationState();
  }

  /**
   * Reset modal validation state
   */
  resetModalValidationState() {
    this.validatedLocation = null;
    this.validatedCustomBoundary = null;

    const validationResult = document.getElementById("validation-result");
    const drawingValidationResult = document.getElementById(
      "drawing-validation-result",
    );

    if (validationResult) validationResult.classList.add("d-none");
    if (drawingValidationResult)
      drawingValidationResult.classList.add("d-none");

    const addLocationButton = document.getElementById("add-coverage-area");
    const addCustomButton = document.getElementById("add-custom-area");

    if (addLocationButton) addLocationButton.disabled = true;
    if (addCustomButton) addCustomButton.disabled = true;
  }

  /**
   * Handle trip overlay toggle
   */
  handleTripOverlayToggle(enabled) {
    this.showTripsActive = enabled;
    this.coverageMap.showTripsActive = enabled;

    if (enabled) {
      this.coverageMap.setupTripLayers();
      this.coverageMap.loadTripsForView();
      this.notificationManager.show("Trip overlay enabled", "info", 2000);
    } else {
      this.coverageMap.clearTripOverlay();
      this.notificationManager.show("Trip overlay disabled", "info", 2000);
    }

    localStorage.setItem("showTripsOverlay", enabled.toString());
  }

  /**
   * Update filter button states
   */
  updateFilterButtonStates(filterType = null) {
    const currentFilter =
      filterType || this.currentFilter || this.coverageMap.currentFilter;
    const filterButtons = document.querySelectorAll(
      ".map-controls button[data-filter]",
    );
    filterButtons.forEach((btn) => {
      btn.classList.remove(
        "active",
        "btn-primary",
        "btn-outline-primary",
        "btn-success",
        "btn-outline-success",
        "btn-danger",
        "btn-outline-danger",
        "btn-warning",
        "btn-outline-warning",
      );

      let buttonClass = "";
      if (btn.dataset.filter === currentFilter) {
        btn.classList.add("active");
        if (currentFilter === "driven") buttonClass = "btn-success";
        else if (currentFilter === "undriven") buttonClass = "btn-danger";
        else if (currentFilter === "undriveable") buttonClass = "btn-warning";
        else buttonClass = "btn-primary";
      } else {
        if (btn.dataset.filter === "driven")
          buttonClass = "btn-outline-success";
        else if (btn.dataset.filter === "undriven")
          buttonClass = "btn-outline-danger";
        else if (btn.dataset.filter === "undriveable")
          buttonClass = "btn-outline-warning";
        else buttonClass = "btn-outline-primary";
      }

      btn.classList.add(buttonClass);
    });
  }

  /**
   * Close coverage dashboard
   */
  closeCoverageDashboard() {
    const dashboard = document.getElementById("coverage-dashboard");
    if (dashboard) {
      dashboard.style.opacity = "0";
      dashboard.style.transform = "translateY(20px)";

      setTimeout(() => {
        dashboard.style.display = "none";
        dashboard.style.opacity = "";
        dashboard.style.transform = "";
        this.ui.clearDashboardUI();
        this.coverageMap.cleanup();
        this.navigation.clearEfficientStreetMarkers();
      }, 300);
    }
  }

  /**
   * Export coverage map
   */
  exportCoverageMap() {
    const mapContainer = document.getElementById("coverage-map");
    if (!this.coverageMap.map || !mapContainer) {
      this.notificationManager.show("Map not ready for export.", "warning");
      return;
    }
    this.notificationManager.show("Preparing map export...", "info");

    const doExport = () => {
      setTimeout(() => {
        html2canvas(mapContainer, {
          useCORS: true,
          backgroundColor: "#1e1e1e",
          logging: false,
          allowTaint: true,
          width: mapContainer.offsetWidth,
          height: mapContainer.offsetHeight,
        })
          .then((canvas) => {
            canvas.toBlob((blob) => {
              if (!blob) {
                this.notificationManager.show(
                  "Failed to create image blob.",
                  "danger",
                );
                return;
              }
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              const locationName =
                this.selectedLocation?.location?.display_name || "coverage_map";
              const dateStr = dateUtils.formatDateToString(new Date());
              a.download = `${locationName
                .replace(/[^a-z0-9]/gi, "_")
                .toLowerCase()}_${dateStr}.png`;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                this.notificationManager.show("Map exported.", "success");
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
      }, 500);
    };

    if (typeof html2canvas === "undefined") {
      const script = document.createElement("script");
      script.src =
        "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      script.integrity =
        "sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==";
      script.crossOrigin = "anonymous";
      script.onload = doExport;
      script.onerror = () =>
        this.notificationManager.show(
          "Failed to load export library.",
          "danger",
        );
      document.head.appendChild(script);
    } else {
      doExport();
    }
  }

  /**
   * Find most efficient streets
   */
  async findMostEfficientStreets() {
    const locationId =
      this.selectedLocation?._id || this.currentDashboardLocationId;
    if (!locationId) {
      this.notificationManager.show(
        "Please select a coverage area first.",
        "warning",
      );
      return;
    }
    await this.navigation.findMostEfficientStreets(locationId);
  }

  /**
   * Reprocess streets for area
   */
  async reprocessStreetsForArea(locationId) {
    try {
      const data = await COVERAGE_API.getArea(locationId);
      const { location } = data;
      if (!location.display_name) throw new Error("Missing location");

      const defaults = {
        segment: location.segment_length_meters || 100,
        buffer: location.match_buffer_meters || 15,
        min: location.min_match_length_meters || 5,
      };
      const settings = await this._askMatchSettings(
        location.display_name,
        defaults,
      );
      if (settings === null) return;

      location.segment_length_meters = settings.segment;
      location.match_buffer_meters = settings.buffer;
      location.min_match_length_meters = settings.min;

      const _endpoint =
        location.osm_type === "custom"
          ? "/api/preprocess_custom_boundary"
          : "/api/preprocess_streets";

      this.progress.showProgressModal(
        `Reprocessing streets for ${location.display_name} (seg ${settings.segment} m)...`,
        0,
      );

      const taskData = await COVERAGE_API.preprocessStreets(location);

      this.currentProcessingLocation = location;
      this.progress.currentProcessingLocation = location;
      this.progress.currentTaskId = taskData.task_id;
      this.progress.activeTaskIds.add(taskData.task_id);
      this.progress.saveProcessingState();

      await this.progress.pollCoverageProgress(taskData.task_id);

      this.notificationManager.show(
        `Reprocessing completed for ${location.display_name}`,
        "success",
      );
      await this.loadCoverageAreas();
    } catch (err) {
      console.error("Reprocess error", err);
      this.notificationManager.show(
        `Reprocess failed: ${err.message}`,
        "danger",
      );
      this.progress.hideProgressModal();
    }
  }

  /**
   * Ask match settings
   */
  async _askMatchSettings(
    locationName,
    defaults = { segment: 100, buffer: 15, min: 5 },
  ) {
    return new Promise((resolve) => {
      const modalEl = document.getElementById("segmentLengthModal");
      if (!modalEl) return resolve(null);

      const segEl = modalEl.querySelector("#segment-length-modal-input");
      const bufEl = modalEl.querySelector("#modal-match-buffer");
      const minEl = modalEl.querySelector("#modal-min-match");
      const titleEl = modalEl.querySelector(".modal-title");
      const confirmBtn = modalEl.querySelector("#segment-length-confirm-btn");
      const cancelBtn = modalEl.querySelector("#segment-length-cancel-btn");

      segEl.value = defaults.segment;
      bufEl.value = defaults.buffer;
      minEl.value = defaults.min;
      if (titleEl)
        titleEl.textContent = `Re-segment Streets for ${locationName}`;

      const bsModal = new bootstrap.Modal(modalEl, { backdrop: "static" });

      const cleanup = () => {
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        modalEl.removeEventListener("hidden.bs.modal", onCancel);
      };

      const onConfirm = () => {
        const segVal = parseInt(segEl.value, 10);
        const bufVal = parseFloat(bufEl.value);
        const minVal = parseFloat(minEl.value);
        cleanup();
        bsModal.hide();
        if (
          Number.isNaN(segVal) ||
          segVal <= 0 ||
          Number.isNaN(bufVal) ||
          bufVal <= 0 ||
          Number.isNaN(minVal) ||
          minVal <= 0
        ) {
          resolve(null);
        } else {
          resolve({ segment: segVal, buffer: bufVal, min: minVal });
        }
      };

      const onCancel = () => {
        cleanup();
        resolve(null);
      };

      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
      modalEl.addEventListener("hidden.bs.modal", onCancel);

      bsModal.show();
    });
  }

  /**
   * Setup theme listener
   */
  setupThemeListener() {
    if (typeof MutationObserver !== "undefined") {
      const themeObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "data-bs-theme"
          ) {
            const newTheme =
              document.documentElement.getAttribute("data-bs-theme");
            this.coverageMap.updateTheme(newTheme);
            this.drawing.updateTheme(newTheme);
          }
        });
      });

      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bs-theme"],
      });
    }
  }

  /**
   * Setup auto refresh
   */
  setupAutoRefresh() {
    setInterval(async () => {
      const isProcessingRow = document.querySelector(".processing-row");
      const isModalProcessing =
        this.currentProcessingLocation &&
        document
          .getElementById("taskProgressModal")
          ?.classList.contains("show");

      if (isProcessingRow || isModalProcessing) {
        await this.loadCoverageAreas(false, true);
      }
    }, 10000);
  }

  /**
   * Check for interrupted tasks
   */
  checkForInterruptedTasks() {
    const savedProgress = localStorage.getItem("coverageProcessingState");
    if (!savedProgress) return;

    try {
      const progressData = JSON.parse(savedProgress);
      const now = new Date();
      const savedTime = new Date(progressData.timestamp);

      if (now - savedTime < 60 * 60 * 1000) {
        this.showInterruptedTaskNotification(progressData);
      } else {
        localStorage.removeItem("coverageProcessingState");
      }
    } catch (e) {
      console.error("Error restoring saved progress:", e);
      localStorage.removeItem("coverageProcessingState");
    }
  }

  /**
   * Show interrupted task notification
   */
  showInterruptedTaskNotification(progressData) {
    const { location } = progressData;
    const { taskId } = progressData;

    if (!location || !location.display_name || !taskId) {
      console.warn("Incomplete saved progress data found.", progressData);
      localStorage.removeItem("coverageProcessingState");
      return;
    }

    const notification = document.createElement("div");
    notification.className =
      "alert alert-info alert-dismissible fade show mt-3 fade-in-up";
    notification.innerHTML = `
      <h5><i class="fas fa-info-circle me-2"></i>Interrupted Task Found</h5>
      <p>A processing task for <strong>${location.display_name}</strong> 
         (Task ID: ${taskId.substring(0, 8)}...) was interrupted.</p>
      <div class="progress mb-2" style="height: 20px;">
        <div class="progress-bar bg-info" style="width: ${progressData.progress || 0}%">
          ${progressData.progress || 0}%
        </div>
      </div>
      <div class="d-flex gap-2">
        <button class="btn btn-sm btn-primary resume-task">
          <i class="fas fa-play me-1"></i>Check Status / Resume
        </button>
        <button class="btn btn-sm btn-secondary discard-task">
          <i class="fas fa-trash me-1"></i>Discard
        </button>
      </div>
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;

    notification.querySelector(".resume-task").addEventListener("click", () => {
      this.resumeInterruptedTask(progressData);
      notification.remove();
    });

    notification
      .querySelector(".discard-task")
      .addEventListener("click", () => {
        localStorage.removeItem("coverageProcessingState");
        this.notificationManager.show("Interrupted task discarded", "info");
        notification.remove();
      });

    document.querySelector("#alerts-container")?.prepend(notification);
  }

  /**
   * Resume interrupted task
   */
  async resumeInterruptedTask(savedData) {
    const { location } = savedData;
    const { taskId } = savedData;

    if (!location || !location.display_name || !taskId) {
      this.notificationManager.show(
        "Cannot resume task: Incomplete data.",
        "warning",
      );
      localStorage.removeItem("coverageProcessingState");
      return;
    }

    this.currentProcessingLocation = location;
    this.progress.currentProcessingLocation = location;
    this.progress.currentTaskId = taskId;
    this.progress._addBeforeUnloadListener();

    this.progress.showProgressModal(
      `Checking status for ${location.display_name}...`,
      savedData.progress || 0,
    );

    this.progress.activeTaskIds.add(taskId);

    try {
      await this.progress.pollCoverageProgress(taskId);

      this.notificationManager.show(
        `Task for ${location.display_name} completed.`,
        "success",
      );

      await this.loadCoverageAreas();

      if (this.selectedLocation?._id === location._id) {
        await this.displayCoverageDashboard(this.selectedLocation._id);
      }
    } catch (pollError) {
      this.notificationManager.show(
        `Failed to resume task: ${pollError.message}`,
        "danger",
      );
      await this.loadCoverageAreas();
    }
  }

  /**
   * Initialize quick actions
   */
  initializeQuickActions() {
    document
      .getElementById("find-efficient-street-btn")
      ?.addEventListener("click", () => {
        this.findMostEfficientStreets();
      });

    document
      .getElementById("refresh-table-btn")
      ?.addEventListener("click", () => {
        this.loadCoverageAreas(true);
      });

    document
      .getElementById("close-dashboard-btn")
      ?.addEventListener("click", () => {
        this.closeCoverageDashboard();
      });
  }

  /**
   * Setup accessibility
   */
  setupAccessibility() {
    const liveRegion = document.createElement("div");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    liveRegion.className = "visually-hidden";
    liveRegion.id = "coverage-live-region";
    document.body.appendChild(liveRegion);

    const table = document.getElementById("coverage-areas-table");
    if (table) {
      table.setAttribute("role", "table");
      table.setAttribute("aria-label", "Coverage areas data");
    }
  }

  /**
   * Show enhanced confirm dialog
   */
  async showEnhancedConfirmDialog(options) {
    return new Promise((resolve) => {
      const modalHtml = `
        <div class="modal fade" tabindex="-1" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content bg-dark text-white">
              <div class="modal-header">
                <h5 class="modal-title">${options.title || "Confirm Action"}</h5>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <div class="modal-body">
                <p>${options.message || "Are you sure?"}</p>
                ${
                  options.details
                    ? `<small class="text-muted">${options.details}</small>`
                    : ""
                }
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
                  ${options.cancelText || "Cancel"}
                </button>
                <button type="button" class="btn ${
                  options.confirmButtonClass || "btn-primary"
                }" data-action="confirm">
                  ${options.confirmText || "Confirm"}
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      const modalElement = document.createElement("div");
      modalElement.innerHTML = modalHtml;
      const modal = modalElement.firstElementChild;
      document.body.appendChild(modal);

      const bsModal = new bootstrap.Modal(modal);

      modal.addEventListener("click", (e) => {
        if (e.target.matches('[data-action="confirm"]')) {
          resolve(true);
          bsModal.hide();
        }
      });

      modal.addEventListener("hidden.bs.modal", () => {
        resolve(false);
        modal.remove();
      });

      bsModal.show();
    });
  }

  /**
   * Initialize tooltips
   */
  initTooltips() {
    const tooltipTriggerList = document.querySelectorAll(
      '[data-bs-toggle="tooltip"]',
    );
    tooltipTriggerList.forEach((tooltipTriggerEl) => {
      const existing = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
      if (existing) existing.dispose();
      new bootstrap.Tooltip(tooltipTriggerEl, {
        animation: true,
        delay: { show: 500, hide: 100 },
        html: true,
        placement: "auto",
      });
    });
  }

  /**
   * Update total areas count
   */
  updateTotalAreasCount(count = null) {
    const countElement = document.getElementById("total-areas-count");
    if (!countElement) return;

    if (count === null) {
      COVERAGE_API.getAllAreas().then((areas) => {
        countElement.textContent = areas.length;
        countElement.classList.add("fade-in-up");
      });
    } else {
      countElement.textContent = count;
      countElement.classList.add("fade-in-up");
    }
  }

  /**
   * Cache management
   */
  getCachedData(key) {
    const cached = this.dataCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    this.dataCache.delete(key);
    return null;
  }

  setCachedData(key, data) {
    this.dataCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Utility: Format relative time
   */
  formatRelativeTime(dateString) {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 7) {
      return date.toLocaleDateString();
    } else if (days > 0) {
      return `${days} day${days > 1 ? "s" : ""} ago`;
    } else if (hours > 0) {
      return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    } else if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    }
    return "Just now";
  }

  /**
   * Utility: Distance in user units
   */
  distanceInUserUnits(meters, fixed = 2) {
    if (typeof meters !== "number" || Number.isNaN(meters)) {
      meters = 0;
    }
    const miles = meters * 0.000621371;
    return miles < 0.1
      ? `${(meters * 3.28084).toFixed(0)} ft`
      : `${miles.toFixed(fixed)} mi`;
  }

  /**
   * Utility: Format street type
   */
  formatStreetType(type) {
    if (!type) return "Unknown";
    return type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  if (typeof mapboxgl === "undefined") {
    const msg =
      "Error: Mapbox GL JS library failed to load. Map functionality will be unavailable.";
    const errContainer =
      document.getElementById("alerts-container") || document.body;
    const errDiv = document.createElement("div");
    errDiv.className = "alert alert-danger m-3";
    errDiv.textContent = msg;
    errContainer.prepend(errDiv);
    console.error(msg);
    return;
  }
  if (typeof Chart === "undefined") {
    console.warn(
      "Chart.js not loaded. Chart functionality will be unavailable.",
    );
    const chartContainer = document.getElementById("street-type-chart");
    if (chartContainer)
      chartContainer.innerHTML =
        '<div class="alert alert-warning small p-2">Chart library not loaded.</div>';
  }
  window.coverageManager = new CoverageManager();
});

export default CoverageManager;
