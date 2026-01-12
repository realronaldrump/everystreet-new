/**
 * Turn-by-Turn Navigator - Main Orchestrator
 * Coordinates all turn-by-turn navigation modules
 */

/* global mapboxgl */

import TurnByTurnAPI from "./turn-by-turn-api.js";
import {
  DISTANCE_THRESHOLDS,
  NAV_STATES,
  TURN_BY_TURN_DEFAULTS,
  ZOOM_LEVELS,
  ZOOM_THRESHOLDS,
} from "./turn-by-turn-config.js";
import TurnByTurnCoverage from "./turn-by-turn-coverage.js";
import {
  angleDelta,
  bearing,
  classifyTurn,
  distanceMeters,
  formatDistance,
  projectToSegment,
} from "./turn-by-turn-geo.js";
import TurnByTurnGPS from "./turn-by-turn-gps.js";
import TurnByTurnMap from "./turn-by-turn-map.js";
import TurnByTurnState from "./turn-by-turn-state.js";
import TurnByTurnUI from "./turn-by-turn-ui.js";

/**
 * Main turn-by-turn navigator class
 */
class TurnByTurnNavigator {
  constructor(options = {}) {
    this.config = { ...TURN_BY_TURN_DEFAULTS, ...options };

    // Initialize sub-modules
    this.map = new TurnByTurnMap();
    this.ui = new TurnByTurnUI(this.config);
    this.gps = new TurnByTurnGPS(this.config);
    this.state = new TurnByTurnState(this.config);
    this.coverage = new TurnByTurnCoverage(this.config);

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

    // Coverage baseline
    this.coverageBaseline = {
      totalMi: 0,
      coveredMi: 0,
      percentage: 0,
    };

    // Navigation flags
    this.routeLoaded = false;
    this.isNavigating = false;
    this.followMode = true;
    this.overviewMode = false;
    this.needsStartSeed = false;

    // Route preview
    this.estimatedDriveTime = null;
    this.navigateToStartRoute = null;

    // Index tracking
    this.lastClosestIndex = 0;

    // Setup callbacks
    this.setupCallbacks();
  }

  /**
   * Setup callbacks between modules
   */
  setupCallbacks() {
    // State change callback
    this.state.setStateChangeCallback((newState) => {
      this.ui.updateForState(newState, this.getStateData(newState));

      if (newState === NAV_STATES.ROUTE_PREVIEW) {
        // Show a usable start action immediately, then refine based on proximity.
        this.ui.showBeginButton();
        this.checkStartProximity();
      }
    });

    // Coverage map update callback
    this.coverage.setCallbacks({
      onMapUpdate: (driven, undriven, justDriven) => {
        this.map.updateCoverageMapLayers(driven, undriven, justDriven);
      },
      onCoverageUpdate: (stats) => {
        const baselinePercent = this.coverageBaseline.percentage || 0;
        this.ui.updateCoverageProgress(baselinePercent, stats.percentage);
      },
    });
  }

  /**
   * Get data for state-based UI updates
   */
  getStateData(state) {
    switch (state) {
      case NAV_STATES.ROUTE_PREVIEW:
        return {
          totalDistance: this.totalDistance,
          estimatedTime: this.estimatedDriveTime,
          turnCount: Math.max(this.maneuvers.length - 2, 0),
          coveragePercent: this.coverageBaseline.percentage,
        };
      case NAV_STATES.NAVIGATING_TO_START:
        return {
          distanceToStart: this.state.smartStartDistance,
        };
      default:
        return {};
    }
  }

