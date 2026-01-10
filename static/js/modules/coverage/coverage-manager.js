/**
 * Coverage Manager - Main Orchestrator
 * Coordinates all coverage management modules
 */

/* global bootstrap, Chart, mapboxgl */

import dateUtils from "../date-utils.js";
import COVERAGE_API from "./coverage-api.js";
import CoverageDrawing from "./coverage-drawing.js";
import CoverageMap from "./coverage-map.js";
import CoverageNavigation from "./coverage-navigation.js";
import { CoverageProgress } from "./coverage-progress.js";
import CoverageSelection from "./coverage-selection.js";
import CoverageUI from "./coverage-ui.js";

// New Modules
import { CoverageValidator } from "./coverage-validator.js";
import { CoverageCRUD } from "./coverage-crud.js";
import { CoverageDashboard } from "./coverage-dashboard.js";
import { CoverageExport } from "./coverage-export.js";

class CoverageManager {
  constructor() {
    // Initialize notification and confirmation dialog
    this.notificationManager = window.notificationManager || {
      // Fallback: log when notification manager is missing so actions remain traceable
      show: (message, type = "info", _duration = 3000) => {
        console.info(`[Coverage notice:${type}]`, message);
      },
    };

    this.confirmationDialog = window.confirmationDialog || {
      show: (options) => this.showEnhancedConfirmDialog(options),
    };

    // Initialize core modules
    this.progress = new CoverageProgress(this.notificationManager);
    this.coverageMap = new CoverageMap(this.notificationManager);
    this.ui = new CoverageUI(this.notificationManager);
    this.drawing = new CoverageDrawing(this.notificationManager);
    this.selection = new CoverageSelection(this.coverageMap, this.notificationManager);
    this.navigation = new CoverageNavigation(
      this.coverageMap,
      this.notificationManager
    );

    // Initialize new refactored modules
    this.validator = new CoverageValidator(this.notificationManager, this.drawing);
    
    // Dashboard module
    this.dashboard = new CoverageDashboard(
      this.notificationManager,
      this.ui,
      this.coverageMap,
      this.navigation,
      this.selection
    );
    
    // CRUD module
    this.crud = new CoverageCRUD(
      this.notificationManager,
      this.progress,
      this.confirmationDialog,
      this.validator,
      this // Pass manager for reload triggers
    );

    // Export module
    this.exporter = new CoverageExport(this.notificationManager);

    // State
    this.currentAreaDefinitionType = "location";
    this.currentFilter = "all";
    this.lastAreasHash = null;
    this.isAutoRefreshing = false;
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
    document.getElementById("validate-location")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.validator.validateLocation();
    });

    // Drawing validation
    document.getElementById("validate-drawing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.validator.validateCustomBoundary();
    });

    // Clear drawing
    document.getElementById("clear-drawing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.drawing.clearDrawing();
    });

    // Add coverage area
    document.getElementById("add-coverage-area")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.crud.addCoverageArea();
    });

    // Add custom area
    document.getElementById("add-custom-area")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.crud.addCustomCoverageArea();
    });

    // Cancel processing
    document.getElementById("cancel-processing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.crud.cancelProcessing();
    });

    // Modal events
    document
      .getElementById("taskProgressModal")
      ?.addEventListener("hidden.bs.modal", () => {
        this.progress.clearProcessingContext();
      });

    document.getElementById("addAreaModal")?.addEventListener("shown.bs.modal", () => {
      if (this.currentAreaDefinitionType === "draw") {
        this.drawing.initializeDrawingMap();
      }
    });

    document.getElementById("addAreaModal")?.addEventListener("hidden.bs.modal", () => {
      this.drawing.cleanupDrawingMap();
      this.resetModalState();
    });

    // Area definition type change
    document.querySelectorAll('input[name="area-definition-type"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        this.handleAreaDefinitionTypeChange(e.target.value);
      });
    });

    // Table actions
    document.querySelector("#coverage-areas-table")?.addEventListener("click", (e) => {
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
      const filterButton = e.target.closest(".map-controls button[data-filter]");
      if (filterButton) {
        this.coverageMap.setMapFilter(filterButton.dataset.filter);
        // Also update dashboard UI state
        this.dashboard.updateFilterButtonStates(filterButton.dataset.filter);
      }

      const exportButton = e.target.closest("#export-coverage-map");
      if (exportButton) {
        this.exportCoverageMap();
      }

      const tripToggle = e.target.closest("#toggle-trip-overlay");
      if (tripToggle) {
        this.dashboard.handleTripOverlayToggle(tripToggle.checked);
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
      this.dashboard.showStreetOnMap(e.detail);
    });

    document.addEventListener("coverageFilterChanged", (e) => {
      this.dashboard.updateFilterButtonStates(e.detail);
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
   * Wrapper for Dashboard Display
   */
  async displayCoverageDashboard(locationId) {
    await this.dashboard.displayCoverageDashboard(locationId, {
      distanceFormatter: this.distanceInUserUnits.bind(this),
      timeFormatter: this.formatRelativeTime.bind(this),
      streetTypeFormatter: this.formatStreetType.bind(this)
    });
  }

  /**
   * Wrapper for Export
   */
  exportCoverageMap() {
    this.exporter.exportCoverageMap(this.dashboard.selectedLocation);
  }

  /**
   * Load coverage areas
   * @param {boolean} showLoading - Show loading indicator
   * @param {boolean} silent - Suppress notifications
   * @param {boolean} skipRebuild - Skip full table rebuild (for incremental updates)
   */
  async loadCoverageAreas(showLoading = true, silent = false, skipRebuild = false) {
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

      // For silent updates, check if data actually changed before rebuilding
      if (skipRebuild && this._lastAreasHash) {
        const newHash = this._computeAreasHash(areas);
        if (newHash === this._lastAreasHash) {
          // No changes, skip rebuild to prevent flicker
          return;
        }
        this._lastAreasHash = newHash;
      } else {
        this._lastAreasHash = this._computeAreasHash(areas);
      }

      this.ui.updateCoverageTable(
        areas,
        this.formatRelativeTime.bind(this),
        this.progress.formatStageName.bind(this.progress),
        this.distanceInUserUnits.bind(this)
      );
      this.ui.initializeDataTable();
      this.initTooltips();
      this.updateTotalAreasCount(areas.length);
    } catch (error) {
      console.error("Error loading coverage areas:", error);
      if (!silent) {
        this.notificationManager.show(
          `Failed to load coverage areas: ${error.message}.`,
          "danger"
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
   * Compute a simple hash of the areas data to detect changes
   */
  _computeAreasHash(areas) {
    this.lastAreasHashInput = areas;
    const hash = areas
      .map((a) => `${a._id}:${a.status}:${a.coverage_percentage}:${a.last_updated}`)
      .join("|");
    this.lastAreasHash = hash;
    return hash;
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
        "danger"
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
          "danger"
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
          this.crud.updateCoverageForArea(locationId, "full").finally(resetButton);
        }
        break;
      case "update-incremental":
        if (locationId) {
          this.crud.updateCoverageForArea(locationId, "incremental").finally(resetButton);
        }
        break;
      case "delete":
        if (locationData) {
          this.crud.deleteArea(locationData).finally(resetButton);
        }
        break;
      case "cancel":
        if (locationData) {
          this.crud.cancelProcessing(locationData).finally(resetButton);
        }
        break;
      case "reprocess":
        if (locationId) {
          this.crud.reprocessStreetsForArea(locationId).finally(resetButton);
        }
        break;
      default:
        this.notificationManager.show(`Unknown table action: ${action}`, "warning");
        resetButton();
    }
  }

  /**
   * Handle mark segment action
   */
  async handleMarkSegmentAction(action, segmentId) {
    const activeLocationId =
      this.dashboard.selectedLocation?._id || this.dashboard.currentDashboardLocationId;
    if (!activeLocationId || !segmentId) {
      this.notificationManager.show("Cannot perform action: Missing ID.", "warning");
      return;
    }

    try {
      await COVERAGE_API.markSegment(activeLocationId, segmentId, action);
      this.notificationManager.show(
        `Segment marked as ${action}. Refreshing...`,
        "success",
        2000
      );

      // Optimistic UI update
      if (
        this.coverageMap.streetsGeoJson?.features &&
        this.coverageMap.map?.getSource("streets")
      ) {
        const featureIndex = this.coverageMap.streetsGeoJson.features.findIndex(
          (f) => f.properties.segment_id === segmentId
        );
        if (featureIndex !== -1) {
          const feature = this.coverageMap.streetsGeoJson.features[featureIndex];
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
            default:
              console.warn(`Unknown action: ${action}`);
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
            this.distanceInUserUnits.bind(this)
          );
        }
      }

      await this.dashboard.refreshDashboardData(activeLocationId, {
        distanceFormatter: this.distanceInUserUnits.bind(this),
        timeFormatter: this.formatRelativeTime.bind(this),
        streetTypeFormatter: this.formatStreetType.bind(this)
      });
      await this.loadCoverageAreas();
    } catch (error) {
      this.notificationManager.show(
        `Failed to mark segment: ${error.message}`,
        "danger"
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
      this.dashboard.selectedLocation?._id || this.dashboard.currentDashboardLocationId;
    if (!activeLocationId) {
      this.notificationManager.show(
        "Cannot perform bulk action: No active location.",
        "warning"
      );
      return;
    }

    await Promise.allSettled(
      segmentIds.map((segId) =>
        COVERAGE_API.markSegment(activeLocationId, segId, action)
      )
    );

    // Optimistic update
    segmentIds.forEach((segId) => {
      const idx = this.coverageMap.streetsGeoJson?.features?.findIndex(
        (f) => f.properties.segment_id === segId
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
          default:
            console.warn(`Unknown action: ${action}`);
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
      2500
    );

    await this.dashboard.refreshDashboardData(activeLocationId, {
        distanceFormatter: this.distanceInUserUnits.bind(this),
        timeFormatter: this.formatRelativeTime.bind(this),
        streetTypeFormatter: this.formatStreetType.bind(this)
    });
    await this.loadCoverageAreas();

    this.selection.clearSelection();
  }

  /**
   * Handle area definition type change
   */
  handleAreaDefinitionTypeChange(type) {
    this.currentAreaDefinitionType = type;

    const locationSearchForm = document.getElementById("location-search-form");
    const drawingInterface = document.getElementById("drawing-interface");
    const locationSearchButtons = document.getElementById("location-search-buttons");
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

    this.validator.resetValidationState();
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

    this.validator.resetValidationState();
  }


  /**
   * Find most efficient streets
   */
  async findMostEfficientStreets() {
    const locationId = this.dashboard.selectedLocation?._id || this.dashboard.currentDashboardLocationId;
    if (!locationId) {
      this.notificationManager.show("Please select a coverage area first.", "warning");
      return;
    }
    await this.navigation.findMostEfficientStreets(locationId);
  }

  /**
   * Ask match settings (Utility used by CRUD)
   */
  _askMatchSettings(locationName, defaults = { segment: 300, buffer: 50, min: 15 }) {
    this.lastMatchSettingsRequest = { locationName, defaults };
    return new Promise((resolve) => {
      const modalEl = document.getElementById("segmentLengthModal");
      if (!modalEl) {
        resolve(null);
        return;
      }

      const segEl = modalEl.querySelector("#segment-length-modal-input");
      const bufEl = modalEl.querySelector("#modal-match-buffer");
      const minEl = modalEl.querySelector("#modal-min-match");
      const titleEl = modalEl.querySelector(".modal-title");
      const confirmBtn = modalEl.querySelector("#segment-length-confirm-btn");
      const cancelBtn = modalEl.querySelector("#segment-length-cancel-btn");

      segEl.value = defaults.segment;
      bufEl.value = defaults.buffer;
      minEl.value = defaults.min;
      if (titleEl) titleEl.textContent = `Re-segment Streets for ${locationName}`;

      const bsModal = new bootstrap.Modal(modalEl, { backdrop: "static" });

      function onConfirm() {
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
      }

      function onCancel() {
        cleanup();
        resolve(null);
      }

      function cleanup() {
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        modalEl.removeEventListener("hidden.bs.modal", onCancel);
      }

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
            const newTheme = document.documentElement.getAttribute("data-bs-theme");
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
   * Uses smart incremental updates instead of full table rebuilds to prevent flickering
   */
  setupAutoRefresh() {
    this.isAutoRefreshing = false;

    setInterval(async () => {
      // Skip if already refreshing or if modal is showing (polling handles that)
      if (this.isAutoRefreshing) return;

      const isModalProcessing =
        this.crud.currentProcessingLocation &&
        document.getElementById("taskProgressModal")?.classList.contains("show");

      // Don't auto-refresh while modal is open - polling handles updates there
      if (isModalProcessing) return;

      const processingRows = document.querySelectorAll(".processing-row");
      if (processingRows.length === 0) return;

      // Only do incremental status updates, not full table rebuilds
      this.isAutoRefreshing = true;
      try {
        await this.updateProcessingRowsInPlace();
      } finally {
        this.isAutoRefreshing = false;
      }
    }, 30000); // Increased to 30 seconds since polling handles active tasks
  }

  /**
   * Update only the processing rows in place without rebuilding the entire table
   */
  async updateProcessingRowsInPlace() {
    try {
      const areas = await COVERAGE_API.getAllAreas();
      const processingRows = document.querySelectorAll(".processing-row");

      processingRows.forEach((row) => {
        const locationLink = row.querySelector(".location-name-link");
        if (!locationLink) return;

        const { locationId } = locationLink.dataset;
        const area = areas.find((a) => a._id === locationId);

        if (!area) return;

        // Check if no longer processing
        const status = area.status || "unknown";
        const isStillProcessing = [
          "processing_trips",
          "preprocessing",
          "calculating",
          "indexing",
          "finalizing",
          "generating_geojson",
          "completed_stats",
          "initializing",
          "loading_streets",
          "counting_trips",
        ].includes(status);

        if (!isStillProcessing) {
          // Item finished processing - do a full refresh once
          this.loadCoverageAreas(false, true);
          return;
        }

        // Update the status text in place
        const statusDiv = row.querySelector(".text-primary.small");
        if (statusDiv) {
          statusDiv.innerHTML = `<i class="fas fa-spinner fa-spin me-1"></i>${this.progress.formatStageName(status)}...`;
        }
      });
    } catch (error) {
      console.warn("Auto-refresh status update failed:", error.message);
    }
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
      this.crud.resumeInterruptedTask(progressData);
      notification.remove();
    });

    notification.querySelector(".discard-task").addEventListener("click", () => {
      localStorage.removeItem("coverageProcessingState");
      this.notificationManager.show("Interrupted task discarded", "info");
      notification.remove();
    });

    document.querySelector("#alerts-container")?.prepend(notification);
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

    document.getElementById("refresh-table-btn")?.addEventListener("click", () => {
      this.loadCoverageAreas(true);
    });

    document.getElementById("close-dashboard-btn")?.addEventListener("click", () => {
      this.dashboard.closeCoverageDashboard();
    });
  }

  /**
   * Setup accessibility
   */
  setupAccessibility() {
    this.accessibilityInitialized = true;
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
  showEnhancedConfirmDialog(options) {
    this.lastConfirmDialogOptions = options;
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
    this.lastTooltipInitAt = Date.now();
    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    tooltipTriggerList.forEach((tooltipTriggerEl) => {
      const existing = bootstrap.Tooltip.getInstance(tooltipTriggerEl);
      if (existing) existing.dispose();
      const _tooltip = new bootstrap.Tooltip(tooltipTriggerEl, {
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
        this.totalAreasCount = areas.length;
      });
    } else {
      countElement.textContent = count;
      countElement.classList.add("fade-in-up");
    }
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
      const formatted = date.toLocaleDateString();
      this.lastRelativeTime = formatted;
      return formatted;
    } else if (days > 0) {
      const formatted = `${days} day${days > 1 ? "s" : ""} ago`;
      this.lastRelativeTime = formatted;
      return formatted;
    } else if (hours > 0) {
      const formatted = `${hours} hour${hours > 1 ? "s" : ""} ago`;
      this.lastRelativeTime = formatted;
      return formatted;
    } else if (minutes > 0) {
      const formatted = `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
      this.lastRelativeTime = formatted;
      return formatted;
    }
    this.lastRelativeTime = "Just now";
    return "Just now";
  }

  /**
   * Utility: Distance in user units
   */
  distanceInUserUnits(meters, fixed = 2) {
    let safeMeters = meters;
    if (typeof safeMeters !== "number" || Number.isNaN(safeMeters)) {
      safeMeters = 0;
    }
    const miles = safeMeters * 0.000621371;
    const formatted =
      miles < 0.1
        ? `${(safeMeters * 3.28084).toFixed(0)} ft`
        : `${miles.toFixed(fixed)} mi`;
    this.lastDistanceInUserUnits = formatted;
    return formatted;
  }

  /**
   * Utility: Format street type
   */
  formatStreetType(type) {
    if (!type) return "Unknown";
    const formatted = type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    this.lastStreetTypeLabel = formatted;
    return formatted;
  }
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  if (typeof mapboxgl === "undefined") {
    const msg =
      "Error: Mapbox GL JS library failed to load. Map functionality will be unavailable.";
    const errContainer = document.getElementById("alerts-container") || document.body;
    const errDiv = document.createElement("div");
    errDiv.className = "alert alert-danger m-3";
    errDiv.textContent = msg;
    errContainer.prepend(errDiv);
    console.error(msg);
    return;
  }
  if (typeof Chart === "undefined") {
    console.warn("Chart.js not loaded. Chart functionality will be unavailable.");
    const chartContainer = document.getElementById("street-type-chart");
    if (chartContainer)
      chartContainer.innerHTML =
        '<div class="alert alert-warning small p-2">Chart library not loaded.</div>';
  }
  window.coverageManager = new CoverageManager();
});

export default CoverageManager;
