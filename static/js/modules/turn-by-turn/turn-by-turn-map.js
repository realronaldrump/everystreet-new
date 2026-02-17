/**
 * Turn-by-Turn Map Module
 * Mapbox map initialization and layer management
 */

/* global mapboxgl */

import { MAP_STYLES } from "./turn-by-turn-config.js";

const getThemeColor = (variable, defaultColor) => {
  if (typeof window === "undefined") {
    return defaultColor;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  return value || defaultColor;
};

/**
 * Map manager for turn-by-turn navigation
 */
class TurnByTurnMap {
  constructor() {
    this.map = null;
    this.mapReady = false;
    this.themeObserver = null;

    // Coverage overlay state (re-applied after style changes)
    this._coverageFeatureCollection = null;
    this._coverageDrivenIds = new Set();
    this._coverageGlowTimeouts = new Map();

    // Markers
    this.positionMarker = null;
    this.startMarker = null;
    this.endMarker = null;

    // Accessibility
    this.prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
  }

  /**
   * Initialize the Mapbox map
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async initMap(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error("Map container not found.");
    }

    if (typeof mapboxgl === "undefined") {
      throw new Error("Map library failed to load.");
    }

    if (typeof mapboxgl.setTelemetryEnabled === "function") {
      mapboxgl.setTelemetryEnabled(false);
    }

    this.map = new mapboxgl.Map({
      container: containerId,
      style: this.getMapStyle(),
      center: [-96, 37.8],
      zoom: 4,
      pitch: 45,
      bearing: 0,
      antialias: true,
      attributionControl: false,
    });

    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();

    // Set up theme observer
    this.setupThemeObserver();

    // Wait for map to load
    await new Promise((resolve) => {
      this.map.on("load", () => {
        this.mapReady = true;
        this.setupMapLayers();
        resolve();
      });
    });
  }

  /**
   * Get map style based on current theme
   * @returns {string}
   */
  getMapStyle() {
    const isLightMode = document.body.classList.contains("light-mode");
    return isLightMode ? MAP_STYLES.light : MAP_STYLES.dark;
  }

  /**
   * Setup map interaction handlers
   * @param {Function} onDragStart
   */
  setupMapInteractions(onDragStart) {
    if (!this.map) {
      return;
    }
    this.map.on("dragstart", onDragStart);
  }

  /**
   * Observe theme changes and update map style
   */
  setupThemeObserver() {
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }

    this.themeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === "class" && this.map) {
          const newStyle = this.getMapStyle();
          const currentStyle = this.map.getStyle();
          // Only change if style actually changed
          if (
            currentStyle &&
            !currentStyle.sprite?.includes(newStyle.split("/").pop()?.replace("-v11", ""))
          ) {
            this.map.once("style.load", () => {
              this.setupMapLayers();
            });
            this.map.setStyle(newStyle);
          }
        }
      });
    });

    this.themeObserver.observe(document.body, { attributes: true });
  }

  /**
   * Setup all map layers
   */
  setupMapLayers() {
    if (!this.map) {
      return;
    }
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // === COVERAGE SEGMENT LAYERS ===

    if (!this.map.getSource("coverage-segments")) {
      this.map.addSource("coverage-segments", { type: "geojson", data: emptyGeoJSON });
    }

    // Base coverage line: style via feature-state to avoid rebuilding GeoJSON on every update.
    if (!this.map.getLayer("coverage-segments-line")) {
      this.map.addLayer({
        id: "coverage-segments-line",
        type: "line",
        source: "coverage-segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "case",
            ["boolean", ["feature-state", "driven"], false],
            getThemeColor("--success", "#4d9a6a"),
            getThemeColor("--color-undriven", "#c47050"),
          ],
          "line-width": 4,
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "driven"], false],
            0.4,
            0.6,
          ],
        },
      });
    }

    // Just-driven glow (feature-state `justDriven`)
    if (!this.map.getLayer("coverage-segments-glow")) {
      this.map.addLayer({
        id: "coverage-segments-glow",
        type: "line",
        source: "coverage-segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getThemeColor("--success", "#4d9a6a"),
          "line-width": 10,
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "justDriven"], false],
            0.3,
            0,
          ],
          "line-blur": 4,
        },
      });
    }

    if (!this.map.getLayer("coverage-segments-just-driven")) {
      this.map.addLayer({
        id: "coverage-segments-just-driven",
        type: "line",
        source: "coverage-segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getThemeColor("--success", "#4d9a6a"),
          "line-width": 5,
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "justDriven"], false],
            0.9,
            0,
          ],
        },
      });
    }

    // === ROUTE LAYERS ===

    if (!this.map.getSource("nav-route")) {
      this.map.addSource("nav-route", { type: "geojson", data: emptyGeoJSON });
    }

    if (!this.map.getSource("nav-route-progress")) {
      this.map.addSource("nav-route-progress", { type: "geojson", data: emptyGeoJSON });
    }

    if (!this.map.getSource("nav-to-start")) {
      this.map.addSource("nav-to-start", { type: "geojson", data: emptyGeoJSON });
    }

    const isLightMode = document.body.classList.contains("light-mode");
    const casingColor = isLightMode
      ? getThemeColor("--surface-1", "#ffffff")
      : getThemeColor("--surface-3", "#27272c");

    // Route casing
    if (!this.map.getLayer("nav-route-casing")) {
      this.map.addLayer({
        id: "nav-route-casing",
        type: "line",
        source: "nav-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": casingColor,
          "line-width": 10,
          "line-opacity": 0.9,
        },
      });
    }

    // Main route line
    if (!this.map.getLayer("nav-route-line")) {
      this.map.addLayer({
        id: "nav-route-line",
        type: "line",
        source: "nav-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getThemeColor("--secondary", "#727a84"),
          "line-width": 6,
          "line-opacity": 0.5,
        },
      });
    }

    // Progress line
    if (!this.map.getLayer("nav-route-progress")) {
      this.map.addLayer({
        id: "nav-route-progress",
        type: "line",
        source: "nav-route-progress",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getThemeColor("--primary", "#3b8a7f"),
          "line-width": 7,
          "line-opacity": 0.95,
        },
      });
    }

    // Navigate-to-start dashed line
    if (!this.map.getLayer("nav-to-start-line")) {
      this.map.addLayer({
        id: "nav-to-start-line",
        type: "line",
        source: "nav-to-start",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": getThemeColor("--accent-light", "#d09868"),
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [2, 1],
        },
      });
    }

    // Restore coverage data after style changes.
    this._restoreCoverageOverlay();
  }

  /**
   * Update route layers with new coordinates
   * @param {Array<[number, number]>} coords
   */
  updateRouteLayers(coords) {
    if (!this.map || !this.mapReady) {
      return;
    }

    const routeSource = this.map.getSource("nav-route");
    const progressSource = this.map.getSource("nav-route-progress");

    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: coords },
          properties: {},
        },
      ],
    };

    routeSource?.setData(geojson);
    progressSource?.setData({ type: "FeatureCollection", features: [] });
  }

  /**
   * Update progress line
   * @param {Array<[number, number]>} progressCoords
   */
  updateProgressLine(progressCoords) {
    if (!this.map) {
      return;
    }
    const progressSource = this.map.getSource("nav-route-progress");
    if (!progressSource) {
      return;
    }

    if (progressCoords.length < 2) {
      progressSource.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    progressSource.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: progressCoords },
          properties: {},
        },
      ],
    });
  }

  /**
   * Restore coverage overlays after style changes.
   */
  _restoreCoverageOverlay() {
    if (!this.map || !this.mapReady || !this._coverageFeatureCollection) {
      return;
    }

    const source = this.map.getSource("coverage-segments");
    if (!source) {
      return;
    }

    source.setData(this._coverageFeatureCollection);

    if (typeof this.map.removeFeatureState === "function") {
      this.map.removeFeatureState({ source: "coverage-segments" });
    }

    for (const segmentId of this._coverageDrivenIds) {
      this.map.setFeatureState(
        { source: "coverage-segments", id: segmentId },
        { driven: true }
      );
    }
  }

  _setCoverageOverlay(features, drivenIds) {
    this._coverageFeatureCollection = {
      type: "FeatureCollection",
      features: Array.isArray(features) ? features : [],
    };
    this._coverageDrivenIds = new Set(Array.isArray(drivenIds) ? drivenIds : []);

    // Clear any pending glow timers from a previous run/area.
    for (const timeoutId of this._coverageGlowTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this._coverageGlowTimeouts.clear();

    this._restoreCoverageOverlay();
  }

  _markCoverageSegmentsDriven(segmentIds, glowMs = 1500) {
    if (!this.map || !Array.isArray(segmentIds) || segmentIds.length === 0) {
      return;
    }

    for (const segmentId of segmentIds) {
      this._coverageDrivenIds.add(segmentId);

      this.map.setFeatureState(
        { source: "coverage-segments", id: segmentId },
        { driven: true, justDriven: true }
      );

      const existing = this._coverageGlowTimeouts.get(segmentId);
      if (existing) {
        clearTimeout(existing);
      }

      const timeoutId = setTimeout(() => {
        if (!this.map) {
          return;
        }
        this.map.setFeatureState(
          { source: "coverage-segments", id: segmentId },
          { justDriven: false }
        );
        this._coverageGlowTimeouts.delete(segmentId);
      }, glowMs);

      this._coverageGlowTimeouts.set(segmentId, timeoutId);
    }
  }

  /**
   * Update coverage overlay from TurnByTurnCoverage events.
   * @param {{type: string, features?: Array, drivenIds?: Array<string>, segmentIds?: Array<string>}} update
   */
  updateCoverageMapLayers(update) {
    if (!update || typeof update !== "object") {
      return;
    }

    if (update.type === "init") {
      this._setCoverageOverlay(update.features, update.drivenIds);
    } else if (update.type === "segments-driven") {
      this._markCoverageSegmentsDriven(update.segmentIds);
    }
  }

  /**
   * Set navigate-to-start route
   * @param {Object} geometry
   */
  setNavigateToStartRoute(geometry) {
    if (!this.map) {
      return;
    }
    const source = this.map.getSource("nav-to-start");
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry, properties: {} }],
      });
    }
  }

  /**
   * Clear navigate-to-start route
   */
  clearNavigateToStartRoute() {
    if (!this.map) {
      return;
    }
    const source = this.map.getSource("nav-to-start");
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }
  }

  /**
   * Add start and end markers
   * @param {[number, number]} startCoord
   * @param {[number, number]} endCoord
   */
  addRouteMarkers(startCoord, endCoord) {
    if (!this.map) {
      return;
    }

    this.startMarker?.remove();
    this.endMarker?.remove();

    // Start marker
    const startEl = document.createElement("div");
    startEl.className = "nav-start-marker";
    startEl.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i>';
    this.startMarker = new mapboxgl.Marker({ element: startEl })
      .setLngLat(startCoord)
      .addTo(this.map);

    // End marker
    const endEl = document.createElement("div");
    endEl.className = "nav-end-marker";
    endEl.innerHTML = '<i class="fas fa-flag-checkered" aria-hidden="true"></i>';
    this.endMarker = new mapboxgl.Marker({ element: endEl })
      .setLngLat(endCoord)
      .addTo(this.map);
  }

  /**
   * Update position marker
   * @param {[number, number]} coord
   */
  updatePositionMarker(coord) {
    if (!this.map) {
      return;
    }

    if (!this.positionMarker) {
      const markerEl = document.createElement("div");
      markerEl.className = "nav-position-marker";
      markerEl.innerHTML = '<i class="fas fa-location-arrow" aria-hidden="true"></i>';
      this.positionMarker = new mapboxgl.Marker({
        element: markerEl,
        rotationAlignment: "map",
      })
        .setLngLat(coord)
        .addTo(this.map);
    } else {
      this.positionMarker.setLngLat(coord);
    }
  }

  /**
   * Update position marker heading
   * @param {number} heading
   */
  updateMarkerHeading(heading) {
    if (!this.positionMarker || !Number.isFinite(heading)) {
      return;
    }
    this.positionMarker.setRotation(heading);
  }

  /**
   * Fit map to route bounds
   * @param {Array<[number, number]>} coords
   * @param {Object} options
   */
  fitBounds(coords, options = {}) {
    if (!this.map || coords.length < 2) {
      return;
    }

    const bounds = coords.reduce(
      (b, coord) => b.extend(coord),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );

    this.map.fitBounds(bounds, {
      padding: options.padding || 80,
      pitch: options.pitch ?? 0,
      bearing: options.bearing ?? 0,
      duration: this.prefersReducedMotion ? 0 : (options.duration ?? 1000),
    });
  }

  /**
   * Update camera position
   * @param {[number, number]} center
   * @param {number} bearing
   * @param {number} zoom
   * @param {Object} options
   */
  updateCamera(center, bearing, zoom, options = {}) {
    if (!this.map) {
      return;
    }

    const cameraUpdate = {
      center,
      bearing: bearing ?? 0,
      pitch: options.pitch ?? 60,
      zoom,
      offset: options.offset || [0, 140],
    };

    if (this.prefersReducedMotion) {
      this.map.jumpTo(cameraUpdate);
    } else {
      this.map.easeTo({ ...cameraUpdate, duration: options.duration ?? 800 });
    }
  }

  /**
   * Clear route layers
   */
  clearRouteLayers() {
    if (!this.map) {
      return;
    }
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };
    this.map.getSource("nav-route")?.setData(emptyGeoJSON);
    this.map.getSource("nav-route-progress")?.setData(emptyGeoJSON);
    this.startMarker?.remove();
    this.endMarker?.remove();
    this.startMarker = null;
    this.endMarker = null;
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    this.positionMarker?.remove();
    this.startMarker?.remove();
    this.endMarker?.remove();
  }
}

export default TurnByTurnMap;
