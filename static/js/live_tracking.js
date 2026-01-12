/* global DateUtils, mapboxgl */

/**
 * LiveTripTracker - Real-time trip visualization for Bouncie webhooks
 *
 * Simplified single-user implementation with WebSocket primary, polling fallback.
 */
class LiveTripTracker {
  static instance = null;

  constructor(map) {
    // Enforce singleton
    if (LiveTripTracker.instance) {
      LiveTripTracker.instance.destroy();
    }
    LiveTripTracker.instance = this;

    if (!map) {
      console.error("LiveTripTracker: Map is required");
      return;
    }

    this.map = map;
    this.activeTrip = null;
    this.ws = null;
    this.pollingTimer = null;
    this.pollingInterval = 3000; // 3 seconds

    // Map layer IDs
    this.sourceId = "live-trip-source";
    this.lineGlowLayerId = "live-trip-line-glow";
    this.lineCasingLayerId = "live-trip-line-casing";
    this.lineLayerId = "live-trip-line";
    this.markerLayerId = "live-trip-marker";
    this.arrowLayerId = "live-trip-arrow";
    this.arrowImageId = "live-trip-arrow-icon";

    // DOM elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".live-status-text");
    this.tripCountElem = document.querySelector("#active-trips-count");
    this.metricsElem = document.querySelector(".live-trip-metrics");
    this.liveBadge = document.getElementById("live-status-badge");
    this.hudElem = document.getElementById("live-trip-hud");
    this.hudLastUpdateElem = document.getElementById("live-trip-last-update");
    this.hudSpeedElem = document.getElementById("live-trip-speed");
    this.hudStreetElem = document.getElementById("live-trip-street");
    this.hudCoverageElem = document.getElementById("live-trip-coverage");
    this.hudDistanceElem = document.getElementById("live-trip-distance");
    this.hudDurationElem = document.getElementById("live-trip-duration");
    this.hudAvgSpeedElem = document.getElementById("live-trip-avg-speed");
    this.followToggle = document.getElementById("live-trip-follow-toggle");
    this.followLabel = this.followToggle?.querySelector(".follow-label");

    this.coverageLayerIds = [
      "drivenStreets-layer",
      "undrivenStreets-layer",
      "allStreets-layer",
    ];

    this.followStorageKey = "autoFollowVehicle";
    this.followPreference = this.loadFollowPreference();
    this.followMode = false;
    this.lastBearing = null;
    this.lastCoord = null;
    this.hasActiveTrip = false;
    this.routeStyle = this.loadRouteStyle();
    this.mapInteractionHandlers = [];

    this.initializeMapLayers();
    this.bindHudControls();
    this.bindMapInteractionHandlers();
    this.setLiveTripActive(false);
    this.initialize();
  }

