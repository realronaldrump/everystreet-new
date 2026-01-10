/* global mapboxgl */

/**
 * Navigation States - manages UX flow through the navigation experience
 */
const NAV_STATES = {
  SETUP: "setup", // Initial state, area selection
  ROUTE_PREVIEW: "preview", // Route loaded, showing preview with ETA
  NAVIGATING_TO_START: "nav_to_start", // Guiding user to route start point
  ARRIVED_AT_START: "at_start", // User within threshold of start
  ACTIVE_NAVIGATION: "navigating", // Actively driving the route
  OFF_ROUTE: "off_route", // User off route, showing return guidance
  RESUME_AHEAD: "resume", // Offering to resume from nearest point
  ARRIVED: "arrived", // At destination
};

const TURN_BY_TURN_DEFAULTS = {
  mapContainerId: "turn-by-turn-map",
  areaSelectId: "nav-area-select",
  loadRouteBtnId: "nav-load-route-btn",
  startBtnId: "nav-start-btn",
  endBtnId: "nav-end-btn",
  overviewBtnId: "nav-overview-btn",
  recenterBtnId: "nav-recenter-btn",
  routeBtnId: "nav-route-btn",
  // Smart start detection
  startThresholdMeters: 50,
  // Off-route detection
  offRouteThresholdMeters: 60,
  // Resume ahead search radius
  resumeSearchRadiusMeters: 500,
  // Progress smoothing
  maxProgressHistoryLength: 5,
  maxBackwardJumpMeters: 50,
  maxSpeedMps: 50, // ~112 mph
};

class TurnByTurnNavigator {
  constructor(options = {}) {
    this.config = { ...TURN_BY_TURN_DEFAULTS, ...options };
    this.map = null;
    this.mapReady = false;
    this.lightMapStyle = "mapbox://styles/mapbox/light-v11";
    this.darkMapStyle = "mapbox://styles/mapbox/dark-v11";
    this.directionsProfile = "mapbox/driving";
    this.directionsGeometry = "geojson";
    this.shortDistanceThreshold = 160;
    this.turnAngleThresholds = { uturn: 150, sharp: 100, turn: 50, slight: 25 };
    this.zoomThresholds = { highway: 55, arterial: 35, city: 20 };
    this.zoomLevels = {
      highway: 14.5,
      arterial: 15.2,
      city: 15.8,
      default: 16.5,
    };
    this.angleDeltaOffset = 540;
    this.degToRadFactor = Math.PI / 180;
    this.radToDegFactor = 180 / Math.PI;
    this.instructionLabels = {
      depart: "Head out on route",
      arrive: "Arrive at destination",
      "sharp-left": "Sharp left",
      "sharp-right": "Sharp right",
      left: "Turn left",
      right: "Turn right",
      "slight-left": "Bear left",
      "slight-right": "Bear right",
      uturn: "Make a U-turn",
      straight: "Continue straight",
    };
    this.turnRotations = {
      depart: 0,
      straight: 0,
      "slight-left": -45,
      "slight-right": 45,
      left: -90,
      right: 90,
      "sharp-left": -135,
      "sharp-right": 135,
      uturn: 180,
      arrive: 180,
    };
    this.durationLabels = { hour: "h", minute: "min" };

    // Coverage area data
    this.coverageAreas = [];
    this.selectedAreaId = null;
    this.selectedAreaName = null;

    // Route data
    this.routeCoords = [];
    this.routeDistances = [];
    this.segmentLengths = [];
    this.totalDistance = 0;
    this.maneuvers = [];
    this.routeName = "Coverage Route";

    // State machine
    this.navState = NAV_STATES.SETUP;
    this.previousState = null;

    // Navigation flags
    this.routeLoaded = false;
    this.isNavigating = false;
    this.followMode = true;
    this.overviewMode = false;

    // GPS tracking
    this.watchId = null;
    this.lastPosition = null;
    this.lastPositionTime = null;
    this.lastHeading = null;
    this.speedSamples = [];
    this.maxSpeedSamples = 6;
    this.lastClosestIndex = 0;

    // Smart start detection
    this.smartStartIndex = 0;
    this.smartStartPoint = null;
    this.smartStartDistance = null;

    // Route preview data
    this.estimatedDriveTime = null;
    this.navigateToStartRoute = null;

    // Dual progress metrics
    this.coverageBaseline = {
      totalMi: 0,
      coveredMi: 0,
      percentage: 0,
    };
    this.liveSegmentsCovered = new Set();
    this.liveCoverageIncrease = 0;

    // Real-time segment tracking for gamification
    this.segmentsData = null; // GeoJSON FeatureCollection of all segments
    this.segmentIndex = new Map(); // segment_id -> feature for fast lookup
    this.drivenSegmentIds = new Set(); // Segments driven during this session
    this.undrivenSegmentIds = new Set(); // Segments still to drive
    this.totalSegmentLength = 0;
    this.drivenSegmentLength = 0;
    this.segmentMatchThresholdMeters = 25; // How close to count as "on" segment

    // Progress smoothing
    this.progressHistory = [];
    this.lastValidProgress = 0;
    this.lastProgressTime = Date.now();

    // Map markers
    this.positionMarker = null;
    this.startMarker = null;
    this.endMarker = null;
    this.navigateToStartLayer = null;

    // Accessibility
    this.prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    // Theme observer
    this.themeObserver = null;

    this.cacheElements();
    this.bindEvents();
  }

  cacheElements() {
    // Setup controls
    this.areaSelect = document.getElementById(this.config.areaSelectId);
    this.loadRouteBtn = document.getElementById(this.config.loadRouteBtnId);
    this.startBtn = document.getElementById(this.config.startBtnId);
    this.endBtn = document.getElementById(this.config.endBtnId);
    this.overviewBtn = document.getElementById(this.config.overviewBtnId);
    this.recenterBtn = document.getElementById(this.config.recenterBtnId);
    this.routeBtn = document.getElementById(this.config.routeBtnId);

    // Setup panel
    this.setupPanel = document.getElementById("nav-setup");
    this.setupStatus = document.getElementById("nav-setup-status");
    this.setupSummary = document.getElementById("nav-setup-summary");

    // Route preview panel
    this.previewPanel = document.getElementById("nav-preview");
    this.previewDistance = document.getElementById("preview-distance");
    this.previewTime = document.getElementById("preview-time");
    this.previewTurns = document.getElementById("preview-turns");
    this.previewCoverage = document.getElementById("preview-coverage");
    this.previewStartStatus = document.getElementById("preview-start-status");
    this.previewStartText = document.getElementById("preview-start-text");
    this.navToStartBtn = document.getElementById("nav-start-from-here");
    this.beginNavBtn = document.getElementById("nav-begin");
    this.changeRouteBtn = document.getElementById("nav-change-route");

    // Navigation HUD
    this.navSignal = document.getElementById("nav-signal");
    this.navSignalText = document.getElementById("nav-signal-text");
    this.turnIcon = document.getElementById("nav-turn-icon");
    this.turnIconGlyph = this.turnIcon?.querySelector("i");
    this.distanceToTurn = document.getElementById("nav-distance-to-turn");
    this.primaryInstruction = document.getElementById("nav-primary-instruction");
    this.roadName = document.getElementById("nav-road-name");

    // Dual progress bars
    this.routeProgressFill = document.getElementById("nav-route-progress-fill");
    this.routeProgressValue = document.getElementById("nav-route-progress-value");
    this.coverageProgressBaseline = document.getElementById("nav-coverage-baseline");
    this.coverageProgressLive = document.getElementById("nav-coverage-live");
    this.coverageProgressValue = document.getElementById("nav-coverage-progress-value");

    // Legacy progress (fallback)
    this.progressFill = document.getElementById("nav-progress-fill");
    this.progressLabel = document.getElementById("nav-progress-label");
    this.progressValue = document.getElementById("nav-progress-value");

    // Stats
    this.remainingDistance = document.getElementById("nav-remaining-distance");
    this.etaLabel = document.getElementById("nav-eta");
    this.speedLabel = document.getElementById("nav-speed");
    this.navStatus = document.getElementById("nav-status");

    // Resume prompt
    this.resumePrompt = document.getElementById("nav-resume-prompt");
    this.resumeDistanceText = document.getElementById("resume-distance-text");
    this.resumeBtn = document.getElementById("nav-resume-btn");
    this.dismissResumeBtn = document.getElementById("nav-dismiss-resume");
  }

  bindEvents() {
    // Setup panel events
    this.areaSelect?.addEventListener("change", () => this.handleAreaChange());
    this.loadRouteBtn?.addEventListener("click", () => this.loadRoute());
    this.startBtn?.addEventListener("click", () => this.startNavigation());
    this.endBtn?.addEventListener("click", () => this.endNavigation());
    this.overviewBtn?.addEventListener("click", () => this.toggleOverview());
    this.recenterBtn?.addEventListener("click", () => this.recenter());
    this.routeBtn?.addEventListener("click", () => this.toggleSetupPanel());

    // Route preview events
    this.navToStartBtn?.addEventListener("click", () => this.startNavigatingToStart());
    this.beginNavBtn?.addEventListener("click", () => this.beginNavigation());
    this.changeRouteBtn?.addEventListener("click", () => this.showSetupPanel());

    // Resume prompt events
    this.resumeBtn?.addEventListener("click", () => this.resumeFromAhead());
    this.dismissResumeBtn?.addEventListener("click", () => this.dismissResumePrompt());

    // Live tracking fallback
    document.addEventListener("liveTrackingUpdated", (event) =>
      this.handleLiveTrackingUpdate(event)
    );
  }

