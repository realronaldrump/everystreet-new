/* global mapboxgl */

import apiClient from "../../core/api-client.js";
import layerManager from "../../layer-manager.js";
import mapCore from "../../map-core.js";
import { getDeviceProfile, getStorage, setStorage } from "../../utils.js";
import {
  COVERAGE_LAYER_IDS,
  LIVE_TRACKING_DEFAULTS,
  LIVE_TRACKING_LAYER_IDS,
} from "./state.js";
import { createLineFeature, createMarkerFeature } from "./ui.js";
import { connectLiveWebSocket } from "./websocket.js";

/**
 * LiveTripTracker - Real-time trip visualization
 *
 * Renders a thin gradient line with a clean marker dot on the map.
 * Uses 2 sources (line with lineMetrics for gradient, marker point)
 * and 3 layers (line, marker circle, direction arrow).
 */

class LiveTripTracker {
  static instance = null;

  constructor(map) {
    if (LiveTripTracker.instance) {
      LiveTripTracker.instance.destroy();
    }
    LiveTripTracker.instance = this;

    if (!map) {
      console.error("LiveTripTracker: Map is required");
      return;
    }

    this.map = map;
    this._initializeState();
    this._cacheDomElements();
    this.initializeMapLayers();
    this.bindHudControls();
    this.bindMapInteractionHandlers();
    this.setLiveTripActive(false);
    this.initialize();
    this.startFreshnessMonitor();
  }

  // --- Setup ------------------------------------------------------------
  _initializeState() {
    this.activeTrip = null;
    this.ws = null;
    this.pollingTimer = null;
    this.pollingInterval = LIVE_TRACKING_DEFAULTS.pollingInterval;

    this.lineSourceId = LIVE_TRACKING_LAYER_IDS.lineSource;
    this.markerSourceId = LIVE_TRACKING_LAYER_IDS.markerSource;
    this.lineLayerId = LIVE_TRACKING_LAYER_IDS.line;
    this.pulseLayerId = LIVE_TRACKING_LAYER_IDS.pulse;
    this.markerLayerId = LIVE_TRACKING_LAYER_IDS.marker;
    this.arrowLayerId = LIVE_TRACKING_LAYER_IDS.arrow;
    this.arrowImageId = LIVE_TRACKING_LAYER_IDS.arrowImage;

    // Animation state
    this._pulseAnimationId = null;

    // Position interpolation state
    this._interp = {
      active: false,
      fromCoord: null,
      toCoord: null,
      fromBearing: null,
      toBearing: null,
      startTime: 0,
      duration: 3000,
      frameId: null,
      currentSpeed: 0,
    };

    this.coverageLayerIds = [...COVERAGE_LAYER_IDS];

    this.followStorageKey = LIVE_TRACKING_DEFAULTS.followStorageKey;
    this.followPreference = this.loadFollowPreference();
    this.followMode = false;
    this.lastBearing = null;
    this.lastCoord = null;
    this.hasActiveTrip = false;
    this.mapInteractionHandlers = [];
    this.lastUpdateTimestamp = null;
    this.freshnessTimer = null;
    this._styleChangeHandlerRef = null;
    this.primaryRgb = [59, 138, 127];
    this.primaryColor = LiveTripTracker.formatRgb(this.primaryRgb);
    this.refreshPrimaryColor();
  }

  _cacheDomElements() {
    this.statusIndicator = document.querySelector(".live-status-dot");
    this.statusText = document.querySelector(".live-status-text");
    this.liveBadge = document.getElementById("live-status-badge");
    this.hudElem = document.getElementById("live-trip-hud");
    this.hudSpeedElem = document.getElementById("live-trip-speed");
    this.hudStreetElem = document.getElementById("live-trip-street");
    this.followToggle = document.getElementById("live-trip-follow-toggle");

    // Control panel compact metrics
    this.metricSpeedElem = document.getElementById("live-metric-speed");
    this.metricDistanceElem = document.getElementById("live-metric-distance");
    this.metricDurationElem = document.getElementById("live-metric-duration");
  }

  // --- Map layers -------------------------------------------------------
  initializeMapLayers() {
    if (!this.map || !this.map.addSource) {
      console.warn("Map not ready for layers");
      return;
    }

    if (!this.map.isStyleLoaded()) {
      console.warn("Map style not loaded, deferring layer init");
      this.map.once("style.load", () => this.initializeMapLayers());
      return;
    }

    try {
      this.refreshPrimaryColor();
      this._ensureLineLayers();
      this._ensureMarkerLayers();
      this._ensurePulseLayer();
      this._ensureArrowLayer();
    } catch (error) {
      console.error("Error initializing map layers:", error);
    }
  }

