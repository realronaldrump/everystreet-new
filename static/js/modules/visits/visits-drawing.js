/* global MapboxDraw */

import MapStyles from "../map-styles.js";
import notificationManager from "../ui/notifications.js";

/**
 * Visits Drawing Module
 * Handles drawing polygon boundaries for custom places
 */

class VisitsDrawing {
  constructor(mapController, options = {}) {
    this.mapController = mapController;
    this.notificationManager = options.notificationManager || notificationManager;

    this.draw = null;
    this.currentPolygon = null;
    this.placeBeingEdited = null;
    this.mode = "idle";
  }

  _setSavePlaceFormVisible(isVisible) {
    const form = document.getElementById("save-place-form");
    if (!form) {
      return;
    }

    form.style.display = isVisible ? "block" : "none";
  }

  _setDrawingToastVisible(isVisible) {
    const toast = document.getElementById("drawing-toast");
    if (!toast) {
      return;
    }

    toast.style.display = isVisible ? "flex" : "none";
  }

  _setDrawingToastMessage(message) {
    const messageElement = document.getElementById("drawing-toast-message");
    if (!messageElement) {
      return;
    }
    messageElement.textContent = message;
  }

  _updateModeSummary() {
    const modePill = document.getElementById("boundary-mode-pill");
    const modeText = document.getElementById("boundary-mode-text");
    if (!modePill || !modeText) {
      return;
    }

    const modeConfig = {
      idle: {
        pillText: "Ready",
        pillClass: "boundary-mode-idle",
        helpText:
          "Draw a new boundary, or click Edit and then a saved place boundary to modify it.",
      },
      "draw-new": {
        pillText: "Drawing",
        pillClass: "boundary-mode-drawing",
        helpText: "Click points on the map to draw your boundary, then close the shape.",
      },
      "select-existing": {
        pillText: "Select Place",
        pillClass: "boundary-mode-selecting",
        helpText: "Click a saved place boundary on the map to begin editing it.",
      },
      "edit-new": {
        pillText: "Editing New",
        pillClass: "boundary-mode-editing",
        helpText: "Drag vertices and midpoints to refine the new boundary before saving.",
      },
      "edit-existing": {
        pillText: "Editing Existing",
        pillClass: "boundary-mode-editing",
        helpText:
          "Adjust vertices and midpoints to update this saved boundary, then save changes.",
      },
    };

    const config = modeConfig[this.mode] || modeConfig.idle;
    modePill.className = `boundary-mode-pill ${config.pillClass}`;
    modePill.textContent = config.pillText;
    modeText.textContent = config.helpText;
  }

  _syncBoundaryUi() {
    const drawButton = document.getElementById("start-drawing");
    const editButton = document.getElementById("start-edit-boundary");
    const cancelButton = document.getElementById("clear-drawing");
    const saveButton = document.getElementById("save-place");
    const placeNameLabel = document.getElementById("place-name-label");
    const placeNameHint = document.getElementById("place-name-hint");
    const savePlaceLabel = document.getElementById("save-place-label");
    const startDrawingFab = document.getElementById("start-drawing-fab");

    const hasPolygon = Boolean(
      this.currentPolygon?.id && this.draw?.get?.(this.currentPolygon.id)
    );

    drawButton?.classList.toggle(
      "active",
      this.mode === "draw-new" || this.mode === "edit-new"
    );
    editButton?.classList.toggle(
      "active",
      this.mode === "select-existing" || this.mode === "edit-existing"
    );
    cancelButton?.classList.toggle("active", this.mode !== "idle");
    if (cancelButton) {
      cancelButton.disabled = this.mode === "idle";
    }

    const showToast = this.mode === "draw-new" || this.mode === "select-existing";
    const showSaveForm = this.mode === "edit-new" || this.mode === "edit-existing";

    this._setDrawingToastVisible(showToast);
    this._setSavePlaceFormVisible(showSaveForm);

    if (placeNameLabel) {
      placeNameLabel.textContent =
        this.mode === "edit-existing" ? "Update this place" : "Name this place";
    }

    if (placeNameHint) {
      placeNameHint.textContent =
        this.mode === "edit-existing"
          ? "Make boundary changes on the map, then save updates to this place."
          : "Use drag handles on the map to fine-tune the boundary before saving.";
    }

    if (savePlaceLabel) {
      savePlaceLabel.textContent =
        this.mode === "edit-existing" ? "Save changes" : "Save place";
    }

    if (saveButton) {
      if (showSaveForm && hasPolygon) {
        saveButton.removeAttribute("disabled");
      } else {
        saveButton.setAttribute("disabled", "true");
      }
    }

    startDrawingFab?.classList.toggle("is-hidden", this.mode !== "idle");
    this._updateModeSummary();
  }