  async init() {
    if (typeof mapboxgl === "undefined") {
      this.setSetupStatus("Map library failed to load.", true);
      return;
    }

    await this.initMap();
    await this.loadCoverageAreas();
    this.updateControlStates();
    this.applyInitialSelection();
  }

  async initMap() {
    const container = document.getElementById(this.config.mapContainerId);
    if (!container) {
      this.setSetupStatus("Map container not found.", true);
      return;
    }

    if (!window.MAPBOX_ACCESS_TOKEN) {
      this.setSetupStatus("Mapbox token missing.", true);
      return;
    }

    if (typeof mapboxgl.setTelemetryEnabled === "function") {
      mapboxgl.setTelemetryEnabled(false);
    }

    mapboxgl.accessToken = window.MAPBOX_ACCESS_TOKEN;
    this.map = new mapboxgl.Map({
      container: this.config.mapContainerId,
      style: this.getMapStyle(),
      center: [-96, 37.8],
      zoom: 4,
      pitch: 45,
      bearing: 0,
      antialias: true,
      attributionControl: true,
    });

    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();

    // Set up theme observer to switch map style
    this.setupThemeObserver();

    await new Promise((resolve) => {
      this.map.on("load", () => {
        this.mapReady = true;
        this.setupMapLayers();
        this.setupMapInteractions();
        resolve();
      });
    });
  }

  /**
   * Returns appropriate map style based on current theme
   */
  getMapStyle() {
    const isLightMode = document.body.classList.contains("light-mode");
    return isLightMode ? this.lightMapStyle : this.darkMapStyle;
  }

