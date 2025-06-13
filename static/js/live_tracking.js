/* global DateUtils, mapboxgl */

class LiveTripTracker {
  static instance = null; // Singleton pattern

  constructor(map) {
    // Enforce singleton
    if (LiveTripTracker.instance) {
      LiveTripTracker.instance.destroy();
    }
    LiveTripTracker.instance = this;

    if (!map) {
      window.handleError(
        "LiveTripTracker: Map is required",
        "LiveTripTracker constructor",
      );
      return;
    }

    this.map = map;
    this.activeTrip = null;
    // Initialize Mapbox GL JS sources and layers for live tracking
    this.liveSourceId = "live-trip-source";
    this.liveLineLayerId = "live-trip-line";
    this.liveMarkerLayerId = "live-trip-marker";
    this.animationFrameId = null;

    // Initialize empty GeoJSON data
    this.initializeMapboxLayers();

    this.lastSequence = 0;
    this.pollingInterval = 500;
    this.maxPollingInterval = 1000;
    this.minPollingInterval = 10;
    this.pollingTimerId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPolling = false;
    this.lastMarkerLatLng = null; // For animating marker

    // Store current line coordinates for animation reference
    this.currentLineCoords = [];
    this.markerAnimationId = null;

    this.statusIndicator = document.querySelector(".live-status-indicator");
    this.statusText = document.querySelector(".live-status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.tripMetricsElem = document.querySelector(".live-trip-metrics");
    this.errorMessageElem = document.querySelector(".error-message");

    this.initialize();
  }

  initializeMapboxLayers() {
    if (!this.map || !this.map.addSource) {
      console.warn("LiveTripTracker: Map not ready for Mapbox layers");
      return;
    }

    try {
      // Add source for live tracking data
      if (!this.map.getSource(this.liveSourceId)) {
        this.map.addSource(this.liveSourceId, {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: [],
          },
        });
      }

      // Add line layer for the trip path
      if (!this.map.getLayer(this.liveLineLayerId)) {
        this.map.addLayer({
          id: this.liveLineLayerId,
          type: "line",
          source: this.liveSourceId,
          filter: ["==", ["get", "type"], "line"],
          paint: {
            "line-color": "#00FF00",
            "line-width": 3,
            "line-opacity": 0.8,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
          },
        });
      }

      // Add marker layer for current position
      if (!this.map.getLayer(this.liveMarkerLayerId)) {
        this.map.addLayer({
          id: this.liveMarkerLayerId,
          type: "circle",
          source: this.liveSourceId,
          filter: ["==", ["get", "type"], "marker"],
          paint: {
            "circle-radius": 6,
            "circle-color": "#00FF00",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
      }
    } catch (error) {
      console.error("Error initializing Mapbox layers:", error);
    }
  }

  async initialize() {
    try {
      await this.loadInitialTripData();
      this.initWebSocket(); // WebSocket first; fallback to polling if not available
      document.addEventListener("mapUpdated", () => {
        this.bringLiveTripToFront();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.decreasePollingInterval();
          this.bringLiveTripToFront();
        } else {
          this.increasePollingInterval();
        }
      });

      window.addEventListener("beforeunload", () => {
        this.stopPolling();
      });
    } catch (error) {
      window.handleError(
        `LiveTripTracker initialization error: ${error}`,
        "initialize",
      );
      this.updateStatus(false);
      this.showError("Failed to initialize tracker. Will retry shortly.");
      setTimeout(() => this.initialize(), 5000);
    }
  }

  async loadInitialTripData() {
    try {
      window.handleError(
        "Loading initial trip data",
        "loadInitialTripData",
        "info",
      );
      const response = await fetch("/api/active_trip");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      window.handleError(
        `Initial trip data response: ${JSON.stringify(data)}`,
        "loadInitialTripData",
        "info",
      );

      if (data.status === "success") {
        if (data.has_active_trip && data.trip) {
          window.handleError(
            `Found active trip: ${data.trip.transactionId} with sequence: ${data.trip.sequence}`,
            "loadInitialTripData",
            "info",
          );
          this.setActiveTrip(data.trip);
          this.updateActiveTripsCount(1);
          this.updateTripMetrics(data.trip);
          this.lastSequence = data.trip.sequence || 0;
          this.updateStatus(true);
        } else {
          window.handleError(
            "No active trips found during initialization",
            "loadInitialTripData",
            "info",
          );
          this.updateStatus(true, "No active trips");
          this.updateActiveTripsCount(0);
        }
      } else {
        throw new Error(data.message || "Error loading initial trip data");
      }
    } catch (error) {
      window.handleError(
        `Error loading initial trip data: ${error}`,
        "loadInitialTripData",
      );
      this.updateStatus(false, "Failed to load trip data");
      this.showError(`Failed to load trip data: ${error.message}`);
      throw error;
    }
  }

  startPolling() {
    if (this.isPolling) return;

    this.isPolling = true;
    this.poll();
    window.handleError(
      `LiveTripTracker: Started polling (${this.pollingInterval}ms interval)`,
      "startPolling",
      "info",
    );
  }

  stopPolling() {
    if (this.pollingTimerId) {
      clearTimeout(this.pollingTimerId);
      this.pollingTimerId = null;
    }
    this.isPolling = false;
    window.handleError(
      "LiveTripTracker: Stopped polling",
      "stopPolling",
      "info",
    );
  }

  async poll() {
    if (!this.isPolling) return;

    try {
      window.handleError(
        `Polling for updates since sequence: ${this.lastSequence}`,
        "poll",
        "info",
      );
      await this.fetchTripUpdates();

      this.consecutiveErrors = 0;

      if (this.activeTrip) {
        this.decreasePollingInterval();
      }
    } catch (error) {
      window.handleError(`Error polling trip updates: ${error}`, "poll");
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.updateStatus(false, "Connection lost");
        this.showError("Connection lost. Retrying...");
        this.increasePollingInterval();
      }
    } finally {
      this.pollingTimerId = setTimeout(() => {
        this.poll();
      }, this.pollingInterval);
    }
  }

  async fetchTripUpdates() {
    window.handleError(
      `Fetching trip updates with last_sequence=${this.lastSequence}`,
      "fetchTripUpdates",
      "info",
    );

    const response = await fetch(
      `/api/trip_updates?last_sequence=${this.lastSequence}`,
    );

    if (!response.ok) {
      window.handleError(`HTTP error: ${response.status}`, "fetchTripUpdates");
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    window.handleError(
      `Trip update response: ${JSON.stringify(data)}`,
      "fetchTripUpdates",
      "info",
    );

    if (data.status === "success") {
      if (data.has_update && data.trip) {
        window.handleError(
          `Received trip update with sequence: ${data.trip.sequence}`,
          "fetchTripUpdates",
          "info",
        );
        this.setActiveTrip(data.trip);
        this.updateActiveTripsCount(1);
        this.updateTripMetrics(data.trip);
        this.lastSequence = data.trip.sequence || this.lastSequence;
        this.updateStatus(true);
        this.hideError();

        this.setAdaptivePollingInterval(data.trip, true);
      } else if (this.activeTrip && !data.has_update) {
        window.handleError(
          "No new updates for current trip",
          "fetchTripUpdates",
          "info",
        );
        this.updateStatus(true);

        this.setAdaptivePollingInterval(this.activeTrip, false);
      } else if (!this.activeTrip && !data.has_update) {
        window.handleError("No active trips found", "fetchTripUpdates", "info");
        this.clearActiveTrip();
        this.updateActiveTripsCount(0);
        this.updateStatus(true, "No active trips");

        this.increasePollingInterval(1.2);
      }
    } else {
      window.handleError(
        `API error: ${data.message || "Unknown error"}`,
        "fetchTripUpdates",
      );
      throw new Error(data.message || "Unknown error fetching trip updates");
    }
  }

  increasePollingInterval(factor = 1.5) {
    const oldInterval = this.pollingInterval;
    this.pollingInterval = Math.min(
      this.pollingInterval * factor,
      this.maxPollingInterval,
    );

    if (this.pollingInterval !== oldInterval) {
      window.handleError(
        `LiveTripTracker: Increased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "increasePollingInterval",
        "info",
      );
    }

    if (this.pollingInterval >= this.maxPollingInterval && !this.activeTrip) {
      this.updateStatus(true, "Standby mode - waiting for trips");
    }
  }

  decreasePollingInterval(factor = 0.7, forceMinimum = false) {
    const oldInterval = this.pollingInterval;

    if (forceMinimum) {
      this.pollingInterval = this.minPollingInterval;
    } else {
      this.pollingInterval = Math.max(
        this.pollingInterval * factor,
        this.activeTrip ? this.minPollingInterval : this.minPollingInterval * 2,
      );
    }

    if (this.pollingInterval !== oldInterval) {
      window.handleError(
        `LiveTripTracker: Decreased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "decreasePollingInterval",
        "info",
      );
    }

    if (this.activeTrip) {
      this.updateStatus(true, "Connected - tracking active");
    }
  }

  setAdaptivePollingInterval(trip, hasNewData) {
    if (!trip) {
      this.increasePollingInterval(1.2);
      return;
    }

    const isMoving = trip.currentSpeed > 2;
    const isFastMoving = trip.currentSpeed > 15;

    if (isFastMoving && hasNewData) {
      this.decreasePollingInterval(0.5, true);
    } else if (isMoving && hasNewData) {
      this.decreasePollingInterval(0.8);
    } else if (isMoving) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else if (hasNewData) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else {
      this.increasePollingInterval(1.1);
    }
  }

  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) return;

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);
    this.statusIndicator.setAttribute(
      "aria-label",
      connected ? "Connected" : "Disconnected",
    );