  _clearDrawFeatures() {
    if (!this.draw) {
      return;
    }

    this.draw.deleteAll();
    this.currentPolygon = null;
  }

  _setPolygonForEditing(feature, mode) {
    if (!feature?.id) {
      this.notificationManager?.show("Unable to prepare this boundary for editing.", "warning");
      this.mode = "idle";
      this._syncBoundaryUi();
      return;
    }

    this.currentPolygon = feature;
    this.mode = mode;
    this.draw.changeMode("direct_select", { featureId: feature.id });
    this._setSavePlaceFormVisible(true);
    this._syncBoundaryUi();
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
      map.on("draw.update", (e) => this.onPolygonUpdated(e));
    }

    this._syncBoundaryUi();
  }

  /**
   * Get MapboxDraw style configurations
   */
  _getDrawStyles() {
    const colors = MapStyles.MAP_LAYER_COLORS?.customPlaces || {
      fill: "#3b8a7f",
      outline: "#2d6e65",
      highlight: "#b87a4a",
    };

    return [
      {
        id: "gl-draw-polygon-fill-inactive",
        type: "fill",
        filter: [
          "all",
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
          ["==", "active", "false"],
        ],
        paint: {
          "fill-color": colors.fill,
          "fill-opacity": 0.18,
        },
      },
      {
        id: "gl-draw-polygon-fill-active",
        type: "fill",
        filter: [
          "all",
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
          ["==", "active", "true"],
        ],
        paint: {
          "fill-color": colors.highlight,
          "fill-opacity": 0.2,
        },
      },
      {
        id: "gl-draw-polygon-stroke-inactive",
        type: "line",
        filter: [
          "all",
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
          ["==", "active", "false"],
        ],
        paint: {
          "line-color": colors.outline,
          "line-width": 3,
        },
      },
      {
        id: "gl-draw-polygon-stroke-active",
        type: "line",
        filter: [
          "all",
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
          ["==", "active", "true"],
        ],
        paint: {
          "line-color": colors.highlight,
          "line-width": 3,
        },
      },
      {
        id: "gl-draw-line-inactive",
        type: "line",
        filter: ["all", ["==", "$type", "LineString"], ["==", "active", "false"]],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": colors.outline,
          "line-width": 3,
        },
      },
      {
        id: "gl-draw-line-active",
        type: "line",
        filter: ["all", ["==", "$type", "LineString"], ["==", "active", "true"]],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": colors.highlight,
          "line-width": 3,
        },
      },
      {
        id: "gl-draw-polygon-midpoint",
        type: "circle",
        filter: ["all", ["==", "meta", "midpoint"], ["==", "$type", "Point"]],
        paint: {
          "circle-radius": 4,
          "circle-color": colors.highlight,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#faf9f7",
        },
      },
      {
        id: "gl-draw-polygon-vertex-inactive",
        type: "circle",
        filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"]],
        paint: {
          "circle-radius": 5,
          "circle-color": colors.outline,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#faf9f7",
        },
      },
      {
        id: "gl-draw-polygon-vertex-active-halo",
        type: "circle",
        filter: [
          "all",
          ["==", "meta", "vertex"],
          ["==", "$type", "Point"],
          ["==", "active", "true"],
        ],
        paint: {
          "circle-radius": 8,
          "circle-color": colors.highlight,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#faf9f7",
        },
      },
    ];
  }

  /**
   * Start drawing mode
   */
  startDrawing() {
    if (!this.draw) {
      return;
    }

    this.resetDrawing(false);
    this.mode = "draw-new";
    this.placeBeingEdited = null;
    this._setDrawingToastMessage(
      "Click points to draw a boundary. Press Enter or click first point to close."
    );
    this.draw.changeMode("draw_polygon");
    this._syncBoundaryUi();

    this.notificationManager?.show(
      "Drawing mode enabled. Click map points to outline your new place.",
      "info"
    );
  }

  startSelectingBoundaryForEdit() {
    if (!this.draw) {
      return;
    }

    this.resetDrawing(false);
    this.mode = "select-existing";
    this.placeBeingEdited = null;
    this._setDrawingToastMessage(
      "Click a saved place boundary on the map to start editing it."
    );
    this.draw.changeMode("simple_select");
    this._syncBoundaryUi();

    this.notificationManager?.show(
      "Select a place boundary on the map to edit its shape.",
      "info"
    );
  }

  /**
   * Handle polygon creation event
   * @param {Object} event - Mapbox draw event
   */
  onPolygonCreated(event) {
    if (!event?.features || event.features.length === 0) {
      return;
    }

    const nextPolygon = event.features[0];
    if (this.currentPolygon?.id && this.currentPolygon.id !== nextPolygon.id) {
      this.draw.delete(this.currentPolygon.id);
    }

    this.placeBeingEdited = null;
    this._setPolygonForEditing(nextPolygon, "edit-new");

    this.notificationManager?.show(
      "Boundary drawn. Drag vertices if needed, then name and save your place.",
      "success"
    );

    document.getElementById("place-name")?.focus();
  }

  onPolygonUpdated(event) {
    if (!event?.features || event.features.length === 0) {
      return;
    }

    this.currentPolygon = event.features[0];
    if (this.mode === "draw-new") {
      this.mode = "edit-new";
    }
    this._syncBoundaryUi();
  }

  /**
   * Clear current drawing without full reset
   */
  clearCurrentDrawing() {
    if (this.mode === "idle") {
      return;
    }

    this.resetDrawing();
    this.notificationManager?.show("Boundary editing canceled.", "info");
  }

  /**
   * Reset drawing state
   * @param {boolean} removeControl - Whether to change mode to simple_select
   */
  resetDrawing(removeControl = true) {
    this._clearDrawFeatures();

    const placeNameInput = document.getElementById("place-name");
    if (placeNameInput) {
      placeNameInput.value = "";
      placeNameInput.classList.remove("is-invalid");
    }

    if (removeControl && this.draw) {
      this.draw.changeMode("simple_select");
    }

    this.placeBeingEdited = null;
    this.mode = "idle";
    this._syncBoundaryUi();
  }

  /**
   * Start editing an existing place boundary
   * @param {Object} place - Place to edit
   */
  startEditingPlaceBoundary(_placeId, place) {
    if (!this.draw || !place?.geometry) {
      this.notificationManager?.show(
        "Unable to load this place boundary for editing.",
        "warning"
      );
      return;
    }

    this.resetDrawing(false);
    this.placeBeingEdited = String(_placeId);

    const geoJson = {
      type: "Feature",
      geometry: place.geometry,
      properties: { name: place.name },
    };

    const addedFeatureIds = this.draw.add(geoJson);
    const featureId = Array.isArray(addedFeatureIds)
      ? addedFeatureIds[0]
      : addedFeatureIds;
    const polygon = featureId ? this.draw.get(featureId) : this.draw.getAll().features[0];

    if (polygon) {
      this._setPolygonForEditing(polygon, "edit-existing");

      const placeNameInput = document.getElementById("place-name");
      if (placeNameInput) {
        placeNameInput.value = place.name || "";
        placeNameInput.focus();
      }

      this.notificationManager?.show("Edit the boundary and save changes when ready.", "info");
      return;
    }

    this.mode = "idle";
    this.placeBeingEdited = null;
    this._syncBoundaryUi();
  }

  /**
   * Get the current polygon GeoJSON
   * @returns {Object|null} GeoJSON of current polygon
   */
  getCurrentPolygonGeoJSON() {
    if (!this.currentPolygon || !this.draw) {
      return null;
    }

    return this.draw.get(this.currentPolygon.id) || null;
  }

  getCurrentPolygon() {
    if (!this.currentPolygon) {
      return null;
    }
    return this.getCurrentPolygonGeoJSON() || this.currentPolygon;
  }

  getPlaceBeingEdited() {
    return this.placeBeingEdited;
  }

  isSelectingBoundaryForEdit() {
    return this.mode === "select-existing";
  }

  isDrawingBoundary() {
    return this.mode === "draw-new";
  }

  isEditingBoundary() {
    return this.mode === "edit-new" || this.mode === "edit-existing";
  }

  applySuggestion(suggestion) {
    if (!this.draw || !suggestion?.boundary) {
      return;
    }

    this.resetDrawing(false);

    const suggestionName =
      suggestion.suggestedName || suggestion.name || "Suggested Place";
    const geoJson = {
      type: "Feature",
      geometry: suggestion.boundary,
      properties: { name: suggestionName },
    };

    const addedFeatureIds = this.draw.add(geoJson);
    const featureId = Array.isArray(addedFeatureIds)
      ? addedFeatureIds[0]
      : addedFeatureIds;
    const polygon = featureId ? this.draw.get(featureId) : this.draw.getAll().features[0];

    if (polygon) {
      this.placeBeingEdited = null;
      this._setPolygonForEditing(polygon, "edit-new");

      const placeNameInput = document.getElementById("place-name");
      if (placeNameInput) {
        placeNameInput.value = suggestionName || "";
        placeNameInput.focus();
      }
    }
  }
}

export { VisitsDrawing };
export default VisitsDrawing;