  initializeMapLayers() {
    if (!this.map || !this.map.addSource) {
      console.warn("Map not ready for layers");
      return;
    }

    // Add pulse ring layer ID
    this.pulseLayerId = "live-trip-pulse";

    try {
      const lineWidth = [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        3.5,
        14,
        5,
        18,
        8,
      ];
      const casingWidth = [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        6.5,
        14,
        9,
        18,
        13,
      ];
      const glowWidth = [
        "interpolate",
        ["linear"],
        ["zoom"],
        10,
        10,
        14,
        14,
        18,
        20,
      ];
      const { color, opacity } = this.routeStyle;
      const casingColor = this.getRouteCasingColor();

      // Add GeoJSON source
      if (!this.map.getSource(this.sourceId)) {
        this.map.addSource(this.sourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      // Glow layer (underlay) for the live route
      if (!this.map.getLayer(this.lineGlowLayerId)) {
        this.map.addLayer({
          id: this.lineGlowLayerId,
          type: "line",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "line"],
          paint: {
            "line-color": color,
            "line-width": glowWidth,
            "line-opacity": Math.min(0.45, opacity * 0.6),
            "line-blur": 6,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
        });
      }

      // Outer casing for route legibility
      if (!this.map.getLayer(this.lineCasingLayerId)) {
        this.map.addLayer({
          id: this.lineCasingLayerId,
          type: "line",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "line"],
          paint: {
            "line-color": casingColor,
            "line-width": casingWidth,
            "line-opacity": 0.85,
            "line-blur": 0.6,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
        });
      }

      // Add line layer for trip path with enhanced styling
      if (!this.map.getLayer(this.lineLayerId)) {
        this.map.addLayer({
          id: this.lineLayerId,
          type: "line",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "line"],
          paint: {
            "line-color": color,
            "line-width": lineWidth,
            "line-opacity": opacity,
            "line-blur": 0.3,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
        });
      }

      // Add outer pulse ring layer (animated via CSS/JS)
      if (!this.map.getLayer(this.pulseLayerId)) {
        this.map.addLayer({
          id: this.pulseLayerId,
          type: "circle",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "marker"],
          paint: {
            "circle-radius": 20,
            "circle-color": "transparent",
            "circle-stroke-width": 2,
            "circle-stroke-color": color,
            "circle-stroke-opacity": 0.4,
          },
        });
      }

      // Add marker for current position with enhanced styling
      if (!this.map.getLayer(this.markerLayerId)) {
        this.map.addLayer({
          id: this.markerLayerId,
          type: "circle",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "marker"],
          paint: {
            "circle-radius": 9,
            "circle-color": color,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#ffffff",
            "circle-blur": 0,
          },
        });
      }

      this.ensureArrowLayer();

      // Start pulse animation
      this.startPulseAnimation();
    } catch (error) {
      console.error("Error initializing map layers:", error);
    }
  }

  loadRouteStyle() {
    let color = LiveTripTracker.getCssVar("--primary", "#7c9d96");
    let opacity = 0.9;

    try {
      const storedColor = localStorage.getItem("polylineColor");
      const storedOpacity = localStorage.getItem("polylineOpacity");
      if (storedColor) {
        color = storedColor;
      }
      if (storedOpacity) {
        const parsed = Number.parseFloat(storedOpacity);
        if (Number.isFinite(parsed)) {
          opacity = Math.min(Math.max(parsed, 0.1), 1);
        }
      }
    } catch {
      // Ignore storage errors
    }

    return { color, opacity };
  }

  loadFollowPreference() {
    try {
      const stored = window.utils?.getStorage?.(this.followStorageKey);
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

  getRouteCasingColor() {
    const theme =
      document.documentElement.getAttribute("data-bs-theme") || "dark";
    return theme === "light"
      ? "rgba(15, 23, 42, 0.8)"
      : "rgba(248, 250, 252, 0.85)";
  }

  applyRouteStyle() {
    if (!this.map) {
      return;
    }
    const { color, opacity } = this.routeStyle;
    if (this.map.getLayer(this.lineLayerId)) {
      this.map.setPaintProperty(this.lineLayerId, "line-color", color);
      this.map.setPaintProperty(this.lineLayerId, "line-opacity", opacity);
    }
    if (this.map.getLayer(this.lineGlowLayerId)) {
      this.map.setPaintProperty(this.lineGlowLayerId, "line-color", color);
      this.map.setPaintProperty(
        this.lineGlowLayerId,
        "line-opacity",
        Math.min(0.45, opacity * 0.6),
      );
    }
    if (this.map.getLayer(this.lineCasingLayerId)) {
      this.map.setPaintProperty(
        this.lineCasingLayerId,
        "line-color",
        this.getRouteCasingColor(),
      );
    }
  }

  updatePolylineStyle(color, opacity) {
    const nextColor = color || this.routeStyle.color;
    const parsedOpacity = Number.parseFloat(opacity);
    const nextOpacity = Number.isFinite(parsedOpacity)
      ? Math.min(Math.max(parsedOpacity, 0.1), 1)
      : this.routeStyle.opacity;
    this.routeStyle = { color: nextColor, opacity: nextOpacity };
    this.applyRouteStyle();
  }

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
        this.followVehicle(this.lastCoord, this.lastBearing, {
          immediate: true,
        });
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
      const wasFollowing = this.followMode;
      this.followMode = false;
      this.updateFollowToggle(false, { disabled: true });
      this.clearHudValues();
      if (wasFollowing) {
        this.resetFollowCamera();
      }
      return;
    }

    this.updateFollowToggle(this.followMode, { disabled: false });
  }