  /**
   * Initialize the navigator
   */
  async init() {
    if (typeof mapboxgl === "undefined") {
      this.ui.setSetupStatus("Map library failed to load.", true);
      return;
    }

    // Cache DOM elements and bind events
    this.ui.cacheElements();
    this.bindUIEvents();

    // Initialize map
    try {
      await this.map.initMap(this.config.mapContainerId);
      this.map.setupMapInteractions(() => {
        this.followMode = false;
        this.overviewMode = false;
        this.ui.updateControlStates(this.overviewMode, this.followMode);
      });
    } catch (error) {
      this.ui.setSetupStatus(error.message, true);
      return;
    }

    // Load coverage areas
    await this.loadCoverageAreas();

    // Update control states
    this.ui.updateControlStates(this.overviewMode, this.followMode);

    // Apply initial selection from URL/storage
    this.applyInitialSelection();

    // Live tracking fallback event
    document.addEventListener("liveTrackingUpdated", (event) =>
      this.handleLiveTrackingUpdate(event)
    );
  }

  /**
   * Bind UI event handlers
   */
  bindUIEvents() {
    this.ui.bindEvents({
      onAreaChange: () => this.handleAreaChange(),
      onLoadRoute: () => this.loadRoute(),
      onStartNavigation: () => this.beginNavigation(),
      onEndNavigation: () => this.endNavigation(),
      onToggleOverview: () => this.toggleOverview(),
      onRecenter: () => this.recenter(),
      onToggleSetupPanel: () => this.ui.toggleSetupPanel(),
      onNavigateToStart: () => this.startNavigatingToStart(),
      onBeginNavigation: () => this.beginNavigation(),
      onShowSetup: () => this.state.transitionTo(NAV_STATES.SETUP),
      onResumeFromAhead: () => this.resumeFromAhead(),
      onDismissResume: () => this.dismissResumePrompt(),
    });
  }

  /**
   * Load coverage areas from API or window
   */
  async loadCoverageAreas() {
    try {
      if (Array.isArray(window.coverageNavigatorAreas)) {
        this.coverageAreas = window.coverageNavigatorAreas;
      } else {
        this.coverageAreas = await TurnByTurnAPI.fetchCoverageAreas();
      }
      this.ui.populateAreaSelect(this.coverageAreas);
    } catch (error) {
      this.ui.setSetupStatus(`Unable to load areas: ${error.message}`, true);
    }
  }

  /**
   * Apply initial area selection from URL or localStorage
   */
  applyInitialSelection() {
    const params = new URLSearchParams(window.location.search);
    const queryArea = params.get("areaId");
    const storedArea = window.localStorage.getItem("turnByTurnAreaId");
    const areaId = queryArea || storedArea;

    if (!areaId) {
      return;
    }

    this.ui.setAreaSelectValue(areaId);
    this.handleAreaChange();

    // Auto-load if explicitly requested via URL
    if (queryArea && params.get("autoStart") === "true") {
      this.loadRoute();
    }
  }

  /**
   * Handle area selection change
   */
  handleAreaChange() {
    const selectedValue = this.ui.getSelectedAreaId();

    if (!selectedValue) {
      this.resetRouteState();
      this.selectedAreaId = null;
      this.selectedAreaName = null;
      this.ui.setLoadRouteEnabled(false);
      this.ui.setStartEnabled(false);
      this.ui.setSetupStatus("Select an area to continue.");
      return;
    }

    this.resetRouteState();
    this.selectedAreaId = selectedValue;
    this.selectedAreaName = this.ui.getSelectedAreaName();

    this.ui.setLoadRouteEnabled(true);
    this.ui.setSetupStatus("Ready to load the optimal route.");
    this.ui.setNavStatus("Ready to load route.");
  }

