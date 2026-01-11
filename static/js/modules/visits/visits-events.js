/**
 * Visits Events Module
 * Handles event listener setup and keyboard shortcuts
 */

(() => {
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
    }

    /**
     * Set up button click listeners
     */
    _setupButtonListeners() {
      // Drawing controls
      document
        .getElementById("start-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.startDrawing();
        });

      document
        .getElementById("save-place")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.savePlace();
        });

      document
        .getElementById("clear-drawing")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.clearCurrentDrawing();
        });

      // Map controls
      document
        .getElementById("zoom-to-fit")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.zoomToFitAllPlaces();
        });

      document
        .getElementById("map-style-toggle")
        ?.addEventListener("click", () => {
          this.manager.mapController?.toggleMapStyle();
        });

      // Place management
      document
        .getElementById("manage-places")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.uiManager?.showManagePlacesModal(this.manager.places);
        });

      document
        .getElementById("edit-place-boundary")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.startEditingPlaceBoundary();
        });

      // Navigation
      document
        .getElementById("back-to-places-btn")
        ?.addEventListener("mousedown", (e) => {
          if (e.button !== 0) {
            return;
          }
          this.manager.uiManager?.toggleView();
        });
    }

    /**
     * Set up form listeners
     */
    _setupFormListeners() {
      document
        .getElementById("edit-place-form")
        ?.addEventListener("submit", (e) => {
          e.preventDefault();
          this.manager.saveEditedPlace();
        });
    }

    /**
     * Set up toggle/filter listeners
     */
    _setupToggleListeners() {
      document
        .getElementById("toggle-custom-places")
        ?.addEventListener("change", (e) => {
          this.manager.uiManager?.toggleCustomPlacesVisibility(
            e.target.checked,
          );
        });

      document
        .getElementById("time-filter")
        ?.addEventListener("change", (e) => {
          this.manager.filterByTimeframe(e.target.value);
        });
    }

    /**
     * Set up keyboard shortcuts
     */
    _setupKeyboardShortcuts() {
      document.addEventListener("keydown", (e) => {
        // Only handle shortcuts with Ctrl/Cmd key
        if (!e.ctrlKey && !e.metaKey) {
          return;
        }

        switch (e.key) {
          case "d":
            e.preventDefault();
            document.getElementById("start-drawing")?.click();
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

  window.VisitsEvents = VisitsEvents;
})();
