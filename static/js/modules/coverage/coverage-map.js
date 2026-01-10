/**
 * Coverage Map Module
 * Handles map initialization, street rendering, and map interactions
 */

/* global mapboxgl */

import COVERAGE_API from "./coverage-api.js";

class CoverageMap {
  constructor(notificationManager) {
    this.notificationManager = notificationManager;
    this.map = null;
    this.streetsGeoJson = null;
    this.mapBounds = null;
    this.mapInfoPanel = null;
    this.coverageSummaryControl = null;
    this.currentFilter = "all";
    this.showTripsActive = false;
    this.hoveredSegmentId = null;
  }

  /**
   * Initialize coverage map
   */
  initializeCoverageMap(coverage, containerId = "coverage-map") {
    const mapContainer = document.getElementById(containerId);
    if (!mapContainer) return;

    if (this.map && typeof this.map.remove === "function") {
      try {
        this.map.remove();
      } catch (e) {
        console.warn("Error removing previous map:", e);
      }
      this.map = null;
    }
    mapContainer.innerHTML = "";

    if (!window.MAPBOX_ACCESS_TOKEN) {
      mapContainer.innerHTML = this.createAlertMessage(
        "Mapbox Token Missing",
        "Cannot display map. Please configure Mapbox access token.",
        "danger",
      );
      return;
    }
    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;

    try {
      const theme =
        document.documentElement.getAttribute("data-bs-theme") || "dark";
      const mapStyle =
        theme === "light"
          ? "mapbox://styles/mapbox/light-v11"
          : "mapbox://styles/mapbox/dark-v11";

      const mapOptions = {
        container: containerId,
        style: mapStyle,
        center: [0, 0],
        zoom: 1,
        minZoom: 0,
        maxZoom: 20,
        preserveDrawingBuffer: true,
        attributionControl: false,
      };
      this.map = new mapboxgl.Map(mapOptions);

      this.map.addControl(new mapboxgl.NavigationControl(), "top-right");
      this.map.addControl(new mapboxgl.ScaleControl({ unit: "imperial" }));
      this.map.addControl(new mapboxgl.FullscreenControl());
      this.map.addControl(
        new mapboxgl.AttributionControl({ compact: true }),
        "bottom-right",
      );

      this.map.on("load", () => {
        if (coverage.streets_geojson) {
          this.addStreetsToMap(coverage.streets_geojson);
        } else {
          this.notificationManager.show(
            "No street data found for this area.",
            "warning",
          );
          this.mapBounds = null;
        }
        this.addCoverageSummary(coverage);
        this.fitMapToBounds();
        this.setupMapEventHandlers();

        if (this.showTripsActive) {
          this.setupTripLayers();
          this.loadTripsForView();
        }

        // Dispatch event that map is ready
        document.dispatchEvent(new CustomEvent("coverageMapReady"));
      });

      this.map.on("error", (e) => {
        console.error("Mapbox GL Error:", e.error);
        this.notificationManager.show(
          `Map error: ${e.error?.message || "Unknown map error"}`,
          "danger",
        );
        mapContainer.innerHTML = this.createAlertMessage(
          "Map Load Error",
          e.error?.message || "Could not initialize map.",
          "danger",
        );
      });

      if (this.mapInfoPanel) this.mapInfoPanel.remove();
      this.createMapInfoPanel();
    } catch (mapInitError) {
      console.error("Failed to initialize Mapbox GL:", mapInitError);
      mapContainer.innerHTML = this.createAlertMessage(
        "Map Initialization Failed",
        mapInitError.message,
        "danger",
      );
    }
  }