    this.statusText.textContent =
      message || (connected ? "Connected" : "Disconnected");
  }

  showError(message) {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.textContent = message;
    this.errorMessageElem.classList.remove("d-none");
  }

  hideError() {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.classList.add("d-none");
  }

  // Helper for trip completion logic
  handleTripCompletion(trip) {
    if (trip.status === "completed") {
      window.handleError(
        "Trip is completed, clearing from map",
        "setActiveTrip",
        "info",
      );
      this.clearActiveTrip();
      this.updateActiveTripsCount(0);
      this.updateStatus(true, "No active trips");
      return true;
    }
    return false;
  }

  // Extract and sort coordinates from trip data
  extractCoordinates(trip) {
    let coordinates = [];

    if (Array.isArray(trip.coordinates) && trip.coordinates.length > 0) {
      coordinates = trip.coordinates;
    } else if (trip.gps) {
      const gps = trip.gps;
      if (
        gps.type === "Point" &&
        Array.isArray(gps.coordinates) &&
        gps.coordinates.length === 2
      ) {
        coordinates = [
          {
            lon: gps.coordinates[0],
            lat: gps.coordinates[1],
            timestamp: trip.startTime,
          },
        ];
      } else if (gps.type === "LineString" && Array.isArray(gps.coordinates)) {
        coordinates = gps.coordinates.map((coord) => ({
          lon: coord[0],
          lat: coord[1],
          timestamp: trip.startTime, // This is approximate
        }));
      }
    }

    if (coordinates.length === 0) {
      window.handleError(
        "No valid coordinates found in trip data",
        "setActiveTrip",
        "warn",
      );
      return null;
    }

    // Sort by timestamp if available
    if (coordinates[0].timestamp) {
      coordinates.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeA - timeB;
      });
    }

    return coordinates;
  }

  // Create GeoJSON features from coordinates
  createGeoJSONFeatures(coordinates) {
    const mapboxCoords = coordinates.map((coord) => [coord.lon, coord.lat]);
    const lastPoint = mapboxCoords[mapboxCoords.length - 1];
    const features = [];

    // Line feature for path
    if (mapboxCoords.length > 1) {
      features.push({
        type: "Feature",
        properties: { type: "line" },
        geometry: {
          type: "LineString",
          coordinates: mapboxCoords,
        },
      });
    }

    // Marker for current position
    if (lastPoint) {
      features.push({
        type: "Feature",
        properties: {
          type: "marker",
          speed: this.activeTrip.currentSpeed || 0,
        },
        geometry: {
          type: "Point",
          coordinates: lastPoint,
        },
      });
    }

    return { features, mapboxCoords, lastPoint };
  }

  // Update map view based on trip data
  updateMapView(mapboxCoords, lastPoint, isNewTrip) {
    if (isNewTrip && mapboxCoords.length > 0) {
      if (mapboxCoords.length > 1) {
        try {
          const bounds = new mapboxgl.LngLatBounds();
          mapboxCoords.forEach((coord) => bounds.extend(coord));
          this.map.fitBounds(bounds, { padding: 50 });
        } catch (e) {
          console.error("Error fitting bounds:", e);
          this.map.flyTo({ center: lastPoint, zoom: 15 });
        }
      } else {
        this.map.flyTo({ center: lastPoint, zoom: 15 });
      }
    } else if (
      lastPoint &&
      window.utils?.getStorage?.("autoFollowVehicle") === "true"
    ) {
      const bounds = this.map.getBounds();
      const point = new mapboxgl.LngLat(lastPoint[0], lastPoint[1]);
      if (!bounds.contains(point)) {
        this.map.panTo(lastPoint);
      }
    }
  }

  setActiveTrip(trip) {
    if (!trip) return;

    // FIXED: Remove overly aggressive sequence check that was preventing real-time updates
    // The previous check was: if (this.activeTrip && this.activeTrip.sequence === trip.sequence) return;
    // This was preventing updates when GPS data, speed, or other metrics changed but sequence didn't increment properly

    const isNewTrip =
      !this.activeTrip || this.activeTrip.transactionId !== trip.transactionId;

    // Handle trip completion
    if (this.handleTripCompletion(trip)) return;

    // FIXED: Always update activeTrip to ensure real-time data is current
    this.activeTrip = trip;

    // Extract and process coordinates
    const coordinates = this.extractCoordinates(trip);
    if (!coordinates) return;

    // Create GeoJSON features
    const { features, mapboxCoords, lastPoint } =
      this.createGeoJSONFeatures(coordinates);

    // Persist latest path for animations
    this.currentLineCoords = mapboxCoords;

    // Prepare starting marker position (previous known or current)
    const startPoint = this.lastMarkerLatLng || lastPoint;

    // Build initial feature collection: full line + marker at startPoint
    const lineFeature = features.find((f) => f.properties.type === "line");
    const markerFeature = {
      type: "Feature",
      properties: { type: "marker", speed: trip.currentSpeed || 0 },
      geometry: { type: "Point", coordinates: startPoint },
    };

    // Update map source with initial positions only once
    const source = this.map.getSource(this.liveSourceId);
    if (source) {
      const initialFeatures = lineFeature
        ? [lineFeature, markerFeature]
        : [markerFeature];
      source.setData({ type: "FeatureCollection", features: initialFeatures });
    }

    // Animate marker smoothly to latest position
    if (startPoint && lastPoint) {
      this.animateMarkerMovement(startPoint, lastPoint, trip);
    }

    // Update marker styling (color/size) based on current speed
    this.updateMarkerStyle(trip.currentSpeed || 0);

    // Update map view (camera follow, etc.)
    this.updateMapView(mapboxCoords, lastPoint, isNewTrip);

    // Store last position (will be true final point after animation)
    this.lastMarkerLatLng = lastPoint;
  }

  updateMarkerStyle(speed) {
    if (!this.map || !this.map.getLayer(this.liveMarkerLayerId)) return;

    let color = "#00FF00"; // Default green
    let radius = 6;

    if (speed === 0) {
      color = "#f44336"; // Red for stopped
      radius = 8;
    } else if (speed < 10) {
      color = "#ff9800"; // Orange for slow
      radius = 6;
    } else if (speed < 35) {
      color = "#2196f3"; // Blue for medium
      radius = 6;
    } else {
      color = "#9c27b0"; // Purple for fast
      radius = 8;
    }

    // Update marker
    this.map.setPaintProperty(this.liveMarkerLayerId, "circle-color", color);
    this.map.setPaintProperty(this.liveMarkerLayerId, "circle-radius", radius);
  }

  clearActiveTrip() {
    this.activeTrip = null;

    // Clear Mapbox source data
    const source = this.map.getSource(this.liveSourceId);
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: [],
      });
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
      this.activeTripsCountElem.setAttribute(
        "aria-label",
        `${count} active trips`,
      );
    }
  }

  // CLEANED UP: Compute trip metrics from trip data - only show meaningful metrics during live tracking
  computeTripMetrics(trip) {
    let startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const endTime = trip.endTime ? new Date(trip.endTime) : null;
    const tripStatus = trip.status || "active";

    let durationStr = trip.durationFormatted;
    if (!durationStr && startTime) {
      const endTimeToUse =
        tripStatus === "completed" ? endTime : lastUpdate || new Date();

      if (endTimeToUse) {
        durationStr = DateUtils.formatDurationHMS(startTime, endTimeToUse);
      }
    }

    const distance = typeof trip.distance === "number" ? trip.distance : 0;
    const currentSpeed =
      typeof trip.currentSpeed === "number" ? trip.currentSpeed : 0;
    const avgSpeed = typeof trip.avgSpeed === "number" ? trip.avgSpeed : 0;
    const maxSpeed = typeof trip.maxSpeed === "number" ? trip.maxSpeed : 0;
    const pointsRecorded = trip.pointsRecorded || trip.coordinates?.length || 0;
    const totalIdlingTime =
      typeof trip.totalIdlingTime === "number" ? trip.totalIdlingTime : 0;
    const hardBrakingCounts =
      typeof trip.hardBrakingCounts === "number" ? trip.hardBrakingCounts : 0;
    const hardAccelerationCounts =
      typeof trip.hardAccelerationCounts === "number"
        ? trip.hardAccelerationCounts
        : 0;

    let startTimeFormatted = "N/A";
    if (trip.startTimeFormatted) {
      startTimeFormatted = trip.startTimeFormatted;
    } else if (startTime) {
      try {
        if (typeof startTime === "string") {
          startTime = new Date(startTime);
        }

        if (!isNaN(startTime.getTime())) {
          startTimeFormatted = startTime.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: true,
          });
        }
      } catch (err) {
        console.error("Error formatting start time:", err);
      }
    }

    // CLEANED UP: Only include metrics that are meaningful during live tracking
    return {
      durationStr,
      distance,
      currentSpeed,
      avgSpeed,
      maxSpeed,
      pointsRecorded,
      totalIdlingTime,
      hardBrakingCounts,
      hardAccelerationCounts,
      startTimeFormatted,
      lastUpdate,
      isLive: tripStatus === "active", // Flag to help with conditional rendering
    };
  }

  // CLEANED UP: Render trip metrics to DOM - only show metrics that update during live tracking
  renderTripMetrics(metrics) {
    if (!this.tripMetricsElem) return;

    // Base metrics always shown for live trips
    const baseMetrics = {
      "Start Time": metrics.startTimeFormatted,
      Duration: metrics.durationStr || "0:00:00",
      Distance: `${metrics.distance.toFixed(2)} miles`,
      "Current Speed": `${metrics.currentSpeed.toFixed(1)} mph`,
      "Points Recorded": metrics.pointsRecorded,
      "Last Update": metrics.lastUpdate
        ? DateUtils.formatTimeAgo(metrics.lastUpdate)
        : "N/A",
    };

    // Advanced metrics (only show if they have meaningful values during live tracking)
    const advancedMetrics = {};

    // Only show average speed if we have a reasonable value (> 0)
    if (metrics.avgSpeed > 0) {
      advancedMetrics["Average Speed"] = `${metrics.avgSpeed.toFixed(1)} mph`;
    }

    // Only show max speed if we have a meaningful value (> current speed or > 5 mph)
    if (metrics.maxSpeed > Math.max(metrics.currentSpeed, 5)) {
      advancedMetrics["Max Speed"] = `${metrics.maxSpeed.toFixed(1)} mph`;
    }

    // Only show idling time if there's been some idling
    if (metrics.totalIdlingTime > 0) {
      advancedMetrics["Total Idling"] = DateUtils.formatSecondsToHMS(
        metrics.totalIdlingTime,
      );
    }

    // Only show driving behavior metrics if they exist
    if (metrics.hardBrakingCounts > 0) {
      advancedMetrics["Hard Braking"] = metrics.hardBrakingCounts;
    }

    if (metrics.hardAccelerationCounts > 0) {
      advancedMetrics["Hard Acceleration"] = metrics.hardAccelerationCounts;
    }

    // Create a cleaner layout with conditional sections
    const baseSection = Object.entries(baseMetrics)
      .map(
        ([label, value]) => `
          <div class="metric-row metric-base">
            <span class="metric-label">${label}:</span>
            <span class="metric-value">${value}</span>
          </div>
        `,
      )
      .join("");

    const advancedSection =
      Object.keys(advancedMetrics).length > 0
        ? `
        <div class="metric-section-divider"></div>
        <div class="metric-section-title">Trip Behavior</div>
        ${Object.entries(advancedMetrics)
          .map(
            ([label, value]) => `
              <div class="metric-row metric-advanced">
                <span class="metric-label">${label}:</span>
                <span class="metric-value">${value}</span>
              </div>
            `,
          )
          .join("")}
      `
        : "";

    this.tripMetricsElem.innerHTML = `
      <div class="metric-section">
        <div class="metric-section-title">Live Trip</div>
        ${baseSection}
      </div>
      ${advancedSection}
    `;
  }

  updateTripMetrics(trip) {
    if (!this.tripMetricsElem || !trip) return;

    const metrics = this.computeTripMetrics(trip);
    this.renderTripMetrics(metrics);
  }

  updatePolylineStyle(color, opacity) {
    if (!this.map || !this.map.getLayer(this.liveLineLayerId)) return;

    // Update line paint properties in Mapbox
    this.map.setPaintProperty(
      this.liveLineLayerId,
      "line-color",
      color || "#00FF00",
    );
    this.map.setPaintProperty(
      this.liveLineLayerId,
      "line-opacity",
      parseFloat(opacity) || 0.8,
    );

    window.handleError(
      "LiveTripTracker: Line style updated",
      "updatePolylineStyle",
      "info",
    );
  }

  bringLiveTripToFront() {
    // In Mapbox GL JS, layer order is determined by the order they're added
    window.handleError(
      "LiveTripTracker: Layers maintained at front (Mapbox GL JS)",
      "bringLiveTripToFront",
      "info",
    );
  }

  destroy() {
    this.stopPolling();

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Remove Mapbox layers and sources
    if (this.map) {
      try {
        if (this.map.getLayer(this.liveLineLayerId)) {
          this.map.removeLayer(this.liveLineLayerId);
        }
        if (this.map.getLayer(this.liveMarkerLayerId)) {
          this.map.removeLayer(this.liveMarkerLayerId);
        }
        if (this.map.getSource(this.liveSourceId)) {
          this.map.removeSource(this.liveSourceId);
        }
      } catch (error) {
        console.warn("Error removing live tracking layers:", error);
      }
    }

    this.updateStatus(false, "Disconnected");
    this.updateActiveTripsCount(0);

    if (this.tripMetricsElem) {
      this.tripMetricsElem.innerHTML = "";
    }

    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );

    if (LiveTripTracker.instance === this) {
      LiveTripTracker.instance = null;
    }

    window.handleError("LiveTripTracker instance destroyed", "destroy", "info");
  }

  /**
   * Initialize WebSocket live channel.
   * Falls back to polling when socket closes or errors.
   */
  initWebSocket() {
    // Clean up any existing connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (!("WebSocket" in window)) {
      return this.startPolling();
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws/trips`;

    try {
      this.ws = new WebSocket(url);

      // Prevent multiple animation loops
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
      }

      let needsUpdate = false;
      let latestTrip = null;

      this.ws.addEventListener("message", (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.trip) {
            latestTrip = data.trip;
            needsUpdate = true;
          }
        } catch (err) {
          console.warn("LiveTripTracker WebSocket parse error:", err);
        }
      });

      const updateLoop = () => {
        if (needsUpdate && latestTrip) {
          this.setActiveTrip(latestTrip);
          this.updateTripMetrics(latestTrip);
          needsUpdate = false;
        }
        this.animationFrameId = requestAnimationFrame(updateLoop);
      };
      updateLoop();

      this.ws.addEventListener("open", () => {
        console.info("LiveTripTracker: WebSocket connected – stopping poller");
        this.stopPolling();
      });

      this.ws.addEventListener("close", (event) => {
        console.warn("WebSocket closed – resuming polling", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.ws = null; // Clear reference
        this.startPolling();
      });

      this.ws.addEventListener("error", (event) => {
        console.warn("WebSocket error – resuming polling", event);
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        this.startPolling();
      });
    } catch (e) {
      console.warn("Failed to establish WebSocket:", e);
      this.startPolling();
    }
  }

  /**
   * Smoothly animates the marker from start -> end over the given duration.
   * During animation we only update the marker feature to minimise cost.
   */
  animateMarkerMovement(start, end, trip, duration = 300) {
    if (this.markerAnimationId) {
      cancelAnimationFrame(this.markerAnimationId);
    }

    const source = this.map.getSource(this.liveSourceId);
    if (!source) return;

    const lineCoords = this.currentLineCoords || [];
    const lineFeature = {
      type: "Feature",
      properties: { type: "line" },
      geometry: { type: "LineString", coordinates: lineCoords },
    };

    const startLng = start[0],
      startLat = start[1];
    const deltaLng = end[0] - start[0];
    const deltaLat = end[1] - start[1];

    const startTime = performance.now();
    const step = (now) => {
      const t = Math.min((now - startTime) / duration, 1);
      const currLng = startLng + deltaLng * t;
      const currLat = startLat + deltaLat * t;

      // Marker style may change based on speed – interpolate radius/color quickly
      const markerFeature = {
        type: "Feature",
        properties: { type: "marker", speed: trip.currentSpeed || 0 },
        geometry: { type: "Point", coordinates: [currLng, currLat] },
      };

      source.setData({
        type: "FeatureCollection",
        features:
          lineCoords.length > 1
            ? [lineFeature, markerFeature]
            : [markerFeature],
      });

      if (t < 1) {
        this.markerAnimationId = requestAnimationFrame(step);
      }
    };

    this.markerAnimationId = requestAnimationFrame(step);
  }
}

window.LiveTripTracker = LiveTripTracker;