  _ensureLineLayers() {
    if (!this.map.getSource(this.lineSourceId)) {
      this.map.addSource(this.lineSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        lineMetrics: true,
      });
    }

    if (!this.map.getLayer(this.lineLayerId)) {
      const color = this.primaryRgb;
      // Insert line below map labels so it feels integrated
      const beforeId = layerManager.getFirstSymbolLayerId();
      this.map.addLayer({
        id: this.lineLayerId,
        type: "line",
        source: this.lineSourceId,
        paint: {
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 3, 18, 5],
          "line-blur": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 16, 0.15, 18, 0],
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0,
            LiveTripTracker.formatRgba(color, 0.06),
            0.3,
            LiveTripTracker.formatRgba(color, 0.2),
            0.6,
            LiveTripTracker.formatRgba(color, 0.5),
            0.85,
            LiveTripTracker.formatRgba(color, 0.78),
            1,
            LiveTripTracker.formatRgba(color, 0.95),
          ],
        },
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
      }, beforeId);
    }
  }

  _ensurePulseLayer() {
    // Pulse ring: animated circle behind the main marker for a living, breathing feel
    if (!this.map.getLayer(this.pulseLayerId) && this.map.getSource(this.markerSourceId)) {
      this.map.addLayer({
        id: this.pulseLayerId,
        type: "circle",
        source: this.markerSourceId,
        paint: {
          "circle-radius": 14,
          "circle-color": this.primaryColor,
          "circle-opacity": 0.2,
          "circle-blur": 0.6,
        },
      });
    }
  }

  _ensureMarkerLayers() {
    if (!this.map.getSource(this.markerSourceId)) {
      this.map.addSource(this.markerSourceId, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }

    if (!this.map.getLayer(this.markerLayerId)) {
      this.map.addLayer({
        id: this.markerLayerId,
        type: "circle",
        source: this.markerSourceId,
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["get", "speed"],
            0, 7,
            30, 8,
            60, 9,
          ],
          "circle-color": this.primaryColor,
          "circle-stroke-width": 2.5,
          "circle-stroke-color": LiveTripTracker.formatRgba(this.primaryRgb, 0.35),
          "circle-blur": 0.25,
        },
      });
    }
  }

  _ensureArrowLayer() {
    if (!this.map) {
      return;
    }

    const addLayer = () => {
      if (this.map.getLayer(this.arrowLayerId)) {
        return;
      }
      this.map.addLayer({
        id: this.arrowLayerId,
        type: "symbol",
        source: this.markerSourceId,
        layout: {
          "icon-image": this.arrowImageId,
          "icon-size": 0.4,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map",
        },
        paint: {
          "icon-color": this.primaryColor,
        },
      });
    };

    if (this.map.hasImage(this.arrowImageId)) {
      addLayer();
      return;
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <path d="M24 6L38 38L24 30L10 38Z" fill="black" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    `;

    const img = new Image();
    img.onload = () => {
      try {
        if (!this.map.hasImage(this.arrowImageId)) {
          this.map.addImage(this.arrowImageId, img, { sdf: true });
        }
        addLayer();
      } catch (error) {
        console.warn("Failed to add arrow image:", error);
      }
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  refreshPrimaryColor() {
    const fallbackRgb = [59, 138, 127];
    const primaryRgbVar = LiveTripTracker.getCssVar("--primary-rgb", "").trim();
    const primaryVar = LiveTripTracker.getCssVar("--primary", "#3b8a7f");
    const resolvedRgb =
      (primaryRgbVar && LiveTripTracker.resolveRgbChannels(`rgb(${primaryRgbVar})`)) ||
      LiveTripTracker.resolveRgbChannels(primaryVar) ||
      fallbackRgb;

    this.primaryRgb = resolvedRgb;
    this.primaryColor = LiveTripTracker.formatRgb(resolvedRgb);
  }

  loadFollowPreference() {
    try {
      const stored = getStorage(this.followStorageKey);
      if (stored === true || stored === false) {
        return stored;
      }
      if (stored === "true") {
        return true;
      }
      if (stored === "false") {
        return false;
      }
    } catch {
      // Ignore storage errors
    }

    try {
      const autoCenter = localStorage.getItem("autoCenter");
      if (autoCenter === "false") {
        return false;
      }
    } catch {
      // Ignore storage errors
    }

    return true;
  }

  // --- HUD & follow -----------------------------------------------------
  bindHudControls() {
    if (!this.followToggle) {
      return;
    }

    this.followToggleHandler = () => {
      if (!this.hasActiveTrip) {
        return;
      }
      const next = !this.followMode;
      this.setFollowMode(next, { persist: true, resetCamera: !next });
      if (next && this.lastCoord) {
        this.followVehicle(this.lastCoord, this.lastBearing, { immediate: true });
      }
    };

    this.followToggle.addEventListener("click", this.followToggleHandler);
  }

  bindMapInteractionHandlers() {
    if (!this.map) {
      return;
    }

    const disableFollow = (event) => {
      if (!this.followMode || !this.hasActiveTrip) {
        return;
      }
      if (!event?.originalEvent) {
        return;
      }
      this.setFollowMode(false, { persist: true, resetCamera: false });
    };

    ["dragstart", "zoomstart", "rotatestart", "pitchstart"].forEach((evt) => {
      this.map.on(evt, disableFollow);
      this.mapInteractionHandlers.push({ evt, handler: disableFollow });
    });
  }

  setLiveTripActive(isActive) {
    this.hasActiveTrip = isActive;

    if (this.hudElem) {
      this.hudElem.classList.toggle("is-active", isActive);
      this.hudElem.setAttribute("aria-hidden", isActive ? "false" : "true");
    }

    if (this.liveBadge) {
      this.liveBadge.classList.toggle("d-none", !isActive);
    }

    if (!isActive) {
      this._stopPulseAnimation();
      const wasFollowing = this.followMode;
      this.followMode = false;
      this.updateFollowToggle(false, { disabled: true });
      this.clearHudValues();
      if (wasFollowing) {
        this.resetFollowCamera();
      }
      return;
    }

    this._startPulseAnimation();
    this.updateFollowToggle(this.followMode, { disabled: false });
  }

  // --- Unified animation loop (pulse + interpolation) ---------------------
  _startPulseAnimation() {
    if (this._pulseAnimationId) {
      return;
    }

    const animate = (timestamp) => {
      if (!this.hasActiveTrip || !this.map) {
        this._pulseAnimationId = null;
        return;
      }

      // Pulse ring animation
      const period = 2000;
      const pt = (timestamp % period) / period;
      const sineWave = Math.sin(pt * Math.PI * 2);
      const radius = 14 + 4 * sineWave;
      const opacity = 0.22 - 0.1 * sineWave;

      if (this.map.getLayer(this.pulseLayerId)) {
        this.map.setPaintProperty(this.pulseLayerId, "circle-radius", radius);
        this.map.setPaintProperty(this.pulseLayerId, "circle-opacity", opacity);
      }

      // Position interpolation
      if (this._interp.active) {
        const pos = this._getCurrentInterpolatedPosition();
        if (pos) {
          const markerSource = this.map.getSource(this.markerSourceId);
          if (markerSource) {
            const feature = createMarkerFeature(
              [{ lon: pos.lon, lat: pos.lat }],
              pos.bearing,
              this._interp.currentSpeed
            );
            markerSource.setData({
              type: "FeatureCollection",
              features: feature ? [feature] : [],
            });
          }

          // Update camera follow with interpolated position
          if (this.followMode) {
            this.followVehicle({ lon: pos.lon, lat: pos.lat }, pos.bearing);
          }

          // Mark complete when done
          if (pos.t >= 1) {
            this._interp.active = false;
          }
        }
      }

      this._pulseAnimationId = requestAnimationFrame(animate);
    };

    this._pulseAnimationId = requestAnimationFrame(animate);
  }

  _stopPulseAnimation() {
    if (this._pulseAnimationId) {
      cancelAnimationFrame(this._pulseAnimationId);
      this._pulseAnimationId = null;
    }
  }

  // --- Position interpolation ---------------------------------------------
  _startInterpolation(fromCoord, toCoord, fromBearing, toBearing, speed) {
    this._stopInterpolation();

    this._interp.active = true;
    this._interp.fromCoord = fromCoord;
    this._interp.toCoord = toCoord;
    this._interp.fromBearing = fromBearing ?? toBearing;
    this._interp.toBearing = toBearing;
    this._interp.startTime = performance.now();
    this._interp.currentSpeed = speed;

    // Don't start a separate rAF — the unified animation loop handles it
  }

  _stopInterpolation() {
    this._interp.active = false;
    this._interp.fromCoord = null;
    this._interp.toCoord = null;
  }

  _getCurrentInterpolatedPosition() {
    if (!this._interp.active || !this._interp.fromCoord || !this._interp.toCoord) {
      return null;
    }

    const elapsed = performance.now() - this._interp.startTime;
    const t = Math.min(1, elapsed / this._interp.duration);
    const eased = 1 - (1 - t) ** 3; // ease-out cubic

    return {
      lon: this._interp.fromCoord.lon + (this._interp.toCoord.lon - this._interp.fromCoord.lon) * eased,
      lat: this._interp.fromCoord.lat + (this._interp.toCoord.lat - this._interp.fromCoord.lat) * eased,
      bearing: LiveTripTracker._lerpBearing(this._interp.fromBearing, this._interp.toBearing, eased),
      t,
    };
  }

  static _lerpBearing(from, to, t) {
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return to ?? from ?? 0;
    }
    const delta = ((to - from + 540) % 360) - 180;
    return LiveTripTracker.normalizeBearing(from + delta * t);
  }

  updateFollowToggle(isActive, { disabled = false } = {}) {
    if (!this.followToggle) {
      return;
    }
    this.followToggle.classList.toggle("is-active", isActive);
    this.followToggle.setAttribute("aria-pressed", isActive ? "true" : "false");
    this.followToggle.disabled = disabled;
  }

  setFollowMode(enabled, { persist = true, resetCamera = false, force = false } = {}) {
    if (!force && this.followMode === enabled) {
      this.updateFollowToggle(enabled);
      return;
    }

    this.followMode = enabled;

    if (persist) {
      this.followPreference = enabled;
      setStorage(this.followStorageKey, enabled);
    }

    this.updateFollowToggle(enabled);

    if (!enabled && resetCamera) {
      this.resetFollowCamera();
    }
  }

  getFollowCameraConfig() {
    const { isMobile } = getDeviceProfile();
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const containerHeight = this.map?.getContainer()?.clientHeight || 600;
    const offsetY = Math.round(Math.min(180, Math.max(90, containerHeight * 0.22)));

    return {
      zoom: isMobile ? 16.8 : 15.8,
      pitch: isMobile ? 58 : 52,
      offset: [0, offsetY],
      duration: prefersReducedMotion ? 0 : 850,
    };
  }

  resetFollowCamera() {
    if (!this.map) {
      return;
    }
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    this.map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: prefersReducedMotion ? 0 : 700,
      essential: true,
    });
  }

  clearHudValues() {
    if (this.hudSpeedElem) {
      this.hudSpeedElem.textContent = "--";
    }
    if (this.hudStreetElem) {
      this.hudStreetElem.textContent = "--";
      this.hudStreetElem.title = "";
    }
    this.clearCompactMetrics();
  }

  clearCompactMetrics() {
    if (this.metricSpeedElem) {
      this.metricSpeedElem.textContent = "--";
    }
    if (this.metricDistanceElem) {
      this.metricDistanceElem.textContent = "--";
    }
    if (this.metricDurationElem) {
      this.metricDurationElem.textContent = "--";
    }
  }

  updateHud(trip, coords) {
    if (!trip) {
      return;
    }

    // Speed
    const speedValue =
      typeof trip.currentSpeed === "number"
        ? Math.max(0, Math.round(trip.currentSpeed))
        : 0;
    if (this.hudSpeedElem) {
      this.hudSpeedElem.textContent = `${speedValue}`;
    }

    // Street name from coverage layers
    const lastCoord = coords?.[coords.length - 1];
    const coverageInfo = lastCoord ? this.getCoverageStreetInfo(lastCoord) : null;

    if (coverageInfo?.streetName && this.hudStreetElem) {
      this.hudStreetElem.textContent = coverageInfo.streetName;
      this.hudStreetElem.title = coverageInfo.streetName;
    } else if (this.hudStreetElem) {
      this.hudStreetElem.textContent = "--";
      this.hudStreetElem.title = "";
    }

    // Compact metrics in control panel
    this.updateCompactMetrics(trip);

    // Freshness
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    if (lastUpdate) {
      this.lastUpdateTimestamp = lastUpdate.getTime();
      this.updateFreshnessState();
    }
  }

  updateCompactMetrics(trip) {
    if (this.metricSpeedElem) {
      const speed =
        typeof trip.currentSpeed === "number" ? Math.round(trip.currentSpeed) : 0;
      this.metricSpeedElem.textContent = speed;
    }
    if (this.metricDistanceElem) {
      this.metricDistanceElem.textContent = (trip.distance || 0).toFixed(1);
    }
    if (this.metricDurationElem) {
      const startTime = trip.startTime ? new Date(trip.startTime) : null;
      const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
      if (startTime && lastUpdate) {
        const diffMs = lastUpdate - startTime;
        const mins = Math.floor(diffMs / 60000);
        this.metricDurationElem.textContent = mins;
      } else {
        this.metricDurationElem.textContent = "0";
      }
    }
  }

  getCoverageStreetInfo(coord) {
    if (!this.map || !coord) {
      return null;
    }

    const visibleLayers = this.coverageLayerIds.filter((layerId) => {
      if (!this.map.getLayer(layerId)) {
        return false;
      }
      const visibility = this.map.getLayoutProperty(layerId, "visibility");
      return visibility !== "none";
    });

    if (visibleLayers.length === 0) {
      return null;
    }

    const point = this.map.project([coord.lon, coord.lat]);
    const radius = 8;
    const bbox = [
      [point.x - radius, point.y - radius],
      [point.x + radius, point.y + radius],
    ];
    const features = this.map.queryRenderedFeatures(bbox, { layers: visibleLayers });

    if (!features.length) {
      return null;
    }

    const preferred = visibleLayers
      .map((layerId) => features.find((feature) => feature.layer?.id === layerId))
      .find(Boolean);
    const feature = preferred || features[0];
    const props = feature?.properties || {};
    const streetName = props.street_name || props.name || null;

    if (!streetName) {
      return null;
    }

    return { streetName };
  }

  // --- Live updates -----------------------------------------------------
  async initialize() {
    try {
      await this.loadInitialTrip();
      this.connectWebSocket();
      this.setupMapStyleListener();
    } catch (error) {
      console.error("Initialization error:", error);
      this.updateStatus(false, "Failed to initialize");
      this.startPolling();
    }
  }

  setupMapStyleListener() {
    if (this._styleChangeHandlerRef) {
      return;
    }

    // Priority 2 = runs after general layer restoration (priority 1)
    this._styleChangeHandlerRef = mapCore.registerStyleChangeHandler(2, async () => {
      try {
        this.initializeMapLayers();

        if (this.activeTrip) {
          this.updateTrip(this.activeTrip, { allowDuringStyleChange: true });
        } else {
          this.clearTrip();
        }
      } catch (error) {
        console.warn("Failed to restore live trip layers after style load:", error);
      }
    });
  }

  async loadInitialTrip() {
    try {
      const data = await apiClient.get("/api/active_trip");

      if (data.status === "success" && data.has_active_trip && data.trip) {
        console.info(`Initial trip loaded: ${data.trip.transactionId}`);
        this.updateTrip(data.trip);
      } else {
        this.clearTrip();
      }
    } catch (error) {
      console.error("Failed to load initial trip:", error);
      throw error;
    }
  }

  connectWebSocket() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      this.ws = connectLiveWebSocket({
        onOpen: () => {
          this.stopPolling();
          this.updateStatus(true);
        },
        onMessage: (data) => this.handleSocketMessage(data),
        onClose: (event) => {
          console.warn("WebSocket closed, switching to polling", event);
          this.ws = null;
          this.updateStatus(false, "Reconnecting...");
          this.startPolling();
        },
        onError: (error) => {
          console.error("WebSocket error:", error);
          this.updateStatus(false, "Connection error");
        },
      });

      if (!this.ws) {
        console.warn("WebSocket not supported, using polling");
        this.startPolling();
      }
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      this.startPolling();
    }
  }

  handleSocketMessage(data) {
    if (data.type === "trip_state" && data.trip) {
      this.updateTrip(data.trip);
    }
  }

  startPolling() {
    if (this.pollingTimer) {
      return;
    }
    console.info("Starting polling fallback");
    this.poll();
  }

  stopPolling() {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
      console.info("Polling stopped");
    }
  }

  async poll() {
    try {
      const data = await apiClient.get("/api/trip_updates");

      if (data.status === "success") {
        if (data.has_update && data.trip) {
          this.updateTrip(data.trip);
        } else if (!data.has_update && !this.activeTrip) {
          this.clearTrip();
        }
        this.updateStatus(true);
      }
    } catch (error) {
      console.error("Polling error:", error);
      this.updateStatus(false, "Connection lost");
    } finally {
      this.pollingTimer = setTimeout(() => this.poll(), this.pollingInterval);
    }
  }

  // --- Trip rendering ---------------------------------------------------
  updateTrip(trip, { allowDuringStyleChange = false } = {}) {
    if (!trip) {
      return;
    }

    // Don't update sources while style change is restoring layers
    if (mapCore.isStyleChangeInProgress() && !allowDuringStyleChange) {
      this.activeTrip = trip;
      return;
    }

    if (trip.status === "completed") {
      console.info(`Trip ${trip.transactionId} completed`);
      this.clearTrip();
      return;
    }

    const isNewTrip =
      !this.activeTrip || this.activeTrip.transactionId !== trip.transactionId;

    this.activeTrip = trip;

    const coords = LiveTripTracker.extractCoordinates(trip);
    if (!coords || coords.length === 0) {
      console.warn("No coordinates in trip update");
      return;
    }

    const rawHeading = LiveTripTracker.calculateHeading(coords);
    const heading =
      typeof rawHeading === "number"
        ? LiveTripTracker.smoothBearing(this.lastBearing, rawHeading, 0.28)
        : this.lastBearing;
    if (typeof heading === "number") {
      this.lastBearing = heading;
    }

    // Update line source immediately (line grows in real-time)
    const lineFeature = createLineFeature(coords);
    const lineSource = this.map.getSource(this.lineSourceId);
    if (lineSource) {
      lineSource.setData({
        type: "FeatureCollection",
        features: lineFeature ? [lineFeature] : [],
      });
    }

    const currentSpeed = trip.currentSpeed || 0;
    const newCoord = coords[coords.length - 1];

    // Marker: interpolate smoothly between positions
    if (isNewTrip || !this.lastCoord) {
      // First update or new trip — set marker immediately, no interpolation
      this._stopInterpolation();
      const markerFeature = createMarkerFeature(coords, heading, currentSpeed);
      const markerSource = this.map.getSource(this.markerSourceId);
      if (markerSource) {
        markerSource.setData({
          type: "FeatureCollection",
          features: markerFeature ? [markerFeature] : [],
        });
      }
    } else {
      // Continuing trip — interpolate from current position to new position
      const interpPos = this._getCurrentInterpolatedPosition();
      const fromCoord = interpPos
        ? { lon: interpPos.lon, lat: interpPos.lat }
        : this.lastCoord;
      const fromBearing = interpPos
        ? interpPos.bearing
        : this.lastBearing;

      this._startInterpolation(fromCoord, newCoord, fromBearing, heading, currentSpeed);
    }

    // Update HUD and metrics
    this.updateHud(trip, coords);

    // Camera
    if (isNewTrip) {
      this.setLiveTripActive(true);
      this.setFollowMode(this.followPreference, { persist: false, resetCamera: false });
      if (this.followMode) {
        this.followVehicle(newCoord, heading, { immediate: true });
      } else {
        this.fitTripBounds(coords);
      }
    } else if (this.followMode && !this._interp.active) {
      // If interpolation is active, the animation loop handles camera follow
      this.followVehicle(newCoord, heading);
    }

    this.lastCoord = newCoord;
    this.updateStatus(true, "Live tracking");

    document.dispatchEvent(
      new CustomEvent("liveTrackingUpdated", {
        detail: { trip, coords },
      })
    );
  }

  static extractCoordinates(trip) {
    let coords = [];

    if (Array.isArray(trip.coordinates) && trip.coordinates.length > 0) {
      coords = trip.coordinates
        .map((c) => LiveTripTracker.normalizeCoordinate(c))
        .filter(Boolean);
    }

    if (coords.length === 0 && trip.gps) {
      const { gps } = trip;
      if (gps.type === "Point" && Array.isArray(gps.coordinates)) {
        const point = LiveTripTracker.normalizeCoordinate(gps.coordinates);
        coords = point ? [point] : [];
      } else if (gps.type === "LineString" && Array.isArray(gps.coordinates)) {
        coords = gps.coordinates
          .map((c) => LiveTripTracker.normalizeCoordinate(c))
          .filter(Boolean);
      } else {
        const point = LiveTripTracker.normalizeCoordinate(gps);
        coords = point ? [point] : [];
      }
    }

    if (coords.length === 0) {
      const fallbackPoint = [
        trip.currentLocation,
        trip.current_position,
        trip.location,
        trip.lastKnownLocation,
      ]
        .map((candidate) => LiveTripTracker.normalizeCoordinate(candidate))
        .find(Boolean);

      if (fallbackPoint) {
        coords = [fallbackPoint];
      }
    }

    return coords;
  }

  static parseCoordinateNumber(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const parsed =
      typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  static isValidCoordinate(lon, lat) {
    return (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90
    );
  }

  static normalizeCoordinate(value) {
    if (!value) {
      return null;
    }

    if (Array.isArray(value) && value.length >= 2) {
      const lon = LiveTripTracker.parseCoordinateNumber(value[0]);
      const lat = LiveTripTracker.parseCoordinateNumber(value[1]);
      if (LiveTripTracker.isValidCoordinate(lon, lat)) {
        return { lon, lat };
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    const lon = LiveTripTracker.parseCoordinateNumber(
      value.lon ?? value.lng ?? value.longitude
    );
    const lat = LiveTripTracker.parseCoordinateNumber(value.lat ?? value.latitude);
    if (LiveTripTracker.isValidCoordinate(lon, lat)) {
      return { lon, lat, timestamp: value.timestamp };
    }

    if (Array.isArray(value.coordinates)) {
      const coordFromArray = LiveTripTracker.normalizeCoordinate(value.coordinates);
      if (coordFromArray) {
        return { ...coordFromArray, timestamp: value.timestamp };
      }
    }

    if (value.gps && typeof value.gps === "object") {
      const coordFromGps = LiveTripTracker.normalizeCoordinate(value.gps);
      if (coordFromGps) {
        return {
          ...coordFromGps,
          timestamp: value.timestamp ?? value.gps.timestamp,
        };
      }
    }

    return null;
  }

  static calculateHeading(coords) {
    if (!Array.isArray(coords) || coords.length < 2) {
      return null;
    }
    const prev = coords[coords.length - 2];
    const curr = coords[coords.length - 1];
    if (!prev || !curr) {
      return null;
    }

    const toRad = (value) => (value * Math.PI) / 180;
    const toDeg = (value) => (value * 180) / Math.PI;

    const lat1 = toRad(prev.lat);
    const lat2 = toRad(curr.lat);
    const dLon = toRad(curr.lon - prev.lon);

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const bearing = toDeg(Math.atan2(y, x));

    return LiveTripTracker.normalizeBearing(bearing);
  }

  static normalizeBearing(bearing) {
    if (!Number.isFinite(bearing)) {
      return 0;
    }
    return (bearing + 360) % 360;
  }

  static smoothBearing(previous, next, weight = 0.25) {
    if (!Number.isFinite(next)) {
      return previous;
    }
    if (!Number.isFinite(previous)) {
      return LiveTripTracker.normalizeBearing(next);
    }
    const delta = ((next - previous + 540) % 360) - 180;
    return LiveTripTracker.normalizeBearing(previous + delta * weight);
  }

  static getCssVar(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return value || fallback;
    } catch {
      return fallback;
    }
  }

  static resolveRgbChannels(colorValue) {
    const resolved = LiveTripTracker.resolveCssColor(colorValue);
    if (!resolved) {
      return null;
    }

    const match = resolved.match(/^rgba?\((.+)\)$/i);
    if (!match) {
      return null;
    }

    const channels = (match[1].match(/[\d.]+%?/g) || [])
      .slice(0, 3)
      .map((value) => {
        if (value.endsWith("%")) {
          return (Number.parseFloat(value) / 100) * 255;
        }
        return Number.parseFloat(value);
      })
      .map((value) => Math.max(0, Math.min(255, Math.round(value))));

    if (channels.length !== 3 || channels.some((value) => !Number.isFinite(value))) {
      return null;
    }

    return channels;
  }

  static resolveCssColor(colorValue) {
    if (
      typeof document === "undefined" ||
      typeof colorValue !== "string" ||
      !colorValue.trim()
    ) {
      return null;
    }

    const probe = document.createElement("span");
    probe.style.color = colorValue.trim();
    if (!probe.style.color) {
      return null;
    }

    const parent = document.body || document.documentElement;
    if (!parent) {
      return null;
    }

    parent.appendChild(probe);
    try {
      const resolved = getComputedStyle(probe).color;
      return typeof resolved === "string" && resolved.trim() ? resolved.trim() : null;
    } finally {
      probe.remove();
    }
  }

  static formatRgb(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  static formatRgba(rgb, alpha) {
    const normalizedAlpha = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${normalizedAlpha})`;
  }

  fitTripBounds(coords) {
    if (!coords || coords.length === 0) {
      return;
    }

    const mapboxCoords = coords.map((c) => [c.lon, c.lat]);

    if (mapboxCoords.length === 1) {
      this.map.flyTo({ center: mapboxCoords[0], zoom: 15 });
    } else {
      try {
        const bounds = new mapboxgl.LngLatBounds();
        mapboxCoords.forEach((coord) => {
          bounds.extend(coord);
        });
        this.map.fitBounds(bounds, { padding: 50 });
      } catch (error) {
        console.error("Error fitting bounds:", error);
        this.map.flyTo({ center: mapboxCoords[0], zoom: 15 });
      }
    }
  }

  followVehicle(lastCoord, heading, { immediate = false } = {}) {
    if (!lastCoord || !this.map) {
      return;
    }

    const { zoom, pitch, offset, duration } = this.getFollowCameraConfig();
    const bearing = typeof heading === "number" ? heading : this.map.getBearing() || 0;
    const center = [lastCoord.lon, lastCoord.lat];

    const cameraOptions = {
      center,
      zoom,
      pitch,
      bearing,
      offset,
      duration,
      essential: true,
    };

    if (immediate) {
      this.map.jumpTo(cameraOptions);
    } else {
      this.map.easeTo(cameraOptions);
    }
  }

  clearTrip() {
    this._stopInterpolation();
    this.activeTrip = null;
    this.lastCoord = null;
    this.lastBearing = null;
    this.lastUpdateTimestamp = null;
    this.updateFreshnessState();

    const lineSource = this.map.getSource(this.lineSourceId);
    if (lineSource) {
      lineSource.setData({ type: "FeatureCollection", features: [] });
    }
    const markerSource = this.map.getSource(this.markerSourceId);
    if (markerSource) {
      markerSource.setData({ type: "FeatureCollection", features: [] });
    }

    this.setLiveTripActive(false);
    this.updateStatus(true, "Idle");
  }

  updateStatus(connected, message) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("connected", connected);
      this.statusIndicator.classList.toggle("disconnected", !connected);
      const isConnecting =
        typeof message === "string" && /reconnect|connect|sync/i.test(message);
      this.statusIndicator.classList.toggle("connecting", !connected && isConnecting);
    }

    if (this.statusText) {
      const statusMsg = message || (connected ? "Connected" : "Disconnected");
      this.statusText.textContent = statusMsg;
    }

    if (this.liveBadge) {
      this.liveBadge.classList.toggle("disconnected", !connected);
    }
  }

  startFreshnessMonitor() {
    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
    }
    this.freshnessTimer = setInterval(() => this.updateFreshnessState(), 4000);
  }

  updateFreshnessState() {
    if (!this.statusIndicator) {
      return;
    }
    const now = Date.now();
    const age = this.lastUpdateTimestamp ? now - this.lastUpdateTimestamp : null;
    const isStale = age !== null && age > 15000;
    this.statusIndicator.classList.toggle("stale", isStale);
    this.statusIndicator.classList.toggle("fresh", !isStale && age !== null);
    if (this.hudElem) {
      this.hudElem.classList.toggle("data-stale", isStale);
    }
    if (this.liveBadge) {
      this.liveBadge.classList.toggle("stale", isStale);
    }
  }

  // --- Cleanup ----------------------------------------------------------
  _removeLayer(layerId) {
    if (!this.map?.getLayer(layerId)) {
      return;
    }
    this.map.removeLayer(layerId);
  }

  _removeSource(sourceId) {
    if (!this.map?.getSource(sourceId)) {
      return;
    }
    this.map.removeSource(sourceId);
  }

  destroy() {
    this.stopPolling();
    this._stopInterpolation();
    this._stopPulseAnimation();

    if (this.freshnessTimer) {
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.followToggle && this.followToggleHandler) {
      this.followToggle.removeEventListener("click", this.followToggleHandler);
    }

    if (this._styleChangeHandlerRef) {
      mapCore.unregisterStyleChangeHandler(this._styleChangeHandlerRef);
      this._styleChangeHandlerRef = null;
    }

    if (this.map && this.mapInteractionHandlers.length > 0) {
      this.mapInteractionHandlers.forEach(({ evt, handler }) => {
        this.map.off(evt, handler);
      });
      this.mapInteractionHandlers = [];
    }

    if (this.map) {
      try {
        [this.arrowLayerId, this.pulseLayerId, this.lineLayerId, this.markerLayerId].forEach(
          (layerId) => this._removeLayer(layerId)
        );
        this._removeSource(this.lineSourceId);
        this._removeSource(this.markerSourceId);
      } catch (error) {
        console.warn("Error removing layers:", error);
      }
    }

    this.clearTrip();
    this.updateStatus(false, "Disconnected");

    if (LiveTripTracker.instance === this) {
      LiveTripTracker.instance = null;
    }

    console.info("LiveTripTracker destroyed");
  }
}

export { LiveTripTracker };
export default LiveTripTracker;
