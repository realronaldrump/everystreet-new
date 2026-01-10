/**
 * Coverage Events
 * Handles event listener setup and custom event handling for coverage management
 */

/**
 * Class to manage event listeners for coverage functionality
 */
export class CoverageEvents {
  /**
   * @param {Object} manager - Reference to the CoverageManager instance
   */
  constructor(manager) {
    this.manager = manager;
  }

  /**
   * Setup all event listeners
   */
  setupEventListeners() {
    this._setupValidationListeners();
    this._setupModalListeners();
    this._setupTableListeners();
    this._setupDashboardListeners();
    this._setupAreaDefinitionListeners();
  }

  /**
   * Setup validation button listeners
   */
  _setupValidationListeners() {
    // Location validation
    document.getElementById("validate-location")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.validator.validateLocation();
    });

    // Drawing validation
    document.getElementById("validate-drawing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.validator.validateCustomBoundary();
    });

    // Clear drawing
    document.getElementById("clear-drawing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.drawing.clearDrawing();
    });

    // Add coverage area
    document.getElementById("add-coverage-area")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.crud.addCoverageArea();
    });

    // Add custom area
    document.getElementById("add-custom-area")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.crud.addCustomCoverageArea();
    });

    // Cancel processing
    document.getElementById("cancel-processing")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.manager.crud.cancelProcessing();
    });
  }

  /**
   * Setup modal event listeners
   */
  _setupModalListeners() {
    // Task progress modal hidden
    document
      .getElementById("taskProgressModal")
      ?.addEventListener("hidden.bs.modal", () => {
        this.manager.progress.clearProcessingContext();
      });

    // Add area modal shown
    document.getElementById("addAreaModal")?.addEventListener("shown.bs.modal", () => {
      if (this.manager.currentAreaDefinitionType === "draw") {
        this.manager.drawing.initializeDrawingMap();
      }
    });

    // Add area modal hidden
    document.getElementById("addAreaModal")?.addEventListener("hidden.bs.modal", () => {
      this.manager.drawing.cleanupDrawingMap();
      this.manager.modals.resetModalState(
        this.manager.validator,
        this.manager.drawing,
        (type) => this.manager.handleAreaDefinitionTypeChange(type)
      );
    });
  }

  /**
   * Setup area definition type radio listeners
   */
  _setupAreaDefinitionListeners() {
    document.querySelectorAll('input[name="area-definition-type"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        this.manager.handleAreaDefinitionTypeChange(e.target.value);
      });
    });
  }

  /**
   * Setup table action listeners
   */
  _setupTableListeners() {
    document.querySelector("#coverage-areas-table")?.addEventListener("click", (e) => {
      const targetButton = e.target.closest("button[data-action]");
      const targetLink = e.target.closest("a.location-name-link");
      if (targetButton) {
        e.preventDefault();
        e.stopPropagation();
        this.manager.handleTableAction(targetButton);
      } else if (targetLink) {
        e.preventDefault();
        e.stopPropagation();
        const { locationId } = targetLink.dataset;
        if (locationId) {
          this.manager.displayCoverageDashboard(locationId);
        }
      }
    });
  }

  /**
   * Setup dashboard control listeners
   */
  _setupDashboardListeners() {
    document.addEventListener("click", (e) => {
      const filterButton = e.target.closest(".map-controls button[data-filter]");
      if (filterButton) {
        this.manager.coverageMap.setMapFilter(filterButton.dataset.filter);
        this.manager.dashboard.updateFilterButtonStates(filterButton.dataset.filter);
      }

      const exportButton = e.target.closest("#export-coverage-map");
      if (exportButton) {
        this.manager.exportCoverageMap();
      }

      const tripToggle = e.target.closest("#toggle-trip-overlay");
      if (tripToggle) {
        this.manager.dashboard.handleTripOverlayToggle(tripToggle.checked);
      }
    });
  }

  /**
   * Setup custom event listeners for coverage-specific events
   */
  setupCustomEventListeners() {
    document.addEventListener("coverageToggleSegment", (e) => {
      this.manager.selection.toggleSegmentSelection(e.detail);
    });

    document.addEventListener("coverageSegmentAction", (e) => {
      this.manager.segmentActions.handleMarkSegmentAction(
        e.detail.action,
        e.detail.segmentId
      );
    });

    document.addEventListener("coverageBulkAction", (e) => {
      this.manager.segmentActions.handleBulkMarkSegments(e.detail);
    });

    document.addEventListener("coverageShowStreet", (e) => {
      this.manager.dashboard.showStreetOnMap(e.detail);
    });

    document.addEventListener("coverageFilterChanged", (e) => {
      this.manager.dashboard.updateFilterButtonStates(e.detail);
    });

    document.addEventListener("coverageRetryTask", (e) => {
      if (e.detail.taskId) {
        this.manager.progress.activeTaskIds.add(e.detail.taskId);
        this.manager.progress._addBeforeUnloadListener();
        this.manager.progress
          .pollCoverageProgress(e.detail.taskId, (_data) => {
            // Handle update
          })
          .catch(console.error);
      }
    });

    document.addEventListener("coverageClearEfficientMarkers", () => {
      this.manager.navigation.clearEfficientStreetMarkers();
    });

    document.addEventListener("coverageTableRedrawn", () => {
      this.manager.modals.initTooltips();
    });

    document.addEventListener("coverageMapReady", () => {
      // Map is ready, ensure selection toolbar is created
      this.manager.selection.createBulkActionToolbar();
    });
  }

  /**
   * Initialize quick action buttons
   */
  initializeQuickActions() {
    document
      .getElementById("find-efficient-street-btn")
      ?.addEventListener("click", () => {
        this.manager.findMostEfficientStreets();
      });

    document.getElementById("refresh-table-btn")?.addEventListener("click", () => {
      this.manager.loadCoverageAreas(true);
    });

    document.getElementById("close-dashboard-btn")?.addEventListener("click", () => {
      this.manager.dashboard.closeCoverageDashboard();
    });
  }
}
