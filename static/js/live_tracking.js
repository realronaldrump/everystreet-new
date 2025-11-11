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
    this.lineLayerId = "live-trip-line";
    this.markerLayerId = "live-trip-marker";

    // DOM elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".live-status-text");
    this.tripCountElem = document.querySelector("#active-trips-count");
    this.metricsElem = document.querySelector(".live-trip-metrics");

    this.initializeMapLayers();
    this.initialize();
  }

  initializeMapLayers() {
    if (!this.map || !this.map.addSource) {
      console.warn("Map not ready for layers");
      return;
    }

    try {
      // Add GeoJSON source
      if (!this.map.getSource(this.sourceId)) {
        this.map.addSource(this.sourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      // Add line layer for trip path
      if (!this.map.getLayer(this.lineLayerId)) {
        this.map.addLayer({
          id: this.lineLayerId,
          type: "line",
          source: this.sourceId,
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

      // Add marker for current position
      if (!this.map.getLayer(this.markerLayerId)) {
        this.map.addLayer({
          id: this.markerLayerId,
          type: "circle",
          source: this.sourceId,
          filter: ["==", ["get", "type"], "marker"],
          paint: {
            "circle-radius": 8,
            "circle-color": "#00FF00",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
      }
    } catch (error) {
      console.error("Error initializing map layers:", error);
    }
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
    if (this.pollingTimer) return;

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
    if (!trip) return;

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

    // Create GeoJSON features
    const features = LiveTripTracker.createFeatures(coords);

    // Update map source
    const source = this.map.getSource(this.sourceId);
    if (source) {
      source.setData({ type: "FeatureCollection", features });
    }

    // Update marker style based on speed
    this.updateMarkerStyle(trip.currentSpeed || 0);

    // Update metrics panel
    this.updateMetrics(trip);

    // Update map view for new trips
    if (isNewTrip) {
      this.fitTripBounds(coords);
    } else if (window.utils?.getStorage?.("autoFollowVehicle") === "true") {
      this.followVehicle(coords[coords.length - 1]);
    }

    // Update UI
    this.updateTripCount(1);
    this.updateStatus(true, "Live tracking");
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

  static createFeatures(coords) {
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
      features.push({
        type: "Feature",
        properties: { type: "marker" },
        geometry: {
          type: "Point",
          coordinates: mapboxCoords[mapboxCoords.length - 1],
        },
      });
    }

    return features;
  }

  updateMarkerStyle(speed) {
    if (!this.map || !this.map.getLayer(this.markerLayerId)) return;

    let color, radius;

    if (speed === 0) {
      color = "#f44336"; // Red - stopped
      radius = 8;
    } else if (speed < 10) {
      color = "#ff9800"; // Orange - slow
      radius = 6;
    } else if (speed < 35) {
      color = "#2196f3"; // Blue - medium
      radius = 6;
    } else {
      color = window.MapStyles.MAP_LAYER_COLORS.liveTracking.fast;
      radius = 8;
    }

    this.map.setPaintProperty(this.markerLayerId, "circle-color", color);
    this.map.setPaintProperty(this.markerLayerId, "circle-radius", radius);
  }

  updateMetrics(trip) {
    if (!this.metricsElem || !trip) return;

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

    if (trip.totalIdlingTime > 0) {
      optional["Idling Time"] = DateUtils.formatSecondsToHMS(trip.totalIdlingTime);
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
      `
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
          `
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
    if (!coords || coords.length === 0) return;

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

  followVehicle(lastCoord) {
    if (!lastCoord) return;

    const point = [lastCoord.lon, lastCoord.lat];
    const bounds = this.map.getBounds();
    const lngLat = new mapboxgl.LngLat(point[0], point[1]);

    if (!bounds.contains(lngLat)) {
      this.map.panTo(point);
    }
  }

  clearTrip() {
    this.activeTrip = null;

    // Clear map
    const source = this.map.getSource(this.sourceId);
    if (source) {
      source.setData({ type: "FeatureCollection", features: [] });
    }

    // Clear metrics
    if (this.metricsElem) {
      this.metricsElem.innerHTML = "";
    }

    this.updateTripCount(0);
    this.updateStatus(true, "Idle");
  }

  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) return;

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);

    const statusMsg = message || (connected ? "Connected" : "Disconnected");
    this.statusText.textContent = statusMsg;
  }

  updateTripCount(count) {
    if (this.tripCountElem) {
      this.tripCountElem.textContent = count;
    }
  }

  destroy() {
    this.stopPolling();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Remove map layers
    if (this.map) {
      try {
        if (this.map.getLayer(this.lineLayerId)) {
          this.map.removeLayer(this.lineLayerId);
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
