/* global MapboxDraw, bootstrap */

/**
 * Visits Drawing Module
 * Handles drawing polygon boundaries for custom places
 */

(() => {
  class VisitsDrawing {
    constructor(mapController, options = {}) {
      this.mapController = mapController;
      this.notificationManager
        = options.notificationManager || window.notificationManager;

      this.draw = null;
      this.currentPolygon = null;
      this.drawingEnabled = false;
      this.drawingNotification = null;
      this.placeBeingEdited = null;
    }

    /**
     * Initialize Mapbox Draw controls
     * @param {mapboxgl.Map} map - The map instance
     */
    initialize(map) {
      if (typeof MapboxDraw === "undefined") {
        console.error("MapboxDraw library not loaded");
        return;
      }

      this.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true,
        },
        defaultMode: "simple_select",
        styles: this._getDrawStyles(),
      });

      if (map) {
        map.addControl(this.draw, "top-left");
        map.on("draw.create", (e) => this.onPolygonCreated(e));
      }
    }

    /**
     * Get MapboxDraw style configurations
     */
    _getDrawStyles() {
      const colors = window.MapStyles?.MAP_LAYER_COLORS?.customPlaces || {
        fill: "#3b82f6",
        outline: "#3b82f6",
        highlight: "#F59E0B",
      };

      return [
        {
          id: "gl-draw-polygon-fill-inactive",
          type: "fill",
          filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "false"]],
          paint: {
            "fill-color": colors.fill,
            "fill-opacity": 0.15,
          },
        },
        {
          id: "gl-draw-polygon-fill-active",
          type: "fill",
          filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
          paint: {
            "fill-color": "#F59E0B",
            "fill-opacity": 0.1,
          },
        },
        {
          id: "gl-draw-polygon-stroke-inactive",
          type: "line",
          filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "false"]],
          paint: {
            "line-color": colors.outline,
            "line-width": 2,
          },
        },
        {
          id: "gl-draw-polygon-stroke-active",
          type: "line",
          filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
          paint: {
            "line-color": colors.highlight,
            "line-width": 2,
          },
        },
        {
          id: "gl-draw-polygon-vertex-active",
          type: "circle",
          filter: ["all", ["==", "meta", "vertex"], ["==", "active", "true"]],
          paint: {
            "circle-radius": 6,
            "circle-color": "#F59E0B",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        },
      ];
    }

    /**
     * Start drawing mode
     */
    startDrawing() {
      if (this.drawingEnabled || !this.draw) {
        return;
      }

      this.resetDrawing(false);
      this.draw.changeMode("draw_polygon");
      this.drawingEnabled = true;

      const drawBtn = document.getElementById("start-drawing");
      drawBtn?.classList.add("active");
      document.getElementById("save-place")?.setAttribute("disabled", "true");

      const notification = this.notificationManager?.show(
        "Click on the map to start drawing the place boundary. Click the first point or press Enter to finish.",
        "info",
        0
      );
      this.drawingNotification = notification;
    }

    /**
     * Handle polygon creation event
     * @param {Object} event - Mapbox draw event
     */
    onPolygonCreated(event) {
      if (!event?.features || event.features.length === 0) {
        return;
      }

      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
      }

      this.currentPolygon = event.features[0];
      this.drawingEnabled = false;

      document.getElementById("start-drawing")?.classList.remove("active");
      document.getElementById("save-place")?.removeAttribute("disabled");

      if (this.drawingNotification) {
        this.drawingNotification.remove();
      }

      this.notificationManager?.show(
        "Boundary drawn! Enter a name and click Save Place.",
        "success"
      );

      document.getElementById("place-name")?.focus();
    }

    /**
     * Clear current drawing without full reset
     */
    clearCurrentDrawing() {
      if (this.currentPolygon) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
        document.getElementById("save-place")?.setAttribute("disabled", "true");
        this.notificationManager?.show("Drawing cleared.", "info");
      }

      if (this.drawingEnabled) {
        this.draw.changeMode("simple_select");
        this.drawingEnabled = false;
        document.getElementById("start-drawing")?.classList.remove("active");
      }
    }

    /**
     * Reset drawing state
     * @param {boolean} removeControl - Whether to change mode to simple_select
     */
    resetDrawing(removeControl = true) {
      if (this.currentPolygon && this.draw) {
        this.draw.delete(this.currentPolygon.id);
        this.currentPolygon = null;
      }

      const placeNameInput = document.getElementById("place-name");
      const savePlaceBtn = document.getElementById("save-place");
      const startDrawingBtn = document.getElementById("start-drawing");

      if (placeNameInput) {
        placeNameInput.value = "";
        placeNameInput.classList.remove("is-invalid");
      }
      if (savePlaceBtn) {
        savePlaceBtn.setAttribute("disabled", "true");
      }
      if (startDrawingBtn) {
        startDrawingBtn.classList.remove("active");
      }

      if (this.drawingEnabled && removeControl && this.draw) {
        this.draw.changeMode("simple_select");
      }
      this.drawingEnabled = false;
      this.placeBeingEdited = null;
    }

    /**
     * Start editing an existing place's boundary
     * @param {string} placeId - ID of the place to edit
     * @param {Object} place - Place data object
     * @param {mapboxgl.Map} map - The map instance
     */
    startEditingPlaceBoundary(placeId, place, map) {
      if (!place) {
        this.notificationManager?.show("Could not find place to edit.", "warning");
        return;
      }

      const editModalEl = document.getElementById("edit-place-modal");
      if (editModalEl) {
        const editModal = bootstrap.Modal.getInstance(editModalEl);
        editModal?.hide();
      }

      this.resetDrawing(false);
      window.VisitsGeometry.fitMapToGeometry(map, place.geometry, {
        padding: 20,
      });

      this.placeBeingEdited = placeId;
      this.startDrawing();

      this.notificationManager?.show(
        `Draw the new boundary for "${place.name}". The previous boundary is shown dashed. Finish drawing, then save changes via the Manage Places modal.`,
        "info",
        10000
      );
    }

    /**
     * Apply a suggestion boundary to the drawing canvas
     * @param {Object} suggestion - Suggestion object with boundary and name
     */
    applySuggestion(suggestion) {
      if (!suggestion || !suggestion.boundary) {
        return;
      }

      this.resetDrawing(false);

      const feature = {
        type: "Feature",
        geometry: suggestion.boundary,
        properties: {},
      };

      if (this.draw) {
        this.draw.changeMode("simple_select");
        const [featId] = this.draw.add(feature);
        this.currentPolygon = { id: featId, ...feature };
      } else {
        this.currentPolygon = feature;
      }

      const nameInput = document.getElementById("place-name");
      if (nameInput && !nameInput.value) {
        nameInput.value = suggestion.suggestedName;
      }

      document.getElementById("save-place")?.removeAttribute("disabled");

      this.notificationManager?.show(
        "Suggestion applied! Adjust boundary or name, then click Save Place.",
        "info"
      );
    }

    /**
     * Get current polygon geometry
     * @returns {Object|null} Current polygon geometry
     */
    getCurrentPolygon() {
      return this.currentPolygon;
    }

    /**
     * Get the place currently being edited
     * @returns {string|null} Place ID being edited
     */
    getPlaceBeingEdited() {
      return this.placeBeingEdited;
    }

    /**
     * Check if a place is currently being edited with a new boundary
     * @param {string} placeId - Place ID to check
     * @returns {boolean} Whether the place is being edited
     */
    isEditingPlace(placeId) {
      return this.placeBeingEdited === placeId && this.currentPolygon !== null;
    }

    /**
     * Get the Mapbox Draw instance
     * @returns {MapboxDraw|null}
     */
    getDraw() {
      return this.draw;
    }
  }

  window.VisitsDrawing = VisitsDrawing;
})();