  updateFollowToggle(isActive, { disabled = false } = {}) {
    if (!this.followToggle) {
      return;
    }
    this.followToggle.classList.toggle("is-active", isActive);
    this.followToggle.setAttribute("aria-pressed", isActive ? "true" : "false");
    this.followToggle.disabled = disabled;
    if (this.followLabel) {
      this.followLabel.textContent = isActive ? "Following" : "Follow";
    }
  }

  setFollowMode(
    enabled,
    { persist = true, resetCamera = false, force = false } = {},
  ) {
    if (!force && this.followMode === enabled) {
      this.updateFollowToggle(enabled);
      return;
    }

    this.followMode = enabled;

    if (persist) {
      this.followPreference = enabled;
      window.utils?.setStorage?.(this.followStorageKey, enabled);
    }

    this.updateFollowToggle(enabled);

    if (!enabled && resetCamera) {
      this.resetFollowCamera();
    }
  }

  getFollowCameraConfig() {
    const isMobile = window.utils?.getDeviceProfile?.().isMobile;
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const containerHeight = this.map?.getContainer()?.clientHeight || 600;
    const offsetY = Math.round(
      Math.min(180, Math.max(90, containerHeight * 0.22)),
    );

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
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: prefersReducedMotion ? 0 : 700,
      essential: true,
    });
  }

  clearHudValues() {
    if (this.hudLastUpdateElem) {
      this.hudLastUpdateElem.textContent = "Waiting for updates...";
    }
    if (this.hudSpeedElem) {
      this.hudSpeedElem.textContent = "--";
    }
    if (this.hudStreetElem) {
      this.hudStreetElem.textContent = "--";
      this.hudStreetElem.title = "";
    }
    if (this.hudCoverageElem) {
      this.hudCoverageElem.textContent = "Coverage: --";
      this.hudCoverageElem.classList.remove(
        "is-driven",
        "is-undriven",
        "is-undriveable",
      );
    }
    if (this.hudDistanceElem) {
      this.hudDistanceElem.textContent = "--";
    }
    if (this.hudDurationElem) {
      this.hudDurationElem.textContent = "--";
    }
    if (this.hudAvgSpeedElem) {
      this.hudAvgSpeedElem.textContent = "--";
    }
  }

  ensureArrowLayer() {
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
        source: this.sourceId,
        filter: ["==", ["get", "type"], "marker"],
        layout: {
          "icon-image": this.arrowImageId,
          "icon-size": 0.55,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map",
        },
        paint: {
          "icon-color": this.routeStyle.color,
        },
      });
    };

    if (this.map.hasImage(this.arrowImageId)) {
      addLayer();
      return;
    }

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
        <path d="M24 4L40 44L24 36L8 44Z" fill="black" />
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

  updateHud(trip, coords) {
    if (!this.hudElem || !trip) {
      return;
    }

    const speedValue =
      typeof trip.currentSpeed === "number"
        ? Math.max(0, Math.round(trip.currentSpeed))
        : 0;
    if (this.hudSpeedElem) {
      this.hudSpeedElem.textContent = `${speedValue}`;
    }

    const startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    let duration = "--";
    if (startTime && lastUpdate) {
      duration = DateUtils.formatDurationHMS(startTime, lastUpdate);
    }

    if (this.hudDurationElem) {
      this.hudDurationElem.textContent = duration;
    }
    if (this.hudDistanceElem) {
      this.hudDistanceElem.textContent = `${(trip.distance || 0).toFixed(2)} mi`;
    }
    if (this.hudAvgSpeedElem) {
      this.hudAvgSpeedElem.textContent =
        trip.avgSpeed > 0 ? `${trip.avgSpeed.toFixed(1)} mph` : "--";
    }

    if (this.hudLastUpdateElem) {
      this.hudLastUpdateElem.textContent = lastUpdate
        ? `Updated ${DateUtils.formatTimeAgo(lastUpdate)}`
        : "Updating...";
    }

    const areaName = this.getCoverageAreaName();
    const lastCoord = coords?.[coords.length - 1];
    const coverageInfo = lastCoord
      ? this.getCoverageStreetInfo(lastCoord)
      : null;

    if (coverageInfo?.streetName && this.hudStreetElem) {
      this.hudStreetElem.textContent = coverageInfo.streetName;
      this.hudStreetElem.title = coverageInfo.streetName;
    } else if (this.hudStreetElem) {
      const fallback = areaName ? "Outside coverage" : "--";
      this.hudStreetElem.textContent = fallback;
      this.hudStreetElem.title = fallback;
    }

    this.updateCoverageBadge(coverageInfo?.status, areaName);
  }

  updateCoverageBadge(status, areaName) {
    if (!this.hudCoverageElem) {
      return;
    }

    this.hudCoverageElem.classList.remove(
      "is-driven",
      "is-undriven",
      "is-undriveable",
    );

    if (!status) {
      this.hudCoverageElem.textContent = areaName
        ? `Coverage: ${areaName}`
        : "Coverage: Not active";
      return;
    }

    const normalized = String(status).toLowerCase();
    let label = "Unknown";
    if (normalized === "driven") {
      label = "Driven";
      this.hudCoverageElem.classList.add("is-driven");
    } else if (normalized === "undriven") {
      label = "Undriven";
      this.hudCoverageElem.classList.add("is-undriven");
    } else if (normalized === "undriveable") {
      label = "Undriveable";
      this.hudCoverageElem.classList.add("is-undriveable");
    }

    const suffix = areaName ? ` - ${areaName}` : "";
    this.hudCoverageElem.textContent = `Coverage: ${label}${suffix}`;
  }

  getCoverageAreaName() {
    const select = document.getElementById("streets-location");
    if (!select || !select.value) {
      return null;
    }
    const selected = select.options[select.selectedIndex];
    const text = selected?.textContent?.trim();
    if (!text || text === "Select a location...") {
      return null;
    }
    return text;
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
    const features = this.map.queryRenderedFeatures(bbox, {
      layers: visibleLayers,
    });

    if (!features.length) {
      return null;
    }

    const preferred = visibleLayers
      .map((layerId) =>
        features.find((feature) => feature.layer?.id === layerId),
      )
      .find(Boolean);
    const feature = preferred || features[0];
    const props = feature?.properties || {};
    const streetName = props.street_name || props.name || null;
    let status = props.status || null;

    if (!status && feature?.layer?.id) {
      if (feature.layer.id.includes("driven")) {
        status = "driven";
      } else if (feature.layer.id.includes("undriven")) {
        status = "undriven";
      }
    }

    if (!streetName) {
      return null;
    }

    return { streetName, status };
  }

  async initialize() {
    try {
      // Load initial trip data
      await this.loadInitialTrip();

      // Start WebSocket connection
      this.connectWebSocket();

      // Re-layer on map updates
      document.addEventListener("mapUpdated", () => {
        // Live trip layers are always on top in Mapbox GL JS
        console.debug("Map updated, live trip layers maintained");
      });
    } catch (error) {
      console.error("Initialization error:", error);
      this.updateStatus(false, "Failed to initialize");
      this.startPolling();
    }
  }

  async loadInitialTrip() {
    try {
      const response = await fetch("/api/active_trip");
      const data = await response.json();

      if (data.status === "success" && data.has_active_trip && data.trip) {
        console.info(`Initial trip loaded: ${data.trip.transactionId}`);
        this.updateTrip(data.trip);
      } else {
        console.info("No active trip on startup");
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

    if (!("WebSocket" in window)) {
      console.warn("WebSocket not supported, using polling");
      this.startPolling();
      return;
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/trips`;

    try {
      this.ws = new WebSocket(url);

      this.ws.addEventListener("open", () => {
        console.info("WebSocket connected");
        this.stopPolling();
        this.updateStatus(true);
      });

      this.ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "trip_state" && data.trip) {
            this.updateTrip(data.trip);
          }
        } catch (error) {
          console.error("WebSocket message error:", error);
        }
      });

      this.ws.addEventListener("close", (event) => {
        console.warn("WebSocket closed, switching to polling", event);
        this.ws = null;
        this.updateStatus(false, "Reconnecting...");
        this.startPolling();
      });

      this.ws.addEventListener("error", (error) => {
        console.error("WebSocket error:", error);
        this.updateStatus(false, "Connection error");
      });
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      this.startPolling();
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
      const response = await fetch("/api/trip_updates");
      const data = await response.json();

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

  updateTrip(trip) {
    if (!trip) {
      return;
    }

    // Handle completed trips
    if (trip.status === "completed") {
      console.info(`Trip ${trip.transactionId} completed`);
      this.clearTrip();
      return;
    }

    const isNewTrip =
      !this.activeTrip || this.activeTrip.transactionId !== trip.transactionId;

    this.activeTrip = trip;

    // Extract coordinates
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

    // Create GeoJSON features
    const features = LiveTripTracker.createFeatures(coords, heading);

    // Update map source
    const source = this.map.getSource(this.sourceId);
    if (source) {
      source.setData({ type: "FeatureCollection", features });
    }

    // Update marker style based on speed
    this.updateMarkerStyle(trip.currentSpeed || 0);

    // Update metrics panel
    this.updateMetrics(trip);
    this.updateHud(trip, coords);

    // Update map view for new trips
    if (isNewTrip) {
      this.setLiveTripActive(true);
      this.setFollowMode(this.followPreference, {
        persist: false,
        resetCamera: false,
      });
      if (this.followMode) {
        this.followVehicle(coords[coords.length - 1], heading, {
          immediate: true,
        });
      } else {
        this.fitTripBounds(coords);
      }
    } else if (this.followMode) {
      this.followVehicle(coords[coords.length - 1], heading);
    }

    this.lastCoord = coords[coords.length - 1];

    // Update UI
    this.updateTripCount(1);
    this.updateStatus(true, "Live tracking");

    document.dispatchEvent(
      new CustomEvent("liveTrackingUpdated", {
        detail: {
          trip,
          coords,
        },
      }),
    );
  }

  static extractCoordinates(trip) {
    let coords = [];

    // Try coordinates array first (active trips)
    if (Array.isArray(trip.coordinates) && trip.coordinates.length > 0) {
      coords = trip.coordinates
        .map((c) => {
          if (c && c.lon !== undefined && c.lat !== undefined) {
            return { lon: c.lon, lat: c.lat, timestamp: c.timestamp };
          }
          return null;
        })
        .filter(Boolean);
    }

    // Fallback to GeoJSON format
    if (coords.length === 0 && trip.gps) {
      const { gps } = trip;
      if (gps.type === "Point" && Array.isArray(gps.coordinates)) {
        coords = [{ lon: gps.coordinates[0], lat: gps.coordinates[1] }];
      } else if (gps.type === "LineString" && Array.isArray(gps.coordinates)) {
        coords = gps.coordinates.map((c) => ({ lon: c[0], lat: c[1] }));
      }
    }

    return coords;
  }

  static createFeatures(coords, heading = null) {
    const features = [];
    const mapboxCoords = coords.map((c) => [c.lon, c.lat]);

    // Line feature for path
    if (mapboxCoords.length > 1) {
      features.push({
        type: "Feature",
        properties: { type: "line" },
        geometry: { type: "LineString", coordinates: mapboxCoords },
      });
    }

    // Marker for current position
    if (mapboxCoords.length > 0) {
      const markerProps = { type: "marker" };
      if (typeof heading === "number") {
        markerProps.heading = heading;
      }
      features.push({
        type: "Feature",
        properties: markerProps,
        geometry: {
          type: "Point",
          coordinates: mapboxCoords[mapboxCoords.length - 1],
        },
      });
    }

    return features;
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

  updateMarkerStyle(speed) {
    if (!this.map || !this.map.getLayer(this.markerLayerId)) {
      return;
    }

    let color = "";
    let radius = 0;
    let strokeWidth = 0;

    if (speed === 0) {
      color = LiveTripTracker.getCssVar("--danger", "#d48584");
      radius = 8;
      strokeWidth = 2;
    } else if (speed < 10) {
      color = LiveTripTracker.getCssVar("--warning", "#d4a574");
      radius = 8;
      strokeWidth = 2;
    } else if (speed < 35) {
      color = LiveTripTracker.getCssVar("--info", "#8b9dc3");
      radius = 9;
      strokeWidth = 2.5;
    } else {
      color = LiveTripTracker.getCssVar("--primary", "#7c9d96");
      radius = 10;
      strokeWidth = 3;
    }

    // Update marker styling with smooth transition
    this.map.setPaintProperty(this.markerLayerId, "circle-color", color);
    this.map.setPaintProperty(this.markerLayerId, "circle-radius", radius);
    this.map.setPaintProperty(
      this.markerLayerId,
      "circle-stroke-width",
      strokeWidth,
    );

    // Sync pulse ring color
    if (this.map.getLayer(this.pulseLayerId)) {
      this.map.setPaintProperty(
        this.pulseLayerId,
        "circle-stroke-color",
        color,
      );
    }

    if (this.map.getLayer(this.arrowLayerId)) {
      this.map.setPaintProperty(this.arrowLayerId, "icon-color", color);
    }
  }

  /**
   * Start animated pulse effect on the vehicle marker
   */
  startPulseAnimation() {
    if (this.pulseAnimationFrame) {
      return;
    }

    let pulseRadius = 20;
    let pulseOpacity = 0.4;
    let expanding = true;

    const animate = () => {
      if (!this.map || !this.map.getLayer(this.pulseLayerId)) {
        this.stopPulseAnimation();
        return;
      }

      // Animate radius between 20 and 35
      if (expanding) {
        pulseRadius += 0.3;
        pulseOpacity -= 0.006;
        if (pulseRadius >= 35) {
          expanding = false;
        }
      } else {
        pulseRadius -= 0.5;
        pulseOpacity += 0.01;
        if (pulseRadius <= 20) {
          expanding = true;
        }
      }

      try {
        this.map.setPaintProperty(
          this.pulseLayerId,
          "circle-radius",
          pulseRadius,
        );
        this.map.setPaintProperty(
          this.pulseLayerId,
          "circle-stroke-opacity",
          Math.max(0.1, pulseOpacity),
        );
      } catch {
        // Layer might be removed during animation
      }

      this.pulseAnimationFrame = requestAnimationFrame(animate);
    };

    this.pulseAnimationFrame = requestAnimationFrame(animate);
  }

  /**
   * Stop pulse animation
   */
  stopPulseAnimation() {
    if (this.pulseAnimationFrame) {
      cancelAnimationFrame(this.pulseAnimationFrame);
      this.pulseAnimationFrame = null;
    }
  }

  updateMetrics(trip) {
    if (!this.metricsElem || !trip) {
      return;
    }

    const startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;

    // Calculate duration
    let duration = "0:00:00";
    if (startTime && lastUpdate) {
      duration = DateUtils.formatDurationHMS(startTime, lastUpdate);
    }

    // Build metrics HTML
    const metrics = {
      "Start Time": startTime
        ? startTime.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
          })
        : "N/A",
      Duration: duration,
      Distance: `${(trip.distance || 0).toFixed(2)} mi`,
      "Current Speed": `${(trip.currentSpeed || 0).toFixed(1)} mph`,
      "Points Recorded": trip.pointsRecorded || 0,
      "Last Update": lastUpdate ? DateUtils.formatTimeAgo(lastUpdate) : "N/A",
    };

    // Optional metrics (only show if meaningful)
    const optional = {};

    if (trip.avgSpeed > 0) {
      optional["Average Speed"] = `${trip.avgSpeed.toFixed(1)} mph`;
    }

    if (trip.maxSpeed > Math.max(trip.currentSpeed, 5)) {
      optional["Max Speed"] = `${trip.maxSpeed.toFixed(1)} mph`;
    }

    if (trip.totalIdleDuration > 0) {
      optional["Idling Time"] = DateUtils.formatSecondsToHMS(
        trip.totalIdleDuration,
      );
    }

    if (trip.hardBrakingCounts > 0) {
      optional["Hard Braking"] = trip.hardBrakingCounts;
    }

    if (trip.hardAccelerationCounts > 0) {
      optional["Hard Acceleration"] = trip.hardAccelerationCounts;
    }

    // Render metrics
    const baseHtml = Object.entries(metrics)
      .map(
        ([label, value]) => `
        <div class="metric-row">
          <span class="metric-label">${label}:</span>
          <span class="metric-value">${value}</span>
        </div>
      `,
      )
      .join("");

    const optionalHtml =
      Object.keys(optional).length > 0
        ? `
        <div class="metric-section-divider"></div>
        <div class="metric-section-title">Trip Behavior</div>
        ${Object.entries(optional)
          .map(
            ([label, value]) => `
            <div class="metric-row">
              <span class="metric-label">${label}:</span>
              <span class="metric-value">${value}</span>
            </div>
          `,
          )
          .join("")}
      `
        : "";

    this.metricsElem.innerHTML = `
      <div class="metric-section">
        <div class="metric-section-title">Live Trip</div>
        ${baseHtml}
      </div>
      ${optionalHtml}
    `;
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
    const bearing =
      typeof heading === "number" ? heading : this.map.getBearing() || 0;
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
    this.activeTrip = null;
    this.lastCoord = null;
    this.lastBearing = null;

    // Clear map
    const source = this.map.getSource(this.sourceId);
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }

    // Clear metrics
    if (this.metricsElem) {
      this.metricsElem.innerHTML = `
        <div class="text-secondary small">No live trip in progress.</div>
      `;
    }

    this.setLiveTripActive(false);
    this.updateTripCount(0);
    this.updateStatus(true, "Idle");
  }

  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) {
      return;
    }

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);

    const statusMsg = message || (connected ? "Connected" : "Disconnected");
    this.statusText.textContent = statusMsg;

    if (this.liveBadge) {
      this.liveBadge.classList.toggle("disconnected", !connected);
    }
  }

  updateTripCount(count) {
    if (this.tripCountElem) {
      this.tripCountElem.textContent = count;
    }
  }

  destroy() {
    this.stopPolling();
    this.stopPulseAnimation();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.followToggle && this.followToggleHandler) {
      this.followToggle.removeEventListener("click", this.followToggleHandler);
    }

    if (this.map && this.mapInteractionHandlers.length > 0) {
      this.mapInteractionHandlers.forEach(({ evt, handler }) => {
        this.map.off(evt, handler);
      });
      this.mapInteractionHandlers = [];
    }

    // Remove map layers
    if (this.map) {
      try {
        if (this.map.getLayer(this.pulseLayerId)) {
          this.map.removeLayer(this.pulseLayerId);
        }
        if (this.map.getLayer(this.arrowLayerId)) {
          this.map.removeLayer(this.arrowLayerId);
        }
        if (this.map.getLayer(this.lineLayerId)) {
          this.map.removeLayer(this.lineLayerId);
        }
        if (this.map.getLayer(this.lineCasingLayerId)) {
          this.map.removeLayer(this.lineCasingLayerId);
        }
        if (this.map.getLayer(this.lineGlowLayerId)) {
          this.map.removeLayer(this.lineGlowLayerId);
        }
        if (this.map.getLayer(this.markerLayerId)) {
          this.map.removeLayer(this.markerLayerId);
        }
        if (this.map.getSource(this.sourceId)) {
          this.map.removeSource(this.sourceId);
        }
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

window.LiveTripTracker = LiveTripTracker;