  /**
   * Add streets to map
   */
  addStreetsToMap(geojson) {
    if (!this.map || !this.map.isStyleLoaded() || !geojson) {
      console.warn("Map not ready or no GeoJSON data to add streets.");
      return;
    }

    const layersToRemove = [
      "streets-layer",
      "streets-hover-highlight",
      "streets-click-highlight",
      "streets-selection-highlight",
    ];
    layersToRemove.forEach((layerId) => {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    });
    if (this.map.getSource("streets")) this.map.removeSource("streets");

    this.streetsGeoJson = geojson;
    this.currentFilter = "all";

    try {
      this.map.addSource("streets", {
        type: "geojson",
        data: geojson,
        promoteId: "segment_id",
      });

      const getLineColor = [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        "#ffff00",
        ["!=", ["feature-state", "efficientRank"], null],
        [
          "case",
          ["==", ["feature-state", "efficientRank"], 1],
          "#ffd700",
          ["==", ["feature-state", "efficientRank"], 2],
          "#c0c0c0",
          ["==", ["feature-state", "efficientRank"], 3],
          "#cd7f32",
          "#9467bd",
        ],
        ["boolean", ["get", "undriveable"], false],
        "#607d8b",
        ["boolean", ["get", "driven"], false],
        "#4caf50",
        "#ff5252",
      ];

      const getLineWidth = [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        1.5,
        14,
        4,
        18,
        7,
      ];
      const getLineOpacity = [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        1.0,
        ["boolean", ["get", "undriveable"], false],
        0.6,
        0.85,
      ];
      const getLineDash = [
        "case",
        ["boolean", ["get", "undriveable"], false],
        ["literal", [2, 2]],
        ["literal", [1, 0]],
      ];

      this.map.addLayer({
        id: "streets-layer",
        type: "line",
        source: "streets",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getLineColor,
          "line-width": getLineWidth,
          "line-opacity": getLineOpacity,
          "line-dasharray": getLineDash,
        },
      });

      const bounds = new mapboxgl.LngLatBounds();
      geojson.features.forEach((f) => {
        if (f.geometry?.coordinates) {
          if (f.geometry.type === "LineString")
            f.geometry.coordinates.forEach((coord) => {
              bounds.extend(coord);
            });
          else if (f.geometry.type === "MultiLineString")
            f.geometry.coordinates.forEach((line) => {
              line.forEach((coord) => {
                bounds.extend(coord);
              });
            });
        }
      });
      this.mapBounds = !bounds.isEmpty() ? bounds : null;

      this.setupStreetInteractions();
    } catch (error) {
      console.error("Error adding streets source/layer:", error);
      this.notificationManager.show(
        `Failed to display streets: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Setup street interactions
   */
  setupStreetInteractions() {
    this.hoveredSegmentId = null;

    this.map.on("mouseenter", "streets-layer", (e) => {
      this.map.getCanvas().style.cursor = "pointer";
      if (e.features?.length > 0) {
        const props = e.features[0].properties;
        const currentHoverId = props.segment_id;
        if (currentHoverId !== this.hoveredSegmentId) {
          if (this.hoveredSegmentId !== null && this.map.getSource("streets")) {
            this.map.setFeatureState(
              { source: "streets", id: this.hoveredSegmentId },
              { hover: false },
            );
          }
          if (this.map.getSource("streets")) {
            this.map.setFeatureState(
              { source: "streets", id: currentHoverId },
              { hover: true },
            );
          }
          this.hoveredSegmentId = currentHoverId;
        }
        this.updateMapInfoPanel(props, true);
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
      }
    });

    this.map.on("mouseleave", "streets-layer", () => {
      this.map.getCanvas().style.cursor = "";
      if (this.mapInfoPanel) this.mapInfoPanel.style.display = "none";
      if (this.hoveredSegmentId !== null && this.map.getSource("streets")) {
        this.map.setFeatureState(
          { source: "streets", id: this.hoveredSegmentId },
          { hover: false },
        );
      }
      this.hoveredSegmentId = null;
    });

    this.map.on("click", "streets-layer", (e) => {
      if (e.originalEvent?.button !== 0) return;
      if (e.features?.length > 0) {
        const props = e.features[0].properties;

        const isMultiSelect =
          e.originalEvent?.ctrlKey ||
          e.originalEvent?.metaKey ||
          e.originalEvent?.shiftKey;
        if (isMultiSelect) {
          const segId = props.segment_id;
          if (segId) {
            document.dispatchEvent(
              new CustomEvent("coverageToggleSegment", { detail: segId }),
            );
          }
          return;
        }

        const popupContent = this.createStreetPopupContentHTML(props);
        const popup = new mapboxgl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: "350px",
          className: "coverage-popup",
        })
          .setLngLat(e.lngLat)
          .setHTML(popupContent)
          .addTo(this.map);

        const popupElement = popup.getElement();
        if (popupElement) {
          popupElement.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-action]");
            if (button) {
              const { action } = button.dataset;
              const { segmentId } = button.dataset;
              if (action && segmentId) {
                document.dispatchEvent(
                  new CustomEvent("coverageSegmentAction", {
                    detail: { action, segmentId },
                  }),
                );
                popup.remove();
              }
            }
          });
        }
        this.updateMapInfoPanel(props, false);
        if (this.mapInfoPanel) this.mapInfoPanel.style.display = "block";
      }
    });
  }

  /**
   * Create street popup content HTML
   */
  createStreetPopupContentHTML(props) {
    const streetName =
      props.street_name || props.name || props.display_name || "Unnamed Street";
    const streetType =
      props.highway || props.inferred_highway_type || "unknown";
    const segmentLength = parseFloat(
      props.segment_length || props.segment_length_m || props.length || 0,
    );
    const lengthFormatted = this.distanceInUserUnits(segmentLength);
    const isDriven =
      props.driven === true || String(props.driven).toLowerCase() === "true";
    const isUndriveable =
      props.undriveable === true ||
      String(props.undriveable).toLowerCase() === "true";
    const status = isDriven ? "Driven" : "Not Driven";
    const segmentId = props.segment_id || "N/A";

    return `
      <div class="coverage-popup-content">
        <div class="popup-title">${streetName}</div>
        <div class="popup-detail"><span class="popup-label">Type:</span><span class="popup-value">${this.formatStreetType(
          streetType,
        )}</span></div>
        <div class="popup-detail"><span class="popup-label">Length:</span><span class="popup-value">${lengthFormatted}</span></div>
        <div class="popup-detail"><span class="popup-label">Status:</span><span class="popup-value ${
          isDriven ? "status-driven" : "status-undriven"
        }">${status}</span></div>
        ${
          isUndriveable
            ? '<div class="popup-detail"><span class="popup-label">Marked as:</span> <span class="popup-value status-undriveable">Undriveable</span></div>'
            : ""
        }
        <div class="popup-detail"><span class="popup-label">ID:</span><span class="popup-value segment-id">${segmentId}</span></div>
        <div class="street-actions">
          ${
            !isDriven
              ? `<button class="btn btn-sm btn-outline-success mark-driven-btn" data-action="driven" data-segment-id="${segmentId}"><i class="fas fa-check me-1"></i>Mark Driven</button>`
              : ""
          }
          ${
            isDriven
              ? `<button class="btn btn-sm btn-outline-danger mark-undriven-btn" data-action="undriven" data-segment-id="${segmentId}"><i class="fas fa-times me-1"></i>Mark Undriven</button>`
              : ""
          }
          ${
            !isUndriveable
              ? `<button class="btn btn-sm btn-outline-warning mark-undriveable-btn" data-action="undriveable" data-segment-id="${segmentId}"><i class="fas fa-ban me-1"></i>Mark Undriveable</button>`
              : ""
          }
          ${
            isUndriveable
              ? `<button class="btn btn-sm btn-outline-info mark-driveable-btn" data-action="driveable" data-segment-id="${segmentId}"><i class="fas fa-road me-1"></i>Mark Driveable</button>`
              : ""
          }
        </div>
      </div>`;
  }

  /**
   * Setup map event handlers
   */
  setupMapEventHandlers() {
    if (!this.map) return;

    let moveEndTimer = null;
    this.map.on("moveend", () => {
      clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(() => {
        if (this.showTripsActive) {
          this.loadTripsForView();
        }
        const center = this.map.getCenter();
        const zoom = this.map.getZoom();
        localStorage.setItem("lastMapView", JSON.stringify({ center, zoom }));
      }, 300);
    });
  }

  /**
   * Fit map to bounds
   */
  fitMapToBounds() {
    if (this.map && this.mapBounds && !this.mapBounds.isEmpty()) {
      try {
        this.map.fitBounds(this.mapBounds, {
          padding: 20,
          maxZoom: 17,
          duration: 800,
        });
      } catch (e) {
        console.error("Error fitting map to bounds:", e);
        this.notificationManager.show(
          "Could not zoom to area bounds. Map view may be incorrect.",
          "warning",
        );
      }
    } else if (this.map) {
      this.notificationManager.show(
        "No geographical data to display for this area.",
        "info",
      );
    }
  }

  /**
   * Set map filter
   */
  setMapFilter(filterType, updateButtons = true) {
    if (!this.map || !this.map.getLayer("streets-layer")) return;
    this.currentFilter = filterType;
    let filter = null;

    if (filterType === "driven")
      filter = [
        "all",
        ["==", ["get", "driven"], true],
        ["!=", ["get", "undriveable"], true],
      ];
    else if (filterType === "undriven")
      filter = [
        "all",
        ["==", ["get", "driven"], false],
        ["!=", ["get", "undriveable"], true],
      ];
    else if (filterType === "undriveable")
      filter = ["==", ["get", "undriveable"], true];

    try {
      this.map.setFilter("streets-layer", filter);
      if (updateButtons) {
        document.dispatchEvent(
          new CustomEvent("coverageFilterChanged", { detail: filterType }),
        );
      }
    } catch (error) {
      console.error("Error setting map filter:", error);
      this.notificationManager.show(
        `Failed to apply map filter: ${error.message}`,
        "danger",
      );
    }
  }

  /**
   * Setup trip layers
   */
  setupTripLayers() {
    if (!this.map || !this.map.isStyleLoaded()) return;
    if (!this.map.getSource("trips-source")) {
      this.map.addSource("trips-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (!this.map.getLayer("trips-layer")) {
      this.map.addLayer(
        {
          id: "trips-layer",
          type: "line",
          source: "trips-source",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": "#3388ff",
            "line-width": 2.5,
            "line-opacity": 0.75,
            "line-blur": 0.5,
          },
        },
        "streets-layer",
      );
    }
  }

  /**
   * Clear trip overlay
   */
  clearTripOverlay() {
    if (!this.map || !this.map.getSource("trips-source")) return;
    try {
      this.map
        .getSource("trips-source")
        .setData({ type: "FeatureCollection", features: [] });
    } catch (error) {
      console.warn("Error clearing trip overlay:", error);
    }
  }

  /**
   * Load trips for view
   */
  async loadTripsForView() {
    if (!this.map || !this.showTripsActive || !this.map.isStyleLoaded()) return;
    this.setupTripLayers();
    const tripsSource = this.map.getSource("trips-source");
    if (!tripsSource) return;

    const bounds = this.map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const zoom = this.map.getZoom();

    if (zoom < 12) {
      this.notificationManager.show(
        "Zoom in further to view trip overlays.",
        "info",
        2000,
      );
      this.clearTripOverlay();
      return;
    }

    try {
      const trips = await COVERAGE_API.getTripsInBounds({ sw, ne });
      const tripFeatures = trips
        .map((coords, index) => {
          if (
            !Array.isArray(coords) ||
            coords.length < 2 ||
            !Array.isArray(coords[0]) ||
            coords[0].length < 2
          )
            return null;
          return {
            type: "Feature",
            properties: { tripId: `trip-${index}` },
            geometry: { type: "LineString", coordinates: coords },
          };
        })
        .filter((feature) => feature !== null);

      tripsSource.setData({
        type: "FeatureCollection",
        features: tripFeatures,
      });
    } catch (error) {
      this.notificationManager.show(
        `Failed to load trip overlay: ${error.message}`,
        "danger",
      );
      this.clearTripOverlay();
    }
  }

  /**
   * Create map info panel
   */
  createMapInfoPanel() {
    if (document.querySelector(".map-info-panel")) return;
    this.mapInfoPanel = document.createElement("div");
    this.mapInfoPanel.className = "map-info-panel";
    this.mapInfoPanel.style.display = "none";
    const mapContainer = document.getElementById("coverage-map");
    if (mapContainer) mapContainer.appendChild(this.mapInfoPanel);
    else console.warn("Map container not found for info panel.");
  }

  /**
   * Update map info panel
   */
  updateMapInfoPanel(props, isHover = false) {
    if (!this.mapInfoPanel) return;
    const streetName = props.name || props.street_name || "Unnamed Street";
    const streetType =
      props.highway || props.inferred_highway_type || "unknown";
    const segmentLength = parseFloat(
      props.segment_length || props.segment_length_m || props.length || 0,
    );
    const lengthFormatted = this.distanceInUserUnits(segmentLength);
    const isDriven =
      props.driven === true || String(props.driven).toLowerCase() === "true";
    const isUndriveable =
      props.undriveable === true ||
      String(props.undriveable).toLowerCase() === "true";
    const status = isDriven ? "Driven" : "Not Driven";
    const segmentId = props.segment_id || "N/A";

    this.mapInfoPanel.innerHTML = `
      <strong class="d-block mb-1">${streetName}</strong>
      ${isHover ? "" : '<hr class="panel-divider my-1">'}
      <div class="d-flex justify-content-between small"><span class="text-muted">Type:</span><span class="text-info">${this.formatStreetType(
        streetType,
      )}</span></div>
      <div class="d-flex justify-content-between small"><span class="text-muted">Length:</span><span class="text-info">${lengthFormatted}</span></div>
      <div class="d-flex justify-content-between small"><span class="text-muted">Status:</span><span class="${
        isDriven ? "text-success" : "text-danger"
      }"><i class="fas fa-${
        isDriven ? "check-circle" : "times-circle"
      } me-1"></i>${status}</span></div>
      ${
        isUndriveable
          ? '<div class="d-flex justify-content-between small"><span class="text-muted">Marked:</span><span class="text-warning"><i class="fas fa-exclamation-triangle me-1"></i>Undriveable</span></div>'
          : ""
      }
      ${
        isHover
          ? ""
          : `<div class="d-flex justify-content-between small mt-1"><span class="text-muted">ID:</span><span class="text-muted">${segmentId.substring(
              0,
              12,
            )}...</span></div><div class="mt-2 small text-center text-muted opacity-75">Click segment for actions</div>`
      }`;
    if (!isHover) this.mapInfoPanel.style.display = "block";
  }

  /**
   * Add coverage summary control
   */
  addCoverageSummary(coverage) {
    if (this.coverageSummaryControl && this.map?.removeControl) {
      try {
        this.map.removeControl(this.coverageSummaryControl);
      } catch (_e) {
        /* ignore */
      }
      this.coverageSummaryControl = null;
    }
    if (!coverage || !this.map) return;

    const coveragePercentage = parseFloat(
      coverage.coverage_percentage || 0,
    ).toFixed(1);
    const totalDist = this.distanceInUserUnits(
      coverage.total_length_m || coverage.total_length || 0,
    );
    const drivenDist = this.distanceInUserUnits(
      coverage.driven_length_m || coverage.driven_length || 0,
    );

    const controlDiv = document.createElement("div");
    controlDiv.className =
      "coverage-summary-control mapboxgl-ctrl mapboxgl-ctrl-group";
    controlDiv.innerHTML = `
      <div class="summary-title">Overall Coverage</div>
      <div class="summary-percentage">${coveragePercentage}%</div>
      <div class="summary-progress"><div class="progress" style="height: 8px;"><div class="progress-bar bg-success" role="progressbar" style="width: ${coveragePercentage}%"></div></div></div>
      <div class="summary-details"><div>Total: ${totalDist}</div><div>Driven: ${drivenDist}</div></div>`;

    this.coverageSummaryControl = {
      onAdd: () => controlDiv,
      onRemove: () => controlDiv.remove(),
      getDefaultPosition: () => "top-left",
    };
    try {
      this.map.addControl(this.coverageSummaryControl, "top-left");
    } catch (e) {
      console.error("Error adding coverage summary control:", e);
    }
  }

  /**
   * Update map theme
   */
  updateTheme(theme) {
    const styleUrl =
      theme === "light"
        ? "mapbox://styles/mapbox/light-v11"
        : "mapbox://styles/mapbox/dark-v11";

    if (this.map?.setStyle) {
      const center = this.map.getCenter();
      const zoom = this.map.getZoom();
      const bearing = this.map.getBearing();
      const pitch = this.map.getPitch();

      this.map.once("styledata", () => {
        this.map.jumpTo({ center, zoom, bearing, pitch });
        setTimeout(() => this.map.resize(), 100);

        if (this.showTripsActive) {
          this.setupTripLayers();
        }
      });

      this.map.setStyle(styleUrl);
    }
  }

  /**
   * Cleanup map
   */
  cleanup() {
    if (this.map) {
      try {
        this.map.remove();
      } catch (e) {
        console.warn("Error removing map:", e);
      }
      this.map = null;
    }
    this.streetsGeoJson = null;
    this.mapBounds = null;
    if (this.mapInfoPanel) {
      this.mapInfoPanel.remove();
      this.mapInfoPanel = null;
    }
    if (this.coverageSummaryControl && this.map) {
      try {
        this.map.removeControl(this.coverageSummaryControl);
      } catch (_e) {
        /* ignore */
      }
      this.coverageSummaryControl = null;
    }
  }

  /**
   * Utility: Distance in user units
   */
  distanceInUserUnits(meters, fixed = 2) {
    let validMeters = meters;
    if (typeof meters !== "number" || Number.isNaN(meters)) {
      validMeters = 0;
    }
    const miles = validMeters * 0.000621371;
    const formatted =
      miles < 0.1
        ? `${(validMeters * 3.28084).toFixed(0)} ft`
        : `${miles.toFixed(fixed)} mi`;
    this.lastDistanceLabel = formatted;
    return formatted;
  }

  /**
   * Utility: Format street type
   */
  formatStreetType(type) {
    if (!type) return "Unknown";
    const formatted = type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
    this.lastStreetTypeLabel = formatted;
    return formatted;
  }

  /**
   * Utility: Create alert message
   */
  createAlertMessage(title, message, type = "info") {
    const iconClass =
      {
        danger: "fa-exclamation-circle",
        warning: "fa-exclamation-triangle",
        info: "fa-info-circle",
        secondary: "fa-question-circle",
      }[type] || "fa-info-circle";

    const content = `
      <div class="alert alert-${type} m-3 fade-in-up">
        <h5 class="alert-heading h6 mb-1"><i class="fas ${iconClass} me-2"></i>${title}</h5>
        <p class="small mb-0">${message}</p>
      </div>`;
    this.lastAlertMessage = { title, message, type, content };
    return content;
  }
}

export default CoverageMap;