  /**
   * Observes theme changes and updates map style accordingly
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
            !currentStyle.sprite?.includes(
              newStyle.split("/").pop()?.replace("-v11", "")
            )
          ) {
            this.map.once("styledata", () => {
              // Re-add our layers after style change
              this.setupMapLayers();
              if (this.routeLoaded) {
                this.updateRouteLayers();
              }
            });
            this.map.setStyle(newStyle);
          }
        }
      });
    });

    this.themeObserver.observe(document.body, { attributes: true });
  }

  setupMapLayers() {
    if (!this.map) return;
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };

    // === COVERAGE SEGMENT LAYERS (rendered first, below route) ===

    // Source for undriven segments (red/to-do)
    if (!this.map.getSource("coverage-undriven")) {
      this.map.addSource("coverage-undriven", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    // Source for driven segments (green/complete)
    if (!this.map.getSource("coverage-driven")) {
      this.map.addSource("coverage-driven", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    // Source for segments just completed this session (animated)
    if (!this.map.getSource("coverage-just-driven")) {
      this.map.addSource("coverage-just-driven", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    // Undriven segments layer - subtle red, shows what's left to do
    if (!this.map.getLayer("coverage-undriven-line")) {
      this.map.addLayer({
        id: "coverage-undriven-line",
        type: "line",
        source: "coverage-undriven",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#d48584", // danger/red - matches app palette
          "line-width": 4,
          "line-opacity": 0.6,
        },
      });
    }

    // Already driven segments layer - muted green
    if (!this.map.getLayer("coverage-driven-line")) {
      this.map.addLayer({
        id: "coverage-driven-line",
        type: "line",
        source: "coverage-driven",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#6b9d8a", // success green - matches app palette
          "line-width": 4,
          "line-opacity": 0.4,
        },
      });
    }

    // Just-driven segments - bright green with glow effect
    if (!this.map.getLayer("coverage-just-driven-glow")) {
      this.map.addLayer({
        id: "coverage-just-driven-glow",
        type: "line",
        source: "coverage-just-driven",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#6b9d8a",
          "line-width": 10,
          "line-opacity": 0.3,
          "line-blur": 4,
        },
      });
    }

    if (!this.map.getLayer("coverage-just-driven-line")) {
      this.map.addLayer({
        id: "coverage-just-driven-line",
        type: "line",
        source: "coverage-just-driven",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#4caf50", // bright green for just completed
          "line-width": 5,
          "line-opacity": 0.9,
        },
      });
    }

    // === ROUTE LAYERS (rendered on top of coverage) ===

    // Main route source
    if (!this.map.getSource("nav-route")) {
      this.map.addSource("nav-route", { type: "geojson", data: emptyGeoJSON });
    }

    // Progress (driven portion) source
    if (!this.map.getSource("nav-route-progress")) {
      this.map.addSource("nav-route-progress", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    // Navigate-to-start route source
    if (!this.map.getSource("nav-to-start")) {
      this.map.addSource("nav-to-start", {
        type: "geojson",
        data: emptyGeoJSON,
      });
    }

    // Route casing (white outline) - uses theme-appropriate color
    const isLightMode = document.body.classList.contains("light-mode");
    const casingColor = isLightMode ? "#ffffff" : "#2f3239";

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

    // Main route line - uses secondary muted color
    if (!this.map.getLayer("nav-route-line")) {
      this.map.addLayer({
        id: "nav-route-line",
        type: "line",
        source: "nav-route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#8a8f98", // secondary color
          "line-width": 6,
          "line-opacity": 0.5,
        },
      });
    }

    // Progress line - uses primary sage green
    if (!this.map.getLayer("nav-route-progress")) {
      this.map.addLayer({
        id: "nav-route-progress",
        type: "line",
        source: "nav-route-progress",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#7c9d96", // primary sage green
          "line-width": 7,
          "line-opacity": 0.95,
        },
      });
    }

    // Navigate-to-start dashed line - uses warning color
    if (!this.map.getLayer("nav-to-start-line")) {
      this.map.addLayer({
        id: "nav-to-start-line",
        type: "line",
        source: "nav-to-start",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#d4a574", // warning color
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [2, 1],
        },
      });
    }
  }

  setupMapInteractions() {
    if (!this.map) return;
    this.map.on("dragstart", () => {
      this.followMode = false;
      this.overviewMode = false;
      this.updateControlStates();
    });
  }

  async loadCoverageAreas() {
    if (!this.areaSelect) return;
    try {
      if (Array.isArray(window.coverageNavigatorAreas)) {
        this.coverageAreas = window.coverageNavigatorAreas;
        this.populateAreaSelect();
        return;
      }

      const response = await fetch("/api/coverage_areas");
      if (!response.ok) {
        throw new Error(`Failed to fetch areas: ${response.statusText}`);
      }
      const data = await response.json();
      if (!data.success || !data.areas) {
        throw new Error(data.error || "Invalid coverage areas response.");
      }

      this.coverageAreas = data.areas;
      this.populateAreaSelect();
    } catch (error) {
      this.setSetupStatus(`Unable to load areas: ${error.message}`, true);
      this.areaSelect.innerHTML =
        '<option value="">Error loading coverage areas</option>';
    }
  }

  populateAreaSelect() {
    if (!this.areaSelect) return;
    this.areaSelect.innerHTML = '<option value="">Select a coverage area...</option>';
    this.coverageAreas.forEach((area) => {
      const areaId = area._id || area.id;
      const name =
        area.location?.display_name ||
        area.location?.city ||
        area.name ||
        "Coverage Area";
      if (!areaId) return;
      const option = document.createElement("option");
      option.value = String(areaId);
      option.textContent = name;
      option.dataset.name = name;
      this.areaSelect.appendChild(option);
    });
  }

  applyInitialSelection() {
    const params = new URLSearchParams(window.location.search);
    const queryArea = params.get("areaId");
    const storedArea = window.localStorage.getItem("turnByTurnAreaId");
    const areaId = queryArea || storedArea;
    if (!areaId || !this.areaSelect) return;

    // Only pre-select the dropdown, don't auto-load
    // This lets the user see what was previously selected and choose to load or change
    this.areaSelect.value = areaId;
    this.handleAreaChange();

    // Only auto-load if explicitly requested via URL param
    if (queryArea && params.get("autoStart") === "true") {
      this.loadRoute();
    }
  }

  handleAreaChange() {
    const selectedValue = this.areaSelect?.value || "";
    if (!selectedValue) {
      this.resetRouteState();
      this.selectedAreaId = null;
      this.selectedAreaName = null;
      if (this.loadRouteBtn) this.loadRouteBtn.disabled = true;
      if (this.startBtn) this.startBtn.disabled = true;
      this.setSetupStatus("Select an area to continue.");
      if (this.setupSummary) this.setupSummary.innerHTML = "";
      return;
    }

    this.resetRouteState();
    this.selectedAreaId = selectedValue;
    const selectedOption = this.areaSelect?.selectedOptions?.[0];
    this.selectedAreaName =
      selectedOption?.dataset?.name || selectedOption?.textContent;
    if (this.setupSummary) this.setupSummary.innerHTML = "";

    if (this.loadRouteBtn) this.loadRouteBtn.disabled = false;
    this.setSetupStatus("Ready to load the optimal route.");
    this.setNavStatus("Ready to load route.");
  }

  async loadRoute() {
    if (!this.selectedAreaId) {
      this.setSetupStatus("Select a coverage area first.", true);
      return;
    }

    this.setSetupStatus("Loading route...");
    this.setNavStatus("Loading route...");
    if (this.loadRouteBtn) {
      this.loadRouteBtn.disabled = true;
      this.loadRouteBtn.classList.add("loading");
    }
    if (this.startBtn) this.startBtn.disabled = true;
    this.routeLoaded = false;
    this.resetGuidanceUI();

    try {
      // Fetch route and coverage baseline in parallel
      const [routeResponse, coverageResponse] = await Promise.all([
        fetch(`/api/coverage_areas/${this.selectedAreaId}/optimal-route/gpx`),
        fetch(`/api/coverage_areas/${this.selectedAreaId}`),
      ]);

      if (!routeResponse.ok) {
        if (routeResponse.status === 404) {
          throw new Error("No optimal route found. Generate one first.");
        }
        throw new Error(`Failed to load route: ${routeResponse.statusText}`);
      }

      const gpxText = await routeResponse.text();
      const { coords, name } = this.parseGpx(gpxText);
      if (coords.length < 2) {
        throw new Error("GPX route is empty.");
      }

      // Process coverage baseline (gracefully handle failures)
      try {
        if (coverageResponse.ok) {
          const coverageData = await coverageResponse.json();
          if (coverageData.success && coverageData.coverage) {
            const cov = coverageData.coverage;
            this.coverageBaseline = {
              totalMi: (cov.driveable_length_m || cov.total_length || 0) / 1609.344,
              coveredMi: (cov.driven_length_m || cov.driven_length || 0) / 1609.344,
              percentage: cov.coverage_percentage || 0,
            };
          }
        }
      } catch (coverageError) {
        console.warn("Failed to load coverage baseline:", coverageError);
        // Continue with route - coverage tracking is optional
      }

      this.routeCoords = coords;
      this.routeName = this.selectedAreaName || name || "Coverage Route";
      this.buildRouteMetrics();
      this.buildManeuvers();
      this.updateRouteLayers();
      this.updateSetupSummary();

      this.routeLoaded = true;
      this.lastClosestIndex = 0;
      if (this.startBtn) this.startBtn.disabled = false;
      this.setSetupStatus("Route loaded. Ready to navigate.");
      this.setNavStatus("Route loaded.");
      this.updateProgressMeta(0);
      this.updateRemaining(this.totalDistance);
      if (this.distanceToTurn) this.distanceToTurn.textContent = "Route loaded";
      if (this.primaryInstruction)
        this.primaryInstruction.textContent = "Start navigation when ready";
      if (this.roadName) this.roadName.textContent = this.routeName;

      window.localStorage.setItem("turnByTurnAreaId", this.selectedAreaId);

      if (this.mapReady) {
        this.fitRouteBounds();
      }

      // Initialize coverage display with actual baseline
      this.initializeCoverageDisplay();

      // Load coverage area segments for real-time tracking
      await this.loadCoverageSegments();

      // Fetch ETA via Mapbox Directions and show preview
      await this.fetchRouteETA();
      this.transitionTo(NAV_STATES.ROUTE_PREVIEW);
    } catch (error) {
      this.clearRouteLayers();
      this.resetGuidanceUI();
      this.routeLoaded = false;
      this.setSetupStatus(error.message, true);
      this.setNavStatus(error.message, true);
    } finally {
      if (this.loadRouteBtn) {
        this.loadRouteBtn.disabled = false;
        this.loadRouteBtn.classList.remove("loading");
      }
    }
  }

  /**
   * Fetch estimated drive time via Mapbox Directions API
   */
  async fetchRouteETA() {
    if (this.routeCoords.length < 2) return;

    try {
      // Sample up to 25 waypoints from the route for Directions API
      const sampleCount = Math.min(25, this.routeCoords.length);
      const step = Math.floor(this.routeCoords.length / sampleCount);
      const waypoints = [];
      for (let i = 0; i < this.routeCoords.length; i += step) {
        waypoints.push(this.routeCoords[i]);
      }
      // Always include the last point
      if (
        waypoints[waypoints.length - 1] !==
        this.routeCoords[this.routeCoords.length - 1]
      ) {
        waypoints.push(this.routeCoords[this.routeCoords.length - 1]);
      }

      const coordsString = waypoints.map((c) => `${c[0]},${c[1]}`).join(";");
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordsString}?access_token=${mapboxgl.accessToken}&overview=false`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
          this.estimatedDriveTime = data.routes[0].duration;
        }
      }
    } catch (error) {
      console.warn("Failed to fetch route ETA:", error);
      // Fall back to simple calculation: assume 25 mph average
      this.estimatedDriveTime = (this.totalDistance / 1609.344 / 25) * 3600;
    }
  }

  /**
   * Fetch directions from one point to another via Mapbox Directions API
   */
  async fetchDirectionsToPoint(origin, destination) {
    try {
      const url = `https://api.mapbox.com/directions/v5/${this.directionsProfile}/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?access_token=${mapboxgl.accessToken}&geometries=${this.directionsGeometry}&overview=full`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.routes && data.routes.length > 0) {
          return {
            duration: data.routes[0].duration,
            distance: data.routes[0].distance,
            geometry: data.routes[0].geometry,
          };
        }
      }
    } catch (error) {
      console.warn("Failed to fetch directions:", error);
    }
    return null;
  }

  parseGpx(gpxText) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(gpxText, "application/xml");
    if (xml.querySelector("parsererror")) {
      throw new Error("Invalid GPX file.");
    }

    let points = Array.from(xml.querySelectorAll("trkpt"));
    if (points.length === 0) {
      points = Array.from(xml.querySelectorAll("rtept"));
    }

    const coords = points
      .map((pt) => {
        const lat = parseFloat(pt.getAttribute("lat"));
        const lon = parseFloat(pt.getAttribute("lon"));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return [lon, lat];
        }
        return null;
      })
      .filter(Boolean);

    const nameNode =
      xml.querySelector("trk > name") ||
      xml.querySelector("rte > name") ||
      xml.querySelector("metadata > name");
    const name = nameNode?.textContent?.trim() || this.routeName;
    return { coords, name };
  }

  buildRouteMetrics() {
    this.routeDistances = [0];
    this.segmentLengths = [];
    let total = 0;
    for (let i = 1; i < this.routeCoords.length; i += 1) {
      const dist = this.distanceMeters(this.routeCoords[i - 1], this.routeCoords[i]);
      this.segmentLengths.push(dist);
      total += dist;
      this.routeDistances.push(total);
    }
    this.totalDistance = total;
  }

  buildManeuvers() {
    const maneuvers = [];
    const minTurnDistance = 40;
    const minAngle = 28;
    let lastDistance = 0;

    for (let i = 1; i < this.routeCoords.length - 1; i += 1) {
      const inbound = this.bearing(this.routeCoords[i - 1], this.routeCoords[i]);
      const outbound = this.bearing(this.routeCoords[i], this.routeCoords[i + 1]);
      const delta = this.angleDelta(inbound, outbound);
      const absDelta = Math.abs(delta);
      const along = this.routeDistances[i];

      if (absDelta < minAngle) continue;
      if (along - lastDistance < minTurnDistance) continue;
      if (this.segmentLengths[i - 1] < 8 || this.segmentLengths[i] < 8) continue;

      maneuvers.push({
        index: i,
        distanceAlong: along,
        delta,
        type: TurnByTurnNavigator.classifyTurn(delta),
      });
      lastDistance = along;
    }

    maneuvers.unshift({ index: 0, distanceAlong: 0, delta: 0, type: "depart" });
    maneuvers.push({
      index: this.routeCoords.length - 1,
      distanceAlong: this.totalDistance,
      delta: 0,
      type: "arrive",
    });

    this.maneuvers = maneuvers;
  }

  updateRouteLayers() {
    if (!this.map || !this.mapReady) return;
    const routeSource = this.map.getSource("nav-route");
    const progressSource = this.map.getSource("nav-route-progress");
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: this.routeCoords,
          },
          properties: {},
        },
      ],
    };
    routeSource?.setData(geojson);
    progressSource?.setData({ type: "FeatureCollection", features: [] });

    this.addRouteMarkers();
  }

  addRouteMarkers() {
    if (!this.map || this.routeCoords.length < 2) return;
    this.startMarker?.remove();
    this.endMarker?.remove();

    const startEl = document.createElement("div");
    startEl.className = "nav-start-marker";
    startEl.innerHTML = '<i class="fas fa-play" aria-hidden="true"></i>';
    this.startMarker = new mapboxgl.Marker({ element: startEl })
      .setLngLat(this.routeCoords[0])
      .addTo(this.map);

    const endEl = document.createElement("div");
    endEl.className = "nav-end-marker";
    endEl.innerHTML = '<i class="fas fa-flag-checkered" aria-hidden="true"></i>';
    this.endMarker = new mapboxgl.Marker({ element: endEl })
      .setLngLat(this.routeCoords[this.routeCoords.length - 1])
      .addTo(this.map);
  }

  clearRouteLayers() {
    if (!this.map) return;
    const emptyGeoJSON = { type: "FeatureCollection", features: [] };
    this.map.getSource("nav-route")?.setData(emptyGeoJSON);
    this.map.getSource("nav-route-progress")?.setData(emptyGeoJSON);
    this.startMarker?.remove();
    this.endMarker?.remove();
    this.startMarker = null;
    this.endMarker = null;
  }

  resetGuidanceUI() {
    if (this.distanceToTurn) this.distanceToTurn.textContent = "Ready";
    if (this.primaryInstruction)
      this.primaryInstruction.textContent = "Select a route to begin";
    if (this.roadName) this.roadName.textContent = "--";
    this.setTurnRotation(0);
    this.turnIcon?.classList.remove("off-route", "arrive");
    if (this.progressValue) this.progressValue.textContent = "--";
    if (this.progressLabel) this.progressLabel.textContent = "Route";
    if (this.progressFill) this.progressFill.style.transform = "scaleX(0)";
    if (this.remainingDistance) this.remainingDistance.textContent = "--";
    if (this.etaLabel) this.etaLabel.textContent = "--";
    if (this.speedLabel) this.speedLabel.textContent = "--";
  }

  resetRouteState() {
    this.routeCoords = [];
    this.routeDistances = [];
    this.segmentLengths = [];
    this.totalDistance = 0;
    this.maneuvers = [];
    this.routeLoaded = false;
    this.lastClosestIndex = 0;
    this.speedSamples = [];

    // Reset smart start
    this.smartStartIndex = 0;
    this.smartStartPoint = null;
    this.smartStartDistance = null;

    // Reset progress tracking
    this.progressHistory = [];
    this.lastValidProgress = 0;
    this.lastProgressTime = Date.now();
    this.liveSegmentsCovered.clear();
    this.liveCoverageIncrease = 0;

    // Reset navigation state
    this.stopGeolocation();
    this.isNavigating = false;
    this.navState = NAV_STATES.SETUP;
    this.navigateToStartRoute = null;

    // Clear map
    this.clearRouteLayers();
    this.clearNavigateToStartRoute();

    // Reset UI
    this.resetGuidanceUI();
    this.setNavStatus("Waiting for route");
    this.transitionTo(NAV_STATES.SETUP);
  }

  /**
   * State machine transition - updates UI based on navigation state
   */
  transitionTo(newState) {
    this.previousState = this.navState;
    this.navState = newState;
    this.updateUIForState(newState);
  }

  /**
   * Updates all UI elements based on current navigation state
   */
  updateUIForState(state) {
    // Hide all panels first
    this.setupPanel?.classList.add("hidden");
    this.previewPanel?.setAttribute("hidden", "");
    this.resumePrompt?.setAttribute("hidden", "");

    switch (state) {
      case NAV_STATES.SETUP:
        this.setupPanel?.classList.remove("hidden");
        break;

      case NAV_STATES.ROUTE_PREVIEW:
        this.showRoutePreview();
        break;

      case NAV_STATES.NAVIGATING_TO_START:
        // Show navigation HUD with "navigate to start" messaging
        this.showNavigatingToStartUI();
        break;

      case NAV_STATES.ARRIVED_AT_START:
        // Brief state before auto-transitioning to active navigation
        this.showArrivedAtStartUI();
        break;

      case NAV_STATES.ACTIVE_NAVIGATION:
        // Full navigation mode
        this.showActiveNavigationUI();
        break;

      case NAV_STATES.OFF_ROUTE:
        // Show off-route indicator
        this.showOffRouteUI();
        break;

      case NAV_STATES.RESUME_AHEAD:
        // Show resume prompt
        this.showResumePromptUI();
        break;

      case NAV_STATES.ARRIVED:
        this.showArrivedUI();
        break;

      default:
        console.warn(`Unknown navigation state: ${state}`);
        break;
    }
  }

  /**
   * Shows the route preview screen
   */
  showRoutePreview() {
    this.setupPanel?.classList.add("hidden");
    this.previewPanel?.removeAttribute("hidden");

    // Update preview stats
    if (this.previewDistance) {
      this.previewDistance.textContent = TurnByTurnNavigator.formatDistance(
        this.totalDistance
      );
    }
    if (this.previewTime) {
      this.previewTime.textContent = this.formatDuration(this.estimatedDriveTime);
    }
    if (this.previewTurns) {
      this.previewTurns.textContent = Math.max(this.maneuvers.length - 2, 0);
    }
    if (this.previewCoverage) {
      // Show actual coverage percentage from API
      this.previewCoverage.textContent = `${this.coverageBaseline.percentage.toFixed(1)}%`;
    }

    // Fit bounds with navigation-style view (not top-down)
    this.fitRoutePreviewBounds();

    // Check user's proximity to start
    this.checkStartProximity();
  }

  /**
   * Fit route bounds with a nice perspective view for preview
   */
  fitRoutePreviewBounds() {
    if (!this.map || this.routeCoords.length < 2) return;

    const bounds = this.routeCoords.reduce(
      (b, coord) => b.extend(coord),
      new mapboxgl.LngLatBounds(this.routeCoords[0], this.routeCoords[0])
    );

    // Use a nice angled view instead of top-down
    this.map.fitBounds(bounds, {
      padding: { top: 120, bottom: 280, left: 40, right: 40 },
      pitch: 45,
      bearing: this.getRouteBearing(),
      duration: this.prefersReducedMotion ? 0 : 1000,
    });
  }

  /**
   * Get initial bearing based on route start direction
   */
  getRouteBearing() {
    if (this.routeCoords.length < 2) return 0;
    // Use bearing from start to a point further along the route
    const endIdx = Math.min(10, this.routeCoords.length - 1);
    return this.bearing(this.routeCoords[0], this.routeCoords[endIdx]);
  }

  /**
   * Checks if user is near the route start and updates preview UI
   */
  async checkStartProximity() {
    if (!navigator.geolocation) {
      this.updateStartStatus("unknown", "Enable location to check proximity");
      this.showNavigateToStartButton();
      return;
    }

    // Get current position
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const userPos = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        this.lastPosition = userPos;

        // Find smart start point
        const startInfo = this.findSmartStartPoint(userPos);

        if (startInfo.isAtStart) {
          this.updateStartStatus("at-start", "You're at the start point");
          this.showBeginButton();
        } else {
          // Get directions to start
          const directions = await this.fetchDirectionsToPoint(
            [userPos.lon, userPos.lat],
            startInfo.point
          );

          if (directions) {
            const distText = TurnByTurnNavigator.formatDistance(directions.distance);
            const timeText = this.formatDuration(directions.duration);
            this.updateStartStatus("away", `${distText} away (${timeText} to start)`);
            this.navigateToStartRoute = directions.geometry;
          } else {
            const distText = TurnByTurnNavigator.formatDistance(
              startInfo.distanceFromUser
            );
            this.updateStartStatus("away", `${distText} from start point`);
          }
          this.showNavigateToStartButton();
        }
      },
      () => {
        this.updateStartStatus("unknown", "Location unavailable");
        this.showNavigateToStartButton();
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }

  /**
   * Finds the closest point on the route to the user's position
   */
  findSmartStartPoint(userPosition) {
    if (!userPosition || !this.routeCoords.length) {
      return {
        index: 0,
        point: this.routeCoords[0],
        distanceFromUser: Infinity,
        isAtStart: false,
      };
    }

    const userCoord = [userPosition.lon, userPosition.lat];
    let bestIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < this.routeCoords.length; i++) {
      const dist = this.distanceMeters(userCoord, this.routeCoords[i]);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestIndex = i;
      }
    }

    this.smartStartIndex = bestIndex;
    this.smartStartPoint = this.routeCoords[bestIndex];
    this.smartStartDistance = bestDistance;

    return {
      index: bestIndex,
      point: this.smartStartPoint,
      distanceFromUser: bestDistance,
      isAtStart: bestDistance <= this.config.startThresholdMeters,
    };
  }

  /**
   * Updates the start status indicator in the preview
   */
  updateStartStatus(status, text) {
    if (this.previewStartStatus) {
      this.previewStartStatus.classList.remove("at-start", "away", "unknown");
      if (status) this.previewStartStatus.classList.add(status);
    }
    if (this.previewStartText) {
      this.previewStartText.textContent = text;
    }
  }

  showNavigateToStartButton() {
    this.navToStartBtn?.removeAttribute("hidden");
    this.beginNavBtn?.setAttribute("hidden", "");
  }

  showBeginButton() {
    this.navToStartBtn?.setAttribute("hidden", "");
    this.beginNavBtn?.removeAttribute("hidden");
  }

  /**
   * Start navigating to the route start point
   */
  async startNavigatingToStart() {
    if (!this.lastPosition || !this.smartStartPoint) {
      // No position yet, just start regular navigation
      this.beginNavigation();
      return;
    }

    // Add loading state to button
    if (this.navToStartBtn) {
      this.navToStartBtn.classList.add("loading");
    }

    try {
      // If we don't have a route yet, try to fetch one
      if (!this.navigateToStartRoute) {
        const directions = await this.fetchDirectionsToPoint(
          [this.lastPosition.lon, this.lastPosition.lat],
          this.smartStartPoint
        );
        if (directions) {
          this.navigateToStartRoute = directions.geometry;
        }
      }

      // Show the navigate-to-start route on map
      if (this.navigateToStartRoute && this.map) {
        const navToStartSource = this.map.getSource("nav-to-start");
        if (navToStartSource) {
          navToStartSource.setData({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: this.navigateToStartRoute,
                properties: {},
              },
            ],
          });
        }
      }

      this.transitionTo(NAV_STATES.NAVIGATING_TO_START);
      this.isNavigating = true;
      this.startGeolocation();
    } finally {
      if (this.navToStartBtn) {
        this.navToStartBtn.classList.remove("loading");
      }
    }
  }

  /**
   * Begin navigation (from start point)
   */
  beginNavigation() {
    this.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
    this.startNavigation();
  }

  showNavigatingToStartUI() {
    this.previewPanel?.setAttribute("hidden", "");
    this.setupPanel?.classList.add("hidden");

    if (this.primaryInstruction) {
      this.primaryInstruction.textContent = "Drive to start point";
    }
    if (this.distanceToTurn && this.smartStartDistance) {
      this.distanceToTurn.textContent = TurnByTurnNavigator.formatDistance(
        this.smartStartDistance
      );
    }
    this.setNavStatus("Navigating to route start");
  }

  showArrivedAtStartUI() {
    if (this.primaryInstruction) {
      this.primaryInstruction.textContent = "Arrived at start";
    }
    if (this.distanceToTurn) {
      this.distanceToTurn.textContent = "Starting route...";
    }
    this.turnIcon?.classList.add("arrive");

    // Auto-transition to active navigation after brief pause
    setTimeout(() => {
      if (this.navState === NAV_STATES.ARRIVED_AT_START) {
        this.clearNavigateToStartRoute();
        this.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
      }
    }, 1500);
  }

  showActiveNavigationUI() {
    this.previewPanel?.setAttribute("hidden", "");
    this.setupPanel?.classList.add("hidden");
    this.turnIcon?.classList.remove("arrive", "off-route");
    this.setNavStatus("On route");
  }

  showOffRouteUI() {
    this.turnIcon?.classList.add("off-route");
    this.turnIcon?.classList.remove("arrive");
    this.setNavStatus("Off route - return to highlighted path", true);
  }

  showResumePromptUI() {
    this.resumePrompt?.removeAttribute("hidden");
  }

  showArrivedUI() {
    this.turnIcon?.classList.add("arrive");
    this.turnIcon?.classList.remove("off-route");
    if (this.primaryInstruction) {
      this.primaryInstruction.textContent = "You have arrived!";
    }
    if (this.distanceToTurn) {
      this.distanceToTurn.textContent = "Destination";
    }
    this.setNavStatus("Arrived at destination");
  }

  clearNavigateToStartRoute() {
    if (this.map) {
      const source = this.map.getSource("nav-to-start");
      if (source) {
        source.setData({ type: "FeatureCollection", features: [] });
      }
    }
    this.navigateToStartRoute = null;
  }

  /**
   * Format duration in seconds to human readable string
   */
  formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return "--";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours}${this.durationLabels.hour} ${minutes}${this.durationLabels.minute}`;
    }
    return `${minutes} ${this.durationLabels.minute}`;
  }

  /**
   * Initialize coverage display with baseline from API
   */
  initializeCoverageDisplay() {
    const baselinePercent = this.coverageBaseline.percentage || 0;

    // Initialize the coverage progress bars
    if (this.coverageProgressBaseline) {
      this.coverageProgressBaseline.style.width = `${baselinePercent}%`;
    }
    if (this.coverageProgressLive) {
      this.coverageProgressLive.style.width = `${baselinePercent}%`;
    }
    if (this.coverageProgressValue) {
      this.coverageProgressValue.textContent = `${baselinePercent.toFixed(1)}%`;
    }
  }

  /**
   * Load coverage area segments for real-time tracking and gamification
   */
  async loadCoverageSegments() {
    if (!this.selectedAreaId) return;

    try {
      const response = await fetch(
        `/api/coverage_areas/${this.selectedAreaId}/streets`
      );
      if (!response.ok) {
        console.warn("Failed to load coverage segments");
        return;
      }

      const data = await response.json();
      if (!data.geojson || !data.geojson.features) {
        console.warn("No segment data in response");
        return;
      }

      this.segmentsData = data.geojson;
      this.segmentIndex.clear();
      this.drivenSegmentIds.clear();
      this.undrivenSegmentIds.clear();
      this.totalSegmentLength = 0;
      this.drivenSegmentLength = 0;

      const drivenFeatures = [];
      const undrivenFeatures = [];

      // Index all segments and categorize
      for (const feature of this.segmentsData.features) {
        const segmentId = feature.properties?.segment_id;
        const isDriven = feature.properties?.driven === true;
        const isUndriveable = feature.properties?.undriveable === true;
        const length = feature.properties?.segment_length || 0;

        if (!segmentId || isUndriveable) continue;

        this.segmentIndex.set(segmentId, feature);
        this.totalSegmentLength += length;

        if (isDriven) {
          this.drivenSegmentIds.add(segmentId);
          this.drivenSegmentLength += length;
          drivenFeatures.push(feature);
        } else {
          this.undrivenSegmentIds.add(segmentId);
          undrivenFeatures.push(feature);
        }
      }

      // Update map layers
      this.updateCoverageMapLayers(drivenFeatures, undrivenFeatures, []);
    } catch (error) {
      console.error("Error loading coverage segments:", error);
    }
  }

  /**
   * Update coverage map layers with current segment states
   */
  updateCoverageMapLayers(drivenFeatures, undrivenFeatures, justDrivenFeatures) {
    if (!this.map) return;

    const drivenSource = this.map.getSource("coverage-driven");
    const undrivenSource = this.map.getSource("coverage-undriven");
    const justDrivenSource = this.map.getSource("coverage-just-driven");

    if (drivenSource) {
      drivenSource.setData({
        type: "FeatureCollection",
        features: drivenFeatures,
      });
    }

    if (undrivenSource) {
      undrivenSource.setData({
        type: "FeatureCollection",
        features: undrivenFeatures,
      });
    }

    if (justDrivenSource) {
      justDrivenSource.setData({
        type: "FeatureCollection",
        features: justDrivenFeatures,
      });
    }
  }

  /**
   * Check if current position matches any undriven segments
   * Called on each GPS update during navigation
   */
  checkSegmentCoverage(currentPosition) {
    if (!this.segmentIndex.size || this.undrivenSegmentIds.size === 0) return;

    const current = [currentPosition.lon, currentPosition.lat];
    const newlyDriven = [];

    // Check each undriven segment
    for (const segmentId of this.undrivenSegmentIds) {
      const feature = this.segmentIndex.get(segmentId);
      if (!feature) continue;

      // Check if current position is close to this segment
      const distance = this.distanceToLineString(current, feature.geometry.coordinates);

      if (distance <= this.segmentMatchThresholdMeters) {
        // Mark as driven!
        newlyDriven.push(segmentId);
      }
    }

    // Process newly driven segments
    if (newlyDriven.length > 0) {
      this.markSegmentsDriven(newlyDriven);
    }
  }

  /**
   * Calculate minimum distance from a point to a LineString
   */
  distanceToLineString(point, lineCoords) {
    let minDistance = Infinity;

    for (let i = 0; i < lineCoords.length - 1; i++) {
      const segmentStart = lineCoords[i];
      const segmentEnd = lineCoords[i + 1];
      const dist = this.distanceToSegment(point, segmentStart, segmentEnd);
      if (dist < minDistance) {
        minDistance = dist;
      }
    }

    return minDistance;
  }

  /**
   * Calculate distance from point to line segment
   */
  distanceToSegment(point, segStart, segEnd) {
    const proj = this.projectToSegment(point, segStart, segEnd);
    return proj.distance;
  }

  /**
   * Mark segments as driven and update map with animation
   */
  markSegmentsDriven(segmentIds) {
    const newlyDrivenFeatures = [];

    for (const segmentId of segmentIds) {
      if (!this.undrivenSegmentIds.has(segmentId)) continue;

      const feature = this.segmentIndex.get(segmentId);
      if (!feature) continue;

      // Move from undriven to driven
      this.undrivenSegmentIds.delete(segmentId);
      this.drivenSegmentIds.add(segmentId);
      this.liveSegmentsCovered.add(segmentId);

      // Track length
      const length = feature.properties?.segment_length || 0;
      this.drivenSegmentLength += length;
      this.liveCoverageIncrease += length;

      newlyDrivenFeatures.push(feature);
    }

    if (newlyDrivenFeatures.length === 0) return;

    // Rebuild feature arrays
    const drivenFeatures = [];
    const undrivenFeatures = [];

    for (const [segmentId, feature] of this.segmentIndex) {
      if (this.drivenSegmentIds.has(segmentId)) {
        drivenFeatures.push(feature);
      } else if (this.undrivenSegmentIds.has(segmentId)) {
        undrivenFeatures.push(feature);
      }
    }

    // Update map with glow effect on newly driven
    this.updateCoverageMapLayers(drivenFeatures, undrivenFeatures, newlyDrivenFeatures);

    // Update coverage stats in real-time
    this.updateRealTimeCoverage();

    // Trigger satisfaction feedback
    this.onSegmentsCompleted(newlyDrivenFeatures.length);

    // Persist to server (debounced, non-blocking)
    this.queueSegmentPersistence(segmentIds);

    // Clear the "just driven" glow after animation
    setTimeout(() => {
      const justDrivenSource = this.map?.getSource("coverage-just-driven");
      if (justDrivenSource) {
        justDrivenSource.setData({ type: "FeatureCollection", features: [] });
      }
    }, 1500);
  }

  /**
   * Queue segment persistence to server (debounced to avoid flooding)
   */
  queueSegmentPersistence(segmentIds) {
    // Add to pending queue
    if (!this.pendingSegmentUpdates) {
      this.pendingSegmentUpdates = new Set();
    }
    for (const id of segmentIds) {
      this.pendingSegmentUpdates.add(id);
    }

    // Debounce: persist after 2 seconds of no new updates
    clearTimeout(this.persistSegmentsTimeout);
    this.persistSegmentsTimeout = setTimeout(() => {
      this.persistDrivenSegments();
    }, 2000);
  }

  /**
   * Persist driven segments to server
   */
  async persistDrivenSegments() {
    if (!this.pendingSegmentUpdates || this.pendingSegmentUpdates.size === 0) return;

    const segmentIds = Array.from(this.pendingSegmentUpdates);
    this.pendingSegmentUpdates.clear();

    try {
      // Use the bulk mark_driven endpoint
      await fetch("/api/street_segments/mark_driven", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segment_ids: segmentIds,
          location_id: this.selectedAreaId,
        }),
      });
    } catch (error) {
      console.warn("Failed to persist segments:", error);
      // Re-queue failed segments
      for (const id of segmentIds) {
        this.pendingSegmentUpdates.add(id);
      }
    }
  }

  /**
   * Update coverage percentage in real-time based on actual segments
   */
  updateRealTimeCoverage() {
    if (this.totalSegmentLength === 0) return;

    const realCoveragePercent =
      (this.drivenSegmentLength / this.totalSegmentLength) * 100;

    // Update the coverage progress bar
    if (this.coverageProgressLive) {
      this.coverageProgressLive.style.width = `${realCoveragePercent}%`;
    }
    if (this.coverageProgressValue) {
      this.coverageProgressValue.textContent = `${realCoveragePercent.toFixed(1)}%`;
    }

    // Update baseline to show original vs new
    const originalPercent = this.coverageBaseline.percentage || 0;
    if (this.coverageProgressBaseline) {
      this.coverageProgressBaseline.style.width = `${originalPercent}%`;
    }
  }

  /**
   * Satisfaction feedback when segments are completed
   */
  onSegmentsCompleted(count) {
    if (count === 0) return;

    // Subtle haptic feedback if available
    if (navigator.vibrate) {
      navigator.vibrate(count > 1 ? [30, 20, 30] : 30);
    }

    // Show visual feedback for multiple segments
    if (count >= 2) {
      this.showSegmentCompletionPopup(count);
    }

    // Track total for session stats
    this.sessionSegmentsCompleted = (this.sessionSegmentsCompleted || 0) + count;
  }

  /**
   * Show a brief popup when completing multiple segments at once
   */
  showSegmentCompletionPopup(count) {
    // Don't spam popups
    if (this.completionPopupTimeout) return;

    const popup = document.createElement("div");
    popup.className = "nav-segment-counter";
    popup.textContent = `+${count} segments`;
    document.body.appendChild(popup);

    this.completionPopupTimeout = setTimeout(() => {
      popup.remove();
      this.completionPopupTimeout = null;
    }, 700);
  }

  updateSetupSummary() {
    if (!this.setupSummary) return;
    const turnCount = Math.max(this.maneuvers.length - 2, 0);
    const coveragePercent = this.coverageBaseline.percentage || 0;
    this.setupSummary.innerHTML = `
      <div class="summary-item">
        <span>Distance</span>
        <span>${TurnByTurnNavigator.formatDistance(this.totalDistance)}</span>
      </div>
      <div class="summary-item">
        <span>Turns</span>
        <span>${turnCount}</span>
      </div>
      <div class="summary-item">
        <span>Coverage</span>
        <span>${coveragePercent.toFixed(1)}%</span>
      </div>
    `;
  }

  startNavigation() {
    if (!this.routeLoaded) {
      this.setNavStatus("Load a route first.", true);
      return;
    }
    if (!navigator.geolocation) {
      this.isNavigating = true;
      this.followMode = true;
      this.overviewMode = false;
      this.updateControlStates();
      this.hideSetupPanel();
      this.setNavStatus("Device GPS unavailable. Waiting for live tracking.", true);
      return;
    }

    this.isNavigating = true;
    this.followMode = true;
    this.overviewMode = false;
    this.updateControlStates();
    this.hideSetupPanel();
    this.startGeolocation();
  }

  endNavigation() {
    this.isNavigating = false;
    this.stopGeolocation();
    this.showSetupPanel();
    this.setNavStatus("Navigation ended.");
    this.transitionTo(NAV_STATES.SETUP);

    // Flush any pending segment updates
    this.persistDrivenSegments();

    // Show session summary if we completed segments
    if (this.sessionSegmentsCompleted > 0) {
      const _increase = this.liveCoverageIncrease / 1609.344; // Convert to miles
    }
  }

  /**
   * Cleanup resources when navigator is destroyed
   */
  destroy() {
    this.stopGeolocation();
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    this.positionMarker?.remove();
    this.startMarker?.remove();
    this.endMarker?.remove();
  }

  startGeolocation() {
    this.stopGeolocation();
    this.setNavStatus("Waiting for GPS...");
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.handlePosition(position),
      (error) => this.handleGeolocationError(error),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 1000,
      }
    );
  }

  stopGeolocation() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  handlePosition(position) {
    const { latitude, longitude, accuracy, heading, speed } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const fix = {
      lat: latitude,
      lon: longitude,
      accuracy,
      heading,
      speed,
      timestamp: position.timestamp || Date.now(),
    };

    this.updateSignal(accuracy);
    this.updateNavigation(fix);
  }

  handleLiveTrackingUpdate(event) {
    if (!this.isNavigating || this.watchId) return;
    const coords = event.detail?.coords || event.detail?.trip?.coordinates || [];
    if (!coords.length) return;
    const lastCoord = coords[coords.length - 1];
    if (!Number.isFinite(lastCoord?.lat) || !Number.isFinite(lastCoord?.lon)) return;

    const fix = {
      lat: lastCoord.lat,
      lon: lastCoord.lon,
      accuracy: null,
      heading: null,
      speed: null,
      timestamp: lastCoord.timestamp || Date.now(),
    };

    this.updateNavigation(fix);
  }

  handleGeolocationError(error) {
    if (error.code === error.PERMISSION_DENIED) {
      this.setNavStatus("Location permission denied. Waiting for live tracking.", true);
      this.stopGeolocation();
      return;
    }

    this.setNavStatus("Unable to fetch location.", true);
    this.isNavigating = false;
    this.stopGeolocation();
    this.showSetupPanel();
  }

  updateNavigation(fix) {
    if (!this.map || !this.routeLoaded) return;

    const current = [fix.lon, fix.lat];
    this.updatePositionMarker(current);

    // Always check segment coverage for real-time gamification
    this.checkSegmentCoverage({ lon: fix.lon, lat: fix.lat });

    // Handle NAVIGATING_TO_START state - check if we've arrived at start
    if (this.navState === NAV_STATES.NAVIGATING_TO_START) {
      const distToStart = TurnByTurnNavigator.distanceMeters(current, this.smartStartPoint);
      this.smartStartDistance = distToStart;

      if (this.distanceToTurn) {
        this.distanceToTurn.textContent =
          TurnByTurnNavigator.formatDistance(distToStart);
      }

      if (distToStart <= this.config.startThresholdMeters) {
        this.transitionTo(NAV_STATES.ARRIVED_AT_START);
      }
      return;
    }

    const closest = this.findClosestPoint(current);
    if (!closest) return;

    // Apply progress smoothing to avoid GPS jitter
    const rawProgress = Math.min(closest.along, this.totalDistance);
    const smoothedProgress = this.smoothProgress(rawProgress);
    const remainingDistance = Math.max(this.totalDistance - smoothedProgress, 0);
    const offRoute = closest.distance > this.config.offRouteThresholdMeters;

    // Handle state transitions based on position
    this.handleNavigationStateTransitions(
      smoothedProgress,
      remainingDistance,
      offRoute,
      closest
    );

    this.updateProgressLine(closest);
    this.updateDualProgress(smoothedProgress);
    this.updateRemaining(remainingDistance);

    const heading = this.resolveHeading(fix, closest);
    const speedMps = this.resolveSpeed(fix);
    this.updateEta(remainingDistance, speedMps);
    this.updateSpeed(speedMps);

    this.updateInstruction(smoothedProgress, remainingDistance, offRoute, closest);
    this.updateMarkerHeading(heading);
    this.updateCamera(current, heading, speedMps);
  }

  /**
   * Progress smoothing algorithm - reduces GPS jitter
   */
  smoothProgress(rawProgress) {
    const now = Date.now();
    const timeDelta = (now - this.lastProgressTime) / 1000;

    // Add to history
    this.progressHistory.push(rawProgress);
    if (this.progressHistory.length > this.config.maxProgressHistoryLength) {
      this.progressHistory.shift();
    }

    // Rule 1: Reject large backward jumps unless confirmed by multiple samples
    if (this.lastValidProgress - rawProgress > this.config.maxBackwardJumpMeters) {
      const backwardCount = this.progressHistory.filter(
        (p) => p < this.lastValidProgress - this.config.maxBackwardJumpMeters
      ).length;

      // Require 3+ confirmations before accepting regression
      if (backwardCount < 3) {
        return this.lastValidProgress;
      }
    }

    // Rule 2: Clamp forward jumps to physically possible speed
    const maxForward = this.config.maxSpeedMps * timeDelta;
    let clampedProgress = rawProgress;
    if (rawProgress - this.lastValidProgress > maxForward && timeDelta > 0) {
      clampedProgress = this.lastValidProgress + maxForward;
    }

    // Rule 3: Weighted moving average for smoothness
    const avg =
      this.progressHistory.reduce((a, b) => a + b, 0) / this.progressHistory.length;

    // Blend: 70% current, 30% average
    const smoothed = clampedProgress * 0.7 + avg * 0.3;

    this.lastValidProgress = smoothed;
    this.lastProgressTime = now;

    return smoothed;
  }

  /**
   * Handle navigation state transitions based on current position
   */
  handleNavigationStateTransitions(_progress, remaining, offRoute, closest) {
    // Check for arrival
    if (remaining < 25 && this.navState !== NAV_STATES.ARRIVED) {
      this.transitionTo(NAV_STATES.ARRIVED);
      return;
    }

    // Check for off-route condition
    if (offRoute && this.navState === NAV_STATES.ACTIVE_NAVIGATION) {
      // Check if significantly off-route (potential for resume ahead)
      if (closest.distance > this.config.resumeSearchRadiusMeters) {
        this.offerResumeFromAhead();
      } else {
        this.transitionTo(NAV_STATES.OFF_ROUTE);
      }
      return;
    }

    // Return to active navigation if back on route
    if (!offRoute && this.navState === NAV_STATES.OFF_ROUTE) {
      this.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
    }
  }

  /**
   * Updates dual progress bars (route progress + coverage area progress)
   */
  updateDualProgress(progressDistance) {
    // Route progress percentage
    const routePercent =
      this.totalDistance > 0 ? (progressDistance / this.totalDistance) * 100 : 0;

    // Update route progress bar
    if (this.routeProgressFill) {
      this.routeProgressFill.style.transform = `scaleX(${routePercent / 100})`;
    }
    if (this.routeProgressValue) {
      this.routeProgressValue.textContent = `${Math.round(routePercent)}%`;
    }

    // Coverage area progress - use REAL segment data if available
    if (this.totalSegmentLength > 0) {
      // We have real segment data - use actual coverage from segment tracking
      // updateRealTimeCoverage() handles this when segments are completed
      // Just keep the baseline display updated here
      const originalPercent = this.coverageBaseline.percentage || 0;
      if (this.coverageProgressBaseline) {
        this.coverageProgressBaseline.style.width = `${originalPercent}%`;
      }
    } else {
      // Fallback: estimate coverage when segment data isn't available
      const baselinePercent = this.coverageBaseline.percentage || 0;
      const routeMiles = progressDistance / 1609.344;
      const totalAreaMiles = this.coverageBaseline.totalMi || 1;
      const uncoveredFraction = (100 - baselinePercent) / 100;
      const estimatedNewCoverage =
        (routeMiles / totalAreaMiles) * 100 * uncoveredFraction * 0.8;
      const liveCoveragePercent = Math.min(100, baselinePercent + estimatedNewCoverage);

      if (this.coverageProgressBaseline) {
        this.coverageProgressBaseline.style.width = `${baselinePercent}%`;
      }
      if (this.coverageProgressLive) {
        this.coverageProgressLive.style.width = `${liveCoveragePercent}%`;
      }
      if (this.coverageProgressValue) {
        this.coverageProgressValue.textContent = `${liveCoveragePercent.toFixed(1)}%`;
      }
    }

    // Also update legacy progress bar for backwards compatibility
    this.updateProgressMeta(progressDistance);
  }

  /**
   * Offer resume from nearest point ahead when significantly off-route
   */
  async offerResumeFromAhead() {
    const current = this.lastPosition
      ? [this.lastPosition.lon, this.lastPosition.lat]
      : null;
    if (!current) return;

    const aheadResult = this.findNearestPointAhead(current);
    if (!aheadResult) {
      // No viable point ahead, stay in off-route
      this.transitionTo(NAV_STATES.OFF_ROUTE);
      return;
    }

    // Get road-based directions to resume point
    const directions = await this.fetchDirectionsToPoint(current, aheadResult.point);

    if (directions) {
      this.resumeAheadData = {
        index: aheadResult.index,
        point: aheadResult.point,
        distance: directions.distance,
        duration: directions.duration,
        geometry: directions.geometry,
      };

      if (this.resumeDistanceText) {
        this.resumeDistanceText.textContent = `${TurnByTurnNavigator.formatDistance(
          directions.distance
        )} (${this.formatDuration(directions.duration)})`;
      }

      this.transitionTo(NAV_STATES.RESUME_AHEAD);
    } else {
      this.transitionTo(NAV_STATES.OFF_ROUTE);
    }
  }

  /**
   * Find the nearest point on the route that is AHEAD of current progress
   */
  findNearestPointAhead(userCoord) {
    const searchStart = Math.max(0, this.lastClosestIndex);
    let bestIndex = -1;
    let bestDistance = Infinity;

    for (let i = searchStart; i < this.routeCoords.length; i++) {
      const dist = TurnByTurnNavigator.distanceMeters(userCoord, this.routeCoords[i]);
      if (dist < bestDistance && dist < this.config.resumeSearchRadiusMeters) {
        bestDistance = dist;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      return {
        index: bestIndex,
        point: this.routeCoords[bestIndex],
        distance: bestDistance,
      };
    }

    return null;
  }

  /**
   * Resume navigation from the offered point ahead
   */
  resumeFromAhead() {
    if (!this.resumeAheadData) return;

    // Update progress to the resume point
    this.lastClosestIndex = this.resumeAheadData.index;
    this.lastValidProgress = this.routeDistances[this.resumeAheadData.index];
    this.progressHistory = [this.lastValidProgress];

    // Clear resume data
    this.resumeAheadData = null;

    this.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
  }

  dismissResumePrompt() {
    this.resumeAheadData = null;
    this.transitionTo(NAV_STATES.OFF_ROUTE);
  }

  updatePositionMarker(current) {
    if (!this.map) return;
    if (!this.positionMarker) {
      const markerEl = document.createElement("div");
      markerEl.className = "nav-position-marker";
      markerEl.innerHTML = '<i class="fas fa-location-arrow" aria-hidden="true"></i>';
      this.positionMarker = new mapboxgl.Marker({
        element: markerEl,
        rotationAlignment: "map",
      })
        .setLngLat(current)
        .addTo(this.map);
    } else {
      this.positionMarker.setLngLat(current);
    }
  }

  updateMarkerHeading(heading) {
    if (!this.positionMarker || !Number.isFinite(heading)) return;
    this.positionMarker.setRotation(heading);
  }

  updateProgressLine(closest) {
    if (!this.map) return;
    const progressSource = this.map.getSource("nav-route-progress");
    if (!progressSource) return;

    const progressCoords = this.routeCoords.slice(0, closest.index + 1);
    if (closest.point) {
      progressCoords.push(closest.point);
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
          geometry: {
            type: "LineString",
            coordinates: progressCoords,
          },
          properties: {},
        },
      ],
    });
  }

  updateProgressMeta(progressDistance) {
    if (!this.progressLabel || !this.progressValue) return;
    this.progressLabel.textContent = this.routeName;
    this.progressValue.textContent = `${TurnByTurnNavigator.formatDistance(
      progressDistance
    )} of ${TurnByTurnNavigator.formatDistance(this.totalDistance)}`;

    if (this.progressFill) {
      const ratio = this.totalDistance ? progressDistance / this.totalDistance : 0;
      this.progressFill.style.transform = `scaleX(${Math.min(Math.max(ratio, 0), 1)})`;
    }
  }

  updateRemaining(distance) {
    if (this.remainingDistance) {
      this.remainingDistance.textContent = TurnByTurnNavigator.formatDistance(distance);
    }
  }

  updateEta(remainingDistance, speedMps) {
    if (!this.etaLabel) return;
    if (!speedMps || speedMps < 0.5) {
      this.etaLabel.textContent = "--";
      return;
    }
    const etaSeconds = remainingDistance / speedMps;
    const etaTime = new Date(Date.now() + etaSeconds * 1000);
    this.etaLabel.textContent = etaTime.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  updateSpeed(speedMps) {
    if (!this.speedLabel) return;
    if (!speedMps || speedMps < 0.5) {
      this.speedLabel.textContent = "--";
      return;
    }
    const mph = speedMps * 2.23694;
    this.speedLabel.textContent = `${Math.round(mph)} mph`;
  }

  updateInstruction(progressDistance, remainingDistance, offRoute, closest) {
    if (!this.primaryInstruction || !this.distanceToTurn) return;

    this.turnIcon?.classList.remove("off-route", "arrive");
    if (offRoute) {
      this.primaryInstruction.textContent = "Return to route";
      this.distanceToTurn.textContent = `Off by ${TurnByTurnNavigator.formatDistance(
        closest.distance
      )}`;
      if (this.roadName) this.roadName.textContent = this.routeName;
      this.turnIcon?.classList.add("off-route");
      this.setNavStatus("Off route. Rejoin the highlighted path.", true);
      this.setTurnRotation(0);
      return;
    }

    if (remainingDistance < 25) {
      this.primaryInstruction.textContent = "Arrive at destination";
      this.distanceToTurn.textContent = "Now";
      if (this.roadName) this.roadName.textContent = this.routeName;
      this.turnIcon?.classList.add("arrive");
      this.setNavStatus("Arriving at destination.");
      this.setTurnRotation(180);
      return;
    }

    const nextManeuver = this.getNextManeuver(progressDistance);
    if (!nextManeuver) return;

    const distanceTo = Math.max(nextManeuver.distanceAlong - progressDistance, 0);
    const distanceLabel =
      distanceTo < 25 ? "Now" : `In ${TurnByTurnNavigator.formatDistance(distanceTo)}`;
    const instruction = TurnByTurnNavigator.getInstructionText(nextManeuver.type);
    const rotation = TurnByTurnNavigator.getTurnRotation(nextManeuver.type);

    this.distanceToTurn.textContent = distanceLabel;
    this.primaryInstruction.textContent = instruction;
    if (this.roadName) this.roadName.textContent = this.routeName;
    this.setTurnRotation(rotation);
    this.setNavStatus("On route.");
  }

  updateCamera(current, heading, speedMps) {
    if (!this.map || !this.followMode || this.overviewMode) return;
    const zoom = this.getDynamicZoom(speedMps);
    const offset = [0, Math.min(180, Math.max(110, window.innerHeight * 0.18))];

    const cameraUpdate = {
      center: current,
      bearing: heading ?? 0,
      pitch: 60,
      zoom,
      offset,
    };

    if (this.prefersReducedMotion) {
      this.map.jumpTo(cameraUpdate);
    } else {
      this.map.easeTo({ ...cameraUpdate, duration: 800 });
    }
  }

  getDynamicZoom(speedMps) {
    const speedMph = speedMps ? speedMps * 2.23694 : 0;
    let zoom = this.zoomLevels.default;
    if (speedMph > this.zoomThresholds.highway) zoom = this.zoomLevels.highway;
    else if (speedMph > this.zoomThresholds.arterial) zoom = this.zoomLevels.arterial;
    else if (speedMph > this.zoomThresholds.city) zoom = this.zoomLevels.city;
    return zoom;
  }

  toggleOverview() {
    if (!this.map || !this.routeLoaded) return;
    this.overviewMode = !this.overviewMode;
    if (this.overviewMode) {
      this.followMode = false;
      this.fitRouteBounds();
    } else if (this.lastPosition) {
      this.followMode = true;
      this.updateCamera(
        [this.lastPosition.lon, this.lastPosition.lat],
        this.lastHeading
      );
    }
    this.updateControlStates();
  }

  recenter() {
    if (!this.lastPosition) return;
    this.followMode = true;
    this.overviewMode = false;
    this.updateControlStates();
    this.updateCamera([this.lastPosition.lon, this.lastPosition.lat], this.lastHeading);
  }

  updateControlStates() {
    this.overviewBtn?.classList.toggle("active", this.overviewMode);
    this.recenterBtn?.classList.toggle("active", this.followMode);
  }

  toggleSetupPanel() {
    if (!this.setupPanel) return;
    if (this.setupPanel.classList.contains("hidden")) {
      this.showSetupPanel();
    } else {
      this.hideSetupPanel();
    }
  }

  hideSetupPanel() {
    this.setupPanel?.classList.add("hidden");
  }

  showSetupPanel() {
    this.setupPanel?.classList.remove("hidden");
  }

  setSetupStatus(message, isError = false) {
    if (!this.setupStatus) return;
    this.setupStatus.textContent = message;
    this.setupStatus.style.color = isError ? "#b91c1c" : "";
  }

  setNavStatus(message, isError = false) {
    if (!this.navStatus) return;
    this.navStatus.textContent = message;
    this.navStatus.style.color = isError ? "#b91c1c" : "";
  }

  updateSignal(accuracy) {
    if (!this.navSignal || !this.navSignalText || !Number.isFinite(accuracy)) return;
    const rounded = Math.round(accuracy);
    this.navSignalText.textContent = `GPS ${rounded}m`;
    this.navSignal.classList.remove("good", "poor");
    if (accuracy <= 12) {
      this.navSignal.classList.add("good");
    } else if (accuracy >= 35) {
      this.navSignal.classList.add("poor");
    }
  }

  resolveSpeed(fix) {
    let speedMps = Number.isFinite(fix.speed) ? fix.speed : null;
    if (!speedMps && this.lastPosition && this.lastPositionTime) {
      const now = fix.timestamp;
      const last = this.lastPositionTime;
      const deltaTime = (now - last) / 1000;
      if (deltaTime > 0) {
        const distance = TurnByTurnNavigator.distanceMeters(
          [this.lastPosition.lon, this.lastPosition.lat],
          [fix.lon, fix.lat]
        );
        speedMps = distance / deltaTime;
      }
    }

    if (speedMps) {
      this.speedSamples.push(speedMps);
      if (this.speedSamples.length > this.maxSpeedSamples) {
        this.speedSamples.shift();
      }
    }

    this.lastPosition = { lat: fix.lat, lon: fix.lon };
    this.lastPositionTime = fix.timestamp;
    return this.getAverageSpeed();
  }

  getAverageSpeed() {
    if (this.speedSamples.length === 0) return null;
    const sum = this.speedSamples.reduce((acc, v) => acc + v, 0);
    return sum / this.speedSamples.length;
  }

  resolveHeading(fix, closest) {
    let heading = Number.isFinite(fix.heading) ? fix.heading : null;
    if (!heading && this.lastPosition) {
      heading = TurnByTurnNavigator.bearing(
        [this.lastPosition.lon, this.lastPosition.lat],
        [fix.lon, fix.lat]
      );
    }
    if (!heading && closest && closest.index < this.routeCoords.length - 1) {
      heading = TurnByTurnNavigator.bearing(
        this.routeCoords[closest.index],
        this.routeCoords[closest.index + 1]
      );
    }
    this.lastHeading = heading;
    return heading;
  }

  getNextManeuver(progressDistance) {
    return this.maneuvers.find((m) => m.distanceAlong > progressDistance + 5);
  }

  static classifyTurn(delta) {
    const { uturn, sharp, turn, slight } = {
      uturn: 150,
      sharp: 100,
      turn: 50,
      slight: 25,
    };
    const abs = Math.abs(delta);
    let classification = "straight";
    if (abs > uturn) classification = "uturn";
    else if (abs > sharp) classification = delta > 0 ? "sharp-right" : "sharp-left";
    else if (abs > turn) classification = delta > 0 ? "right" : "left";
    else if (abs > slight) classification = delta > 0 ? "slight-right" : "slight-left";
    return classification;
  }

  static getInstructionText(type) {
    const instructionLabels = {
      depart: "Head out on route",
      arrive: "Arrive at destination",
      "sharp-left": "Sharp left",
      "sharp-right": "Sharp right",
      left: "Turn left",
      right: "Turn right",
      "slight-left": "Bear left",
      "slight-right": "Bear right",
      uturn: "Make a U-turn",
      straight: "Continue straight",
    };
    return instructionLabels[type] || "Continue";
  }

  static getTurnRotation(type) {
    const turnRotations = {
      depart: 0,
      straight: 0,
      "slight-left": -45,
      "slight-right": 45,
      left: -90,
      right: 90,
      "sharp-left": -135,
      "sharp-right": 135,
      uturn: 180,
      arrive: 180,
    };
    return turnRotations[type] ?? 0;
  }

  setTurnRotation(deg) {
    if (!this.turnIconGlyph) return;
    this.turnIconGlyph.style.transform = `rotate(${deg}deg)`;
  }

  fitRouteBounds() {
    if (!this.map || this.routeCoords.length < 2) return;
    const bounds = this.routeCoords.reduce(
      (b, coord) => b.extend(coord),
      new mapboxgl.LngLatBounds(this.routeCoords[0], this.routeCoords[0])
    );
    this.map.fitBounds(bounds, {
      padding: 80,
      duration: this.prefersReducedMotion ? 0 : 1000,
    });
  }

  findClosestPoint(current) {
    if (!this.routeCoords.length) return null;
    const totalSegments = this.routeCoords.length - 1;
    let startIndex = 0;
    let endIndex = totalSegments - 1;

    if (this.lastClosestIndex) {
      startIndex = Math.max(0, this.lastClosestIndex - 120);
      endIndex = Math.min(totalSegments - 1, this.lastClosestIndex + 240);
    }

    const searchRange = (from, to) => {
      let closest = null;
      for (let i = from; i <= to; i += 1) {
        const proj = this.projectToSegment(
          current,
          this.routeCoords[i],
          this.routeCoords[i + 1]
        );
        if (!closest || proj.distance < closest.distance) {
          closest = {
            index: i,
            distance: proj.distance,
            point: proj.point,
            along: this.routeDistances[i] + proj.t * this.segmentLengths[i],
          };
        }
      }
      return closest;
    };

    let best = searchRange(startIndex, endIndex);
    if (!best || best.distance > 250) {
      best = searchRange(0, totalSegments - 1);
    }

    if (best) this.lastClosestIndex = best.index;
    return best;
  }

  projectToSegment(point, a, b) {
    const refLat = (a[1] + b[1]) / 2;
    const p = TurnByTurnNavigator.toXY(point, refLat);
    const p1 = TurnByTurnNavigator.toXY(a, refLat);
    const p2 = TurnByTurnNavigator.toXY(b, refLat);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq;
      t = Math.min(1, Math.max(0, t));
    }
    const projX = p1.x + t * dx;
    const projY = p1.y + t * dy;
    const distance = Math.hypot(p.x - projX, p.y - projY);
    const projLng = a[0] + t * (b[0] - a[0]);
    const projLat = a[1] + t * (b[1] - a[1]);
    return { distance, t, point: [projLng, projLat] };
  }

  static toXY(coord, refLat) {
    const r = 6371000;
    const lat = TurnByTurnNavigator.toRad(coord[1]);
    const lon = TurnByTurnNavigator.toRad(coord[0]);
    const x = lon * Math.cos(TurnByTurnNavigator.toRad(refLat)) * r;
    const y = lat * r;
    return { x, y };
  }

  static distanceMeters(a, b) {
    const r = 6371000;
    const dLat = TurnByTurnNavigator.toRad(b[1] - a[1]);
    const dLon = TurnByTurnNavigator.toRad(b[0] - a[0]);
    const lat1 = TurnByTurnNavigator.toRad(a[1]);
    const lat2 = TurnByTurnNavigator.toRad(b[1]);
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  static bearing(a, b) {
    const lat1 = TurnByTurnNavigator.toRad(a[1]);
    const lat2 = TurnByTurnNavigator.toRad(b[1]);
    const dLon = TurnByTurnNavigator.toRad(b[0] - a[0]);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (TurnByTurnNavigator.toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  angleDelta(from, to) {
    return ((to - from + this.angleDeltaOffset) % 360) - 180;
  }

  static formatDistance(meters) {
    if (!Number.isFinite(meters)) return "--";
    if (meters < 160) {
      return `${Math.round(meters * 3.28084)} ft`;
    }
    const miles = meters / 1609.344;
    return `${miles < 10 ? miles.toFixed(1) : miles.toFixed(0)} mi`;
  }

  static toRad(deg) {
    return deg * (Math.PI / 180);
  }

  static toDeg(rad) {
    return rad * (180 / Math.PI);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const turnByTurn = new TurnByTurnNavigator();
  turnByTurn.init();
});
