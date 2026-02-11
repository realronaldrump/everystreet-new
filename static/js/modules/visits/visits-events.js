/**
 * Visits Events Module
 * Handles event listener setup and keyboard shortcuts
 */

class VisitsEvents {
  constructor(manager) {
    this.manager = manager;
  }

  /**
   * Set up all event listeners
   */
  setupEventListeners() {
    this._setupButtonListeners();
    this._setupFormListeners();
    this._setupToggleListeners();
    this._setupKeyboardShortcuts();
    this._setupResizeHandler();
  }

  /**
   * Set up window resize handler for map
   */
  _setupResizeHandler() {
    let resizeTimeout;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.manager.map?.resize();
      }, 100);
    });
  }

  _bindClick(elementId, handler) {
    document.getElementById(elementId)?.addEventListener("click", (event) => {
      event.preventDefault();
      handler();
    });
  }

  /**
   * Set up button click listeners
   */
  _setupButtonListeners() {
    // Boundary controls
    this._bindClick("start-drawing", () => this.manager.startDrawing());
    this._bindClick("start-edit-boundary", () => this.manager.startBoundarySelectionMode());
    this._bindClick("save-place", () => this.manager.savePlace());
    this._bindClick("clear-drawing", () => this.manager.clearCurrentDrawing());

    // Map controls
    this._bindClick("zoom-to-fit", () => this.manager.zoomToFitAllPlaces());
    this._bindClick("map-style-toggle", () => this.manager.mapController?.toggleMapStyle());

    // Place management
    this._bindClick("edit-place-boundary", () => this.manager.startEditingPlaceBoundary());

    // Navigation
    this._bindClick("back-to-places-btn", () => this.manager.uiManager?.toggleView());
  }

  /**
   * Set up form listeners
   */
  _setupFormListeners() {
    document.getElementById("edit-place-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.manager.saveEditedPlace();
    });
  }

  /**
   * Set up toggle/filter listeners
   */
  _setupToggleListeners() {
    // Note: time-filter and toggle-custom-places removed in redesign
    // Suggestion size change is now handled by VisitsPageController
    document.getElementById("suggestion-size")?.addEventListener("change", () => {
      this.manager.loadSuggestions();
    });
  }

  _isBoundaryWorkflowActive() {
    return Boolean(
      this.manager.drawing?.isDrawingBoundary?.() ||
        this.manager.drawing?.isEditingBoundary?.() ||
        this.manager.drawing?.isSelectingBoundaryForEdit?.()
    );
  }

  /**
   * Set up keyboard shortcuts
   */
  _setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this._isBoundaryWorkflowActive()) {
          e.preventDefault();
          this.manager.clearCurrentDrawing();
        }
        return;
      }

      // Only handle shortcuts with Ctrl/Cmd key
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }

      switch (e.key.toLowerCase()) {
        case "d":
          e.preventDefault();
          document.getElementById("start-drawing")?.click();
          break;
        case "e":
          e.preventDefault();
          document.getElementById("start-edit-boundary")?.click();
          break;
        case "s":
          e.preventDefault();
          if (!document.getElementById("save-place")?.disabled) {
            document.getElementById("save-place")?.click();
          }
          break;
        case "z":
          e.preventDefault();
          document.getElementById("zoom-to-fit")?.click();
          break;
        default:
          break;
      }
    });
  }
}

export { VisitsEvents };
export default VisitsEvents;
