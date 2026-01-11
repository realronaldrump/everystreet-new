/**
 * Coverage Drawing Module
 * Handles custom boundary drawing interface
 */

/* global mapboxgl, MapboxDraw */

class CoverageDrawing {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.drawingMap = null;
    this.drawingMapDraw = null;
    this.validatedCustomBoundary = null;
  }

  /**
   * Initialize drawing map
   */
  initializeDrawingMap(containerId = "drawing-map") {
    if (this.drawingMap) {
      this.cleanupDrawingMap();
    }

    if (!window.MAPBOX_ACCESS_TOKEN) {
      this.showDrawingError(
        "Mapbox token not configured. Cannot initialize drawing map.",
      );
      return;
    }

    try {
      mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";
      const mapStyle =
        theme === "light"
          ? "mapbox://styles/mapbox/light-v11"
          : "mapbox://styles/mapbox/dark-v11";

      this.drawingMap = new mapboxgl.Map({
        container: containerId,
        style: mapStyle,
        center: [-97.1467, 31.5494],
        zoom: 10,
        attributionControl: false,
      });

      if (window.MapboxDraw) {
        this.drawingMapDraw = new MapboxDraw({
          displayControlsDefault: false,
          controls: {
            polygon: true,
            trash: true,
          },
          defaultMode: "draw_polygon",
          styles: this.getDrawingStyles(),
        });

        this.drawingMap.addControl(this.drawingMapDraw);

        this.drawingMap.on("draw.create", (e) => {
          this.handleDrawingCreate(e);
        });

        this.drawingMap.on("draw.update", (e) => {
          this.handleDrawingUpdate(e);
        });

        this.drawingMap.on("draw.delete", (e) => {
          this.handleDrawingDelete(e);
        });
      } else {
        this.showDrawingError(
          "MapboxDraw library not loaded. Cannot enable drawing functionality.",
        );
      }

      this.drawingMap.addControl(new mapboxgl.NavigationControl(), "top-right");
    } catch (error) {
      console.error("Error initializing drawing map:", error);
      this.showDrawingError(
        `Failed to initialize drawing map: ${error.message}`,
      );
    }
  }

  /**
   * Get drawing styles
   */
  getDrawingStyles() {
    const styles = [
      {
        id: "gl-draw-polygon-fill-inactive",
        type: "fill",
        filter: [
          "all",
          ["==", "active", "false"],
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
        ],
        paint: {
          "fill-color": "#3bb2d0",
          "fill-outline-color": "#3bb2d0",
          "fill-opacity": 0.1,
        },
      },
      {
        id: "gl-draw-polygon-stroke-inactive",
        type: "line",
        filter: [
          "all",
          ["==", "active", "false"],
          ["==", "$type", "Polygon"],
          ["!=", "mode", "static"],
        ],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#3bb2d0",
          "line-width": 2,
        },
      },
      {
        id: "gl-draw-polygon-fill-active",
        type: "fill",
        filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
        paint: {
          "fill-color": "#fbb03b",
          "fill-outline-color": "#fbb03b",
          "fill-opacity": 0.1,
        },
      },
      {
        id: "gl-draw-polygon-stroke-active",
        type: "line",
        filter: ["all", ["==", "active", "true"], ["==", "$type", "Polygon"]],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#fbb03b",
          "line-width": 2,
        },
      },
      {
        id: "gl-draw-polygon-midpoint",
        type: "circle",
        filter: ["all", ["==", "$type", "Point"], ["==", "meta", "midpoint"]],
        paint: {
          "circle-radius": 3,
          "circle-color": "#fbb03b",
        },
      },
      {
        id: "gl-draw-polygon-vertex-active",
        type: "circle",
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["==", "meta", "vertex"],
          ["==", "active", "true"],
        ],
        paint: {
          "circle-radius": 5,
          "circle-color": "#fbb03b",
        },
      },
      {
        id: "gl-draw-polygon-vertex-inactive",
        type: "circle",
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["==", "meta", "vertex"],
          ["==", "active", "false"],
        ],
        paint: {
          "circle-radius": 3,
          "circle-color": "#3bb2d0",
        },
      },
    ];
    this.drawingStylesCache = styles;
    return styles;
  }

  /**
   * Handle drawing create
   */
  handleDrawingCreate(e) {
    if (e.features?.length > 0) {
      const feature = e.features[0];
      this.updateDrawingValidationState(feature);
    }
  }

  /**
   * Handle drawing update
   */
  handleDrawingUpdate(e) {
    if (e.features?.length > 0) {
      const feature = e.features[0];
      this.updateDrawingValidationState(feature);
    }
  }

  /**
   * Handle drawing delete
   */
  handleDrawingDelete() {
    this.clearDrawingValidationState();
  }

  /**
   * Update drawing validation state
   */
  updateDrawingValidationState() {
    const validateButton = document.getElementById("validate-drawing");
    const addButton = document.getElementById("add-custom-area");

    if (validateButton) validateButton.disabled = false;
    if (addButton) addButton.disabled = true;

    this.validatedCustomBoundary = null;
    this.hideDrawingValidationResult();
  }

  /**
   * Clear drawing validation state
   */
  clearDrawingValidationState() {
    const validateButton = document.getElementById("validate-drawing");
    const addButton = document.getElementById("add-custom-area");

    if (validateButton) validateButton.disabled = true;
    if (addButton) addButton.disabled = true;

    this.validatedCustomBoundary = null;
    this.hideDrawingValidationResult();
  }

  /**
   * Clear drawing
   */
  clearDrawing() {
    if (this.drawingMapDraw) {
      this.drawingMapDraw.deleteAll();
      this.clearDrawingValidationState();
    }
  }

  /**
   * Get all drawn features
   */
  getAllDrawnFeatures() {
    if (!this.drawingMapDraw) return null;
    return this.drawingMapDraw.getAll();
  }

  /**
   * Update theme
   */
  updateTheme(theme) {
    if (!this.drawingMap) return;
    const styleUrl =
      theme === "light"
        ? "mapbox://styles/mapbox/light-v11"
        : "mapbox://styles/mapbox/dark-v11";

    if (this.drawingMap?.setStyle) {
      const drawCenter = this.drawingMap.getCenter();
      const drawZoom = this.drawingMap.getZoom();
      const drawBearing = this.drawingMap.getBearing();
      const drawPitch = this.drawingMap.getPitch();

      this.drawingMap.once("styledata", () => {
        this.drawingMap.jumpTo({
          center: drawCenter,
          zoom: drawZoom,
          bearing: drawBearing,
          pitch: drawPitch,
        });
        setTimeout(() => this.drawingMap.resize(), 100);
      });

      this.drawingMap.setStyle(styleUrl);
    }
  }

  /**
   * Show drawing error
   */
  showDrawingError(message) {
    this.lastDrawingErrorMessage = message;
    const mapContainer = document.getElementById("drawing-map");
    if (mapContainer) {
      mapContainer.innerHTML = `
        <div class="alert alert-danger m-3">
          <i class="fas fa-exclamation-circle me-2"></i>
          <strong>Drawing Error:</strong> ${message}
        </div>
      `;
    }
  }

  /**
   * Show drawing validation result
   */
  showDrawingValidationResult(data) {
    this.lastValidationResult = data;
    const resultDiv = document.getElementById("drawing-validation-result");
    const messageSpan = resultDiv?.querySelector(".drawing-validation-message");

    if (resultDiv && messageSpan) {
      messageSpan.textContent = `Custom area "${data.display_name}" validated successfully! (${data.stats.total_points} points, ${data.stats.rings} ring${data.stats.rings > 1 ? "s" : ""})`;
      resultDiv.classList.remove("d-none");
    }
  }

  /**
   * Hide drawing validation result
   */
  hideDrawingValidationResult() {
    this.lastValidationHiddenAt = Date.now();
    const resultDiv = document.getElementById("drawing-validation-result");
    if (resultDiv) {
      resultDiv.classList.add("d-none");
    }
  }

  /**
   * Cleanup drawing map
   */
  cleanupDrawingMap() {
    if (this.drawingMap) {
      try {
        this.drawingMap.remove();
      } catch (e) {
        console.warn("Error removing drawing map:", e);
      }
      this.drawingMap = null;
      this.drawingMapDraw = null;
    }
  }
}

export default CoverageDrawing;
