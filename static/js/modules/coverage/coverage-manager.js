/**
 * Coverage Manager - Main Orchestrator
 * Coordinates all coverage management modules
 */

/* global bootstrap, Chart, mapboxgl */

import COVERAGE_API from "./coverage-api.js";
import { CoverageAutoRefresh } from "./coverage-auto-refresh.js";
import { CoverageCRUD } from "./coverage-crud.js";
import { CoverageDashboard } from "./coverage-dashboard.js";
import CoverageDrawing from "./coverage-drawing.js";
import { CoverageEvents } from "./coverage-events.js";
import { CoverageExport } from "./coverage-export.js";
import CoverageMap from "./coverage-map.js";
import { CoverageModals } from "./coverage-modals.js";
import CoverageNavigation from "./coverage-navigation.js";
import { CoverageProgress } from "./coverage-progress.js";
import { CoverageSegmentActions } from "./coverage-segment-actions.js";
import CoverageSelection from "./coverage-selection.js";
import CoverageUI from "./coverage-ui.js";
import {
  computeAreasHash,
  createFormatterContext,
  distanceInUserUnits,
  formatRelativeTime,
  formatStreetType,
} from "./coverage-utils.js";
import { CoverageValidator } from "./coverage-validator.js";

class CoverageManager {
  constructor() {
    // Initialize notification and confirmation dialog
    this.notificationManager = window.notificationManager || {
      // Fallback: log when notification manager is missing so actions remain traceable
      show: (message, type = "info", _duration = 3000) => {
        console.info(`[Coverage notice:${type}]`, message);
      },
    };

    // Initialize modals module (for confirmationDialog fallback)
    this.modals = new CoverageModals(this.notificationManager);

    this.confirmationDialog = window.confirmationDialog || {
      show: (options) => this.modals.showEnhancedConfirmDialog(options),
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

    // Initialize validator
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

    // Segment actions module
    this.segmentActions = new CoverageSegmentActions(this);

    // Events module
    this.events = new CoverageEvents(this);

    // Auto-refresh module
    this.autoRefresh = new CoverageAutoRefresh(this);

    // State
    this.currentAreaDefinitionType = "location";
    this.currentFilter = "all";
    this._lastAreasHash = null;
    this.cacheTimeout = 5 * 60 * 1000;

    // Initialize
    this.events.setupEventListeners();
    this.events.setupCustomEventListeners();
    this.loadCoverageAreas();
    this.events.initializeQuickActions();
    this.modals.setupAccessibility();
    this.modals.setupThemeListener(this.coverageMap, this.drawing);
    this.autoRefresh.checkForInterruptedTasks();
    this.autoRefresh.setup();
  }

  /**
   * Wrapper for Dashboard Display
   */
  async displayCoverageDashboard(locationId) {
    await this.dashboard.displayCoverageDashboard(locationId, createFormatterContext());
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
        const newHash = computeAreasHash(areas);
        if (newHash === this._lastAreasHash) {
          // No changes, skip rebuild to prevent flicker
          return;
        }
        this._lastAreasHash = newHash;
      } else {
        this._lastAreasHash = computeAreasHash(areas);
      }

      this.ui.updateCoverageTable(
        areas,
        formatRelativeTime,
        this.progress.formatStageName.bind(this.progress),
        distanceInUserUnits
      );
      this.ui.initializeDataTable();
      this.modals.initTooltips();
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
          this.crud
            .updateCoverageForArea(locationId, "incremental")
            .finally(resetButton);
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
   * Find most efficient streets
   */
  async findMostEfficientStreets() {
    const locationId =
      this.dashboard.selectedLocation?._id || this.dashboard.currentDashboardLocationId;
    if (!locationId) {
      this.notificationManager.show("Please select a coverage area first.", "warning");
      return;
    }
    await this.navigation.findMostEfficientStreets(locationId);
  }

  /**
   * Ask match settings (Utility used by CRUD)
   * Delegates to modals module
   */
  _askMatchSettings(locationName, defaults = { segment: 300, buffer: 50, min: 15 }) {
    return this.modals.askMatchSettings(locationName, defaults);
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

  // ===== Utility methods (bound versions for backward compatibility) =====

  /**
   * Utility: Format relative time
   * @deprecated Use imported formatRelativeTime instead
   */
  formatRelativeTime(dateString) {
    return formatRelativeTime(dateString);
  }

  /**
   * Utility: Distance in user units
   * @deprecated Use imported distanceInUserUnits instead
   */
  distanceInUserUnits(meters, fixed = 2) {
    return distanceInUserUnits(meters, fixed);
  }

  /**
   * Utility: Format street type
   * @deprecated Use imported formatStreetType instead
   */
  formatStreetType(type) {
    return formatStreetType(type);
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