  /**
   * Load the optimal route for selected area
   */
  async loadRoute() {
    if (!this.selectedAreaId) {
      this.ui.setSetupStatus("Select a coverage area first.", true);
      return;
    }

    this.ui.setSetupStatus("Loading route...");
    this.ui.setNavStatus("Loading route...");
    this.ui.setLoadRouteLoading(true);
    this.ui.setStartEnabled(false);
    this.routeLoaded = false;
    this.ui.resetGuidanceUI();

    try {
      // Fetch route and coverage baseline in parallel
      const [gpxText, coverageData] = await Promise.all([
        TurnByTurnAPI.fetchOptimalRouteGpx(this.selectedAreaId),
        TurnByTurnAPI.fetchCoverageArea(this.selectedAreaId).catch(() => null),
      ]);

      const { coords, name } = this.parseGpx(gpxText);
      if (coords.length < 2) {
        throw new Error("GPX route is empty.");
      }

      // Process coverage baseline
      if (coverageData) {
        const driveableMiles
          = coverageData.driveable_length_miles ?? coverageData.total_length_miles ?? 0;
        const drivenMiles = coverageData.driven_length_miles ?? 0;
        this.coverageBaseline = {
          totalMi: driveableMiles,
          coveredMi: drivenMiles,
          percentage: coverageData.coverage_percentage || 0,
        };
      }

      this.routeCoords = coords;
      this.routeName = this.selectedAreaName || name || "Coverage Route";
      this.buildRouteMetrics();
      this.buildManeuvers();
      this.map.updateRouteLayers(this.routeCoords);
      this.map.addRouteMarkers(
        this.routeCoords[0],
        this.routeCoords[this.routeCoords.length - 1]
      );

      this.ui.updateSetupSummary(
        this.totalDistance,
        Math.max(this.maneuvers.length - 2, 0),
        this.coverageBaseline.percentage
      );

      this.routeLoaded = true;
      this.lastClosestIndex = 0;
      this.ui.setStartEnabled(true);
      this.ui.setSetupStatus("Route loaded. Ready to navigate.");
      this.ui.setNavStatus("Route loaded.");
      this.ui.updateRouteProgress(0, this.totalDistance, this.routeName);
      this.ui.updateRemaining(this.totalDistance);

      window.localStorage.setItem("turnByTurnAreaId", this.selectedAreaId);

      if (this.map.mapReady) {
        this.map.fitBounds(this.routeCoords, { padding: 80 });
      }

      // Initialize coverage display
      this.ui.initializeCoverageDisplay(this.coverageBaseline.percentage);

      // Load coverage segments for real-time tracking
      await this.coverage.loadSegments(this.selectedAreaId);

      // Fetch ETA and show preview
      await this.fetchRouteETA();
      this.state.transitionTo(NAV_STATES.ROUTE_PREVIEW);
    } catch (error) {
      this.map.clearRouteLayers();
      this.ui.resetGuidanceUI();
      this.routeLoaded = false;
      this.ui.setSetupStatus(error.message, true);
      this.ui.setNavStatus(error.message, true);
    } finally {
      this.ui.setLoadRouteLoading(false);
    }
  }

  /**
   * Fetch estimated drive time
   */
  async fetchRouteETA() {
    const duration = await TurnByTurnAPI.fetchRouteETA(
      this.routeCoords,
      this.map.getAccessToken()
    );

    if (duration) {
      this.estimatedDriveTime = duration;
    } else {
      // Fallback: assume 25 mph average
      this.estimatedDriveTime = (this.totalDistance / 1609.344 / 25) * 3600;
    }
  }

  /**
   * Parse GPX text to coordinates
   */
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

    const nameNode
      = xml.querySelector("trk > name")
      || xml.querySelector("rte > name")
      || xml.querySelector("metadata > name");
    const name = nameNode?.textContent?.trim() || this.routeName;

