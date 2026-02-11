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
    this.drawingEnabled = false;
    this.drawingNotification = null;
    this.placeBeingEdited = null;
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
    const colors = MapStyles.MAP_LAYER_COLORS?.customPlaces || {
      fill: "#3b8a7f",
      outline: "#2d6e65",
      highlight: "#b87a4a",
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
          "fill-color": colors.highlight,
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
    if (this.drawingEnabled || !this.draw) {
      return;
    }

    this.resetDrawing(false);
    this.draw.changeMode("draw_polygon");
    this.drawingEnabled = true;
    this._setSavePlaceFormVisible(false);
    this._setDrawingToastVisible(true);

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

    this._setDrawingToastVisible(false);
    this._setSavePlaceFormVisible(true);

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

    this._setSavePlaceFormVisible(false);
    this._setDrawingToastVisible(false);
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
    this._setSavePlaceFormVisible(false);
    this._setDrawingToastVisible(false);

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

    if (this.drawingNotification) {
      this.drawingNotification.remove();
      this.drawingNotification = null;
    }

    if (removeControl && this.draw) {
      this.draw.changeMode("simple_select");
    }

    this.drawingEnabled = false;
    this.placeBeingEdited = null;
  }

  /**
   * Start editing an existing place boundary
   * @param {Object} place - Place to edit
   */
  startEditingPlaceBoundary(_placeId, place) {
    if (!this.draw) {
      return;
    }

    this.resetDrawing(false);

    this.placeBeingEdited = _placeId;

    const geoJson = {
      type: "Feature",
      geometry: place.geometry,
      properties: { name: place.name },
    };

    this.draw.add(geoJson);
    const polygon = this.draw.getAll().features[0];

    if (polygon) {
      this.currentPolygon = polygon;
      this.draw.changeMode("direct_select", { featureId: polygon.id });
      this.drawingEnabled = true;
      this._setDrawingToastVisible(false);

      document.getElementById("start-drawing")?.classList.add("active");

      document.getElementById("place-name").value = place.name;
      document.getElementById("place-name")?.focus();

      this.notificationManager?.show(
        "Edit the boundary by dragging points. Click Save Changes in the dialog.",
        "info"
      );
    }
  }

  /**
   * Get the current polygon GeoJSON
   * @returns {Object|null} GeoJSON of current polygon
   */
  getCurrentPolygonGeoJSON() {
    if (!this.currentPolygon) {
      return null;
    }

    return this.draw.get(this.currentPolygon.id);
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

    this.draw.add(geoJson);
    const polygon = this.draw.getAll().features[0];

    if (polygon) {
      this.currentPolygon = polygon;
      this.draw.changeMode("direct_select", { featureId: polygon.id });
      this.drawingEnabled = true;
      this._setSavePlaceFormVisible(true);
      this._setDrawingToastVisible(false);
      document.getElementById("start-drawing")?.classList.add("active");
      document.getElementById("save-place")?.removeAttribute("disabled");
      document.getElementById("place-name").value = suggestionName || "";
      document.getElementById("place-name")?.focus();
    }
  }
}

export { VisitsDrawing };
export default VisitsDrawing;