    return { coords, name };
  }

  /**
   * Build route distance metrics
   */
  buildRouteMetrics() {
    this.routeDistances = [0];
    this.segmentLengths = [];
    let total = 0;

    for (let i = 1; i < this.routeCoords.length; i++) {
      const dist = distanceMeters(this.routeCoords[i - 1], this.routeCoords[i]);
      this.segmentLengths.push(dist);
      total += dist;
      this.routeDistances.push(total);
    }

    this.totalDistance = total;
  }

  /**
   * Build maneuver list from route
   */
  buildManeuvers() {
    const maneuvers = [];
    const { minTurnDistance } = DISTANCE_THRESHOLDS;
    const minAngle = DISTANCE_THRESHOLDS.minTurnAngle;
    let lastDistance = 0;

    for (let i = 1; i < this.routeCoords.length - 1; i++) {
      const inbound = bearing(this.routeCoords[i - 1], this.routeCoords[i]);
      const outbound = bearing(this.routeCoords[i], this.routeCoords[i + 1]);
      const delta = angleDelta(inbound, outbound);
      const absDelta = Math.abs(delta);
      const along = this.routeDistances[i];

      if (absDelta < minAngle) {
        continue;
      }
      if (along - lastDistance < minTurnDistance) {
        continue;
      }
      if (this.segmentLengths[i - 1] < 8 || this.segmentLengths[i] < 8) {
        continue;
      }

      maneuvers.push({
        index: i,
        distanceAlong: along,
        delta,
        type: classifyTurn(delta),
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

  /**
   * Check user proximity to start for preview
   */
  async checkStartProximity() {
    if (!this.routeLoaded || this.routeCoords.length < 2) {
      return;
    }

    try {
      const position = await this.gps.getCurrentPosition();
      this.gps.lastPosition = position;

      const startInfo = this.state.findSmartStartPoint(position, this.routeCoords);

      if (startInfo.isAtStart) {
        this.ui.updateStartStatus("at-start", "You're on the route");
        this.ui.showBeginButton();
      } else {
        const directions = await TurnByTurnAPI.fetchDirectionsToPoint(
          [position.lon, position.lat],
          startInfo.point,
          this.map.getAccessToken()
        );

        if (directions) {
          const distText = formatDistance(directions.distance);
          const timeText = this.ui.formatDuration(directions.duration);
          this.ui.updateStartStatus("away", `${distText} away (${timeText} to route)`);
          this.navigateToStartRoute = directions.geometry;
        } else {
          const distText = formatDistance(startInfo.distanceFromUser);
          this.ui.updateStartStatus("away", `${distText} from route`);
        }
        this.ui.showNavigateToStartButton();
      }
    } catch {
      this.ui.updateStartStatus("unknown", "Location unavailable");
      this.ui.showBeginButton();
    }
  }

  /**
   * Start navigating to the route start point
   */
  async startNavigatingToStart() {
    if (!this.gps.lastPosition || !this.state.smartStartPoint) {
      this.beginNavigation();
      return;
    }

    this.needsStartSeed = true;
    this.gps.resetSmoothing();
    this.ui.setNavToStartLoading(true);

    try {
      if (!this.navigateToStartRoute) {
        const directions = await TurnByTurnAPI.fetchDirectionsToPoint(
          [this.gps.lastPosition.lon, this.gps.lastPosition.lat],
          this.state.smartStartPoint,
          this.map.getAccessToken()
        );
        if (directions) {
          this.navigateToStartRoute = directions.geometry;
        }
      }

      if (this.navigateToStartRoute) {
        this.map.setNavigateToStartRoute(this.navigateToStartRoute);
      }

      this.state.transitionTo(NAV_STATES.NAVIGATING_TO_START);
      this.isNavigating = true;
      this.startGeolocation();
    } finally {
      this.ui.setNavToStartLoading(false);
    }
  }

  /**
   * Begin navigation from start point
   */
  beginNavigation() {
    this.state.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
    this.startNavigation();
  }

  /**
   * Start navigation
   */
  startNavigation() {
    if (!this.routeLoaded) {
      this.ui.setNavStatus("Load a route first.", true);
      return;
    }

    this.needsStartSeed = true;
    this.gps.resetSmoothing();

    if (!TurnByTurnGPS.isAvailable()) {
      this.isNavigating = true;
      this.followMode = true;
      this.overviewMode = false;
      this.ui.updateControlStates(this.overviewMode, this.followMode);
      this.ui.hideSetupPanel();
      this.ui.setNavStatus("Device GPS unavailable. Waiting for live tracking.", true);
      return;
    }

    this.isNavigating = true;
    this.followMode = true;
    this.overviewMode = false;
    this.ui.updateControlStates(this.overviewMode, this.followMode);
    this.ui.hideSetupPanel();
    this.startGeolocation();
  }

  /**
   * End navigation
   */
  endNavigation() {
    this.isNavigating = false;
    this.gps.stopGeolocation();
    this.ui.showSetupPanel();
    this.ui.setNavStatus("Navigation ended.");
    this.state.transitionTo(NAV_STATES.SETUP);

    // Flush pending segment updates
    this.coverage.persistDrivenSegments();
  }

  /**
   * Start geolocation watching
   */
  startGeolocation() {
    this.ui.setNavStatus("Waiting for GPS...");
    this.gps.startGeolocation(
      (fix) => this.handlePosition(fix),
      (error) => this.handleGeolocationError(error)
    );
  }

  /**
   * Handle GPS position update
   */
  handlePosition(fix) {
    this.ui.updateSignal(fix.accuracy);
    this.updateNavigation(fix);
  }

  /**
   * Handle geolocation error
   */
  handleGeolocationError(error) {
    if (error.code === error.PERMISSION_DENIED) {
      this.ui.setNavStatus(
        "Location permission denied. Waiting for live tracking.",
        true
      );
      this.gps.stopGeolocation();
      return;
    }

    this.ui.setNavStatus("Unable to fetch location.", true);
    this.isNavigating = false;
    this.gps.stopGeolocation();
    this.ui.showSetupPanel();
  }

  /**
   * Handle live tracking event (fallback for when GPS isn't available)
   */
  handleLiveTrackingUpdate(event) {
    if (!this.isNavigating || this.gps.watchId) {
      return;
    }

    const coords = event.detail?.coords || event.detail?.trip?.coordinates || [];
    if (!coords.length) {
      return;
    }

    const lastCoord = coords[coords.length - 1];
    if (!Number.isFinite(lastCoord?.lat) || !Number.isFinite(lastCoord?.lon)) {
      return;
    }

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

  /**
   * Main navigation update loop
   */
  updateNavigation(fix) {
    if (!this.map.mapReady || !this.routeLoaded) {
      return;
    }

    const current = [fix.lon, fix.lat];
    this.map.updatePositionMarker(current);

    // Check segment coverage for gamification
    this.coverage.checkSegmentCoverage({ lon: fix.lon, lat: fix.lat });

    // Handle NAVIGATING_TO_START state
    if (this.state.getState() === NAV_STATES.NAVIGATING_TO_START) {
      const distToStart = distanceMeters(current, this.state.smartStartPoint);
      this.state.smartStartDistance = distToStart;

      const distEl = this.ui.getElement("distanceToTurn");
      if (distEl) {
        distEl.textContent = formatDistance(distToStart);
      }

      if (distToStart <= this.config.startThresholdMeters) {
        this.state.transitionTo(NAV_STATES.ARRIVED_AT_START);

        // Auto-transition after brief pause
        setTimeout(() => {
          if (this.state.getState() === NAV_STATES.ARRIVED_AT_START) {
            this.map.clearNavigateToStartRoute();
            this.state.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
          }
        }, 1500);
      }
      return;
    }

    const shouldSeedStart
      = this.needsStartSeed
      && this.state.getState() === NAV_STATES.ACTIVE_NAVIGATION;
    if (shouldSeedStart) {
      this.lastClosestIndex = 0;
    }

    const closest = this.findClosestPoint(current);
    if (!closest) {
      return;
    }

    if (shouldSeedStart) {
      this.gps.lastValidProgress = closest.along;
      this.gps.progressHistory = [closest.along];
      this.gps.lastProgressTime = Date.now();
      this.needsStartSeed = false;
    }

    // Apply progress smoothing
    const rawProgress = Math.min(closest.along, this.totalDistance);
    const smoothedProgress = this.gps.smoothProgress(rawProgress);
    const remainingDistance = Math.max(this.totalDistance - smoothedProgress, 0);
    const offRoute = closest.distance > this.config.offRouteThresholdMeters;

    // Handle state transitions
    this.state.handleNavigationStateTransitions(
      smoothedProgress,
      remainingDistance,
      offRoute,
      closest,
      () => this.offerResumeFromAhead()
    );

    // Update progress line
    const progressCoords = this.routeCoords.slice(0, closest.index + 1);
    if (closest.point) {
      progressCoords.push(closest.point);
    }
    this.map.updateProgressLine(progressCoords);

    // Update progress bars
    this.ui.updateRouteProgress(smoothedProgress, this.totalDistance, this.routeName);

    // Update coverage if we have segment data
    const coverageStats = this.coverage.getCoverageStats();
    if (coverageStats.totalLength > 0) {
      this.ui.updateCoverageProgress(
        this.coverageBaseline.percentage,
        coverageStats.percentage
      );
    } else {
      // Estimate coverage from route progress
      const baselinePercent = this.coverageBaseline.percentage || 0;
      const routeMiles = smoothedProgress / 1609.344;
      const totalAreaMiles = this.coverageBaseline.totalMi || 1;
      const uncoveredFraction = (100 - baselinePercent) / 100;
      const estimatedNewCoverage
        = (routeMiles / totalAreaMiles) * 100 * uncoveredFraction * 0.8;
      const liveCoveragePercent = Math.min(100, baselinePercent + estimatedNewCoverage);
      this.ui.updateCoverageProgress(baselinePercent, liveCoveragePercent);
    }

    // Update remaining distance
    this.ui.updateRemaining(remainingDistance);

    // Calculate heading and speed
    const heading = this.gps.resolveHeading(fix, closest, this.routeCoords);
    const speedMps = this.gps.resolveSpeed(fix);

    this.ui.updateEta(remainingDistance, speedMps);
    this.ui.updateSpeed(speedMps);

    // Update instruction
    const nextManeuver = this.getNextManeuver(smoothedProgress);
    if (nextManeuver) {
      const distanceTo = Math.max(nextManeuver.distanceAlong - smoothedProgress, 0);
      this.ui.updateInstruction(
        nextManeuver.type,
        distanceTo,
        this.routeName,
        offRoute,
        closest
      );
    }

    // Update marker heading
    this.map.updateMarkerHeading(heading);

    // Update camera
    if (this.followMode && !this.overviewMode) {
      const zoom = this.getDynamicZoom(speedMps);
      this.map.updateCamera(current, heading, zoom, {
        offset: [0, Math.min(180, Math.max(110, window.innerHeight * 0.18))],
      });
    }
  }

  /**
   * Get next maneuver after current progress
   */
  getNextManeuver(progressDistance) {
    return this.maneuvers.find((m) => m.distanceAlong > progressDistance + 5);
  }

  /**
   * Get dynamic zoom based on speed
   */
  getDynamicZoom(speedMps) {
    const speedMph = speedMps ? speedMps * 2.23694 : 0;
    let zoom = ZOOM_LEVELS.default;

    if (speedMph > ZOOM_THRESHOLDS.highway) {
      zoom = ZOOM_LEVELS.highway;
    } else if (speedMph > ZOOM_THRESHOLDS.arterial) {
      zoom = ZOOM_LEVELS.arterial;
    } else if (speedMph > ZOOM_THRESHOLDS.city) {
      zoom = ZOOM_LEVELS.city;
    }

    return zoom;
  }

  /**
   * Find closest point on route
   */
  findClosestPoint(current) {
    if (!this.routeCoords.length) {
      return null;
    }

    const totalSegments = this.routeCoords.length - 1;
    let startIndex = 0;
    let endIndex = totalSegments - 1;

    if (this.lastClosestIndex) {
      startIndex = Math.max(0, this.lastClosestIndex - 120);
      endIndex = Math.min(totalSegments - 1, this.lastClosestIndex + 240);
    }

    const searchRange = (from, to) => {
      let closest = null;

      for (let i = from; i <= to; i++) {
        const proj = projectToSegment(
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

    if (best) {
      this.lastClosestIndex = best.index;
    }
    return best;
  }

  /**
   * Offer resume from ahead when significantly off-route
   */
  async offerResumeFromAhead() {
    const current = this.gps.lastPosition
      ? [this.gps.lastPosition.lon, this.gps.lastPosition.lat]
      : null;

    if (!current) {
      this.state.transitionTo(NAV_STATES.OFF_ROUTE);
      return;
    }

    const aheadResult = this.state.findNearestPointAhead(
      current,
      this.routeCoords,
      this.lastClosestIndex
    );

    if (!aheadResult) {
      this.state.transitionTo(NAV_STATES.OFF_ROUTE);
      return;
    }

    const directions = await TurnByTurnAPI.fetchDirectionsToPoint(
      current,
      aheadResult.point,
      this.map.getAccessToken()
    );

    if (directions) {
      this.state.setResumeAheadData({
        index: aheadResult.index,
        point: aheadResult.point,
        distance: directions.distance,
        duration: directions.duration,
        geometry: directions.geometry,
      });

      const distText = formatDistance(directions.distance);
      const timeText = this.ui.formatDuration(directions.duration);
      this.ui.updateResumeDistance(`${distText} (${timeText})`);

      this.state.transitionTo(NAV_STATES.RESUME_AHEAD);
    } else {
      this.state.transitionTo(NAV_STATES.OFF_ROUTE);
    }
  }

  /**
   * Resume navigation from ahead point
   */
  resumeFromAhead() {
    const resumeData = this.state.getResumeAheadData();
    if (!resumeData) {
      return;
    }

    this.lastClosestIndex = resumeData.index;
    this.gps.lastValidProgress = this.routeDistances[resumeData.index];
    this.gps.progressHistory = [this.gps.lastValidProgress];

    this.state.clearResumeAheadData();
    this.state.transitionTo(NAV_STATES.ACTIVE_NAVIGATION);
  }

  /**
   * Dismiss resume prompt
   */
  dismissResumePrompt() {
    this.state.clearResumeAheadData();
    this.state.transitionTo(NAV_STATES.OFF_ROUTE);
  }

  /**
   * Toggle overview mode
   */
  toggleOverview() {
    if (!this.map.mapReady || !this.routeLoaded) {
      return;
    }

    this.overviewMode = !this.overviewMode;

    if (this.overviewMode) {
      this.followMode = false;
      this.map.fitBounds(this.routeCoords, { padding: 80 });
    } else if (this.gps.lastPosition) {
      this.followMode = true;
      this.map.updateCamera(
        [this.gps.lastPosition.lon, this.gps.lastPosition.lat],
        this.gps.lastHeading,
        ZOOM_LEVELS.default
      );
    }

    this.ui.updateControlStates(this.overviewMode, this.followMode);
  }

  /**
   * Recenter on user position
   */
  recenter() {
    if (!this.gps.lastPosition) {
      return;
    }

    this.followMode = true;
    this.overviewMode = false;
    this.ui.updateControlStates(this.overviewMode, this.followMode);
    this.map.updateCamera(
      [this.gps.lastPosition.lon, this.gps.lastPosition.lat],
      this.gps.lastHeading,
      ZOOM_LEVELS.default
    );
  }

  /**
   * Reset route state
   */
  resetRouteState() {
    this.routeCoords = [];
    this.routeDistances = [];
    this.segmentLengths = [];
    this.totalDistance = 0;
    this.maneuvers = [];
    this.routeLoaded = false;
    this.lastClosestIndex = 0;

    this.gps.reset();
    this.state.reset();
    this.coverage.reset();

    this.isNavigating = false;
    this.navigateToStartRoute = null;
    this.needsStartSeed = false;

    this.map.clearRouteLayers();
    this.map.clearNavigateToStartRoute();

    this.ui.resetGuidanceUI();
    this.ui.setNavStatus("Waiting for route");
    this.state.transitionTo(NAV_STATES.SETUP);
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.gps.reset();
    this.coverage.destroy();
    this.map.destroy();
  }
}

export default TurnByTurnNavigator;
