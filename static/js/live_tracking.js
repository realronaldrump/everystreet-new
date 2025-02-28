/* global L */
/**
 * LiveTripTracker - Tracks and visualizes real-time vehicle location
 * @class
 */
class LiveTripTracker {
  /**
   * Creates a new LiveTripTracker instance
   * @param {L.Map} map - Leaflet map instance
   */
  constructor(map) {
    if (!map) {
      console.error("LiveTripTracker: Map is required");
      return;
    }

    // Initialize properties
    this.map = map;
    this.activeTrip = null;
    this.polyline = L.polyline([], {
      color: "#00FF00",
      weight: 3,
      opacity: 0.8,
    }).addTo(this.map);

    this.marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "vehicle-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    });

    // WebSocket state
    this.websocket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectTimeout = null;

    // UI elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.tripMetricsElem = document.querySelector(".live-trip-metrics");

    // Initialize
    this.initialize();
  }

  /**
   * Initialize the tracker
   * @async
   */
  async initialize() {
    try {
      await this.loadInitialTripData();
      this.connectWebSocket();
    } catch (error) {
      console.error("LiveTripTracker initialization error:", error);
      this.updateStatus(false);
    }
  }

  /**
   * Load initial trip data from API
   * @async
   */
  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");

      if (response.ok) {
        const trip = await response.json();
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
        this.updateTripMetrics(trip);
      } else {
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.error("Error loading initial trip data:", error.message);
      this.updateActiveTripsCount(0);
    }
  }

  /**
   * Connect to WebSocket for live updates
   */
  connectWebSocket() {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Create new WebSocket connection
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;

    this.websocket = new WebSocket(wsUrl);

    // Set up event handlers
    this.websocket.addEventListener("open", () => {
      this.updateStatus(true);
      this.reconnectAttempts = 0;
    });

    this.websocket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleWebSocketMessage(message);
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    });

    this.websocket.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
      this.updateStatus(false);
    });

    this.websocket.addEventListener("close", () => {
      this.updateStatus(false);
      this.attemptReconnect();
    });
  }

  /**
   * Attempt to reconnect to WebSocket
   */
  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      window.notificationManager.show(
        `WebSocket reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
        "info"
      );

      this.reconnectTimeout = setTimeout(() => {
        this.connectWebSocket();
      }, delay);
    } else {
      console.error("Maximum WebSocket reconnect attempts reached");
      this.updateStatus(false, "Connection failed");
    }
  }

  /**
   * Update connection status UI
   * @param {boolean} connected - Whether connection is established
   * @param {string} [message] - Optional status message
   */
  updateStatus(connected, message) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("connected", connected);
      this.statusIndicator.classList.toggle("disconnected", !connected);
      this.statusIndicator.setAttribute(
        "aria-label",
        connected ? "Connected" : "Disconnected"
      );
    }

    if (this.statusText) {
      this.statusText.textContent =
        message || (connected ? "Connected" : "Disconnected");
    }
  }

  /**
   * Handle messages from WebSocket
   * @param {Object} message - Message data
   */
  handleWebSocketMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
      case "trip_update":
        if (message.data) {
          this.setActiveTrip(message.data);
          this.updateActiveTripsCount(1);
          this.updateTripMetrics(message.data);
        }
        break;

      case "heartbeat":
        this.clearActiveTrip();
        this.updateActiveTripsCount(0);
        break;

      case "error":
        console.error("WebSocket error from server:", message.message);
        this.updateStatus(false, "Error: " + message.message);
        break;

      default:
        console.warn("Unhandled WebSocket message type:", message.type);
    }
  }

  /**
   * Set active trip data and update map
   * @param {Object} trip - Trip data
   */
  setActiveTrip(trip) {
    if (!trip) return;

    this.activeTrip = trip;

    if (!Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
      this.clearActiveTrip();
      return;
    }

    // Sort coordinates by timestamp for proper path
    trip.coordinates.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    // Update polyline path
    const latLngs = trip.coordinates.map((coord) => [coord.lat, coord.lon]);
    this.polyline.setLatLngs(latLngs);

    // Update marker position to latest point
    const lastPoint = latLngs[latLngs.length - 1];
    if (!this.map.hasLayer(this.marker)) {
      this.marker.addTo(this.map);
    }

    this.marker.setLatLng(lastPoint);
    this.marker.setOpacity(1);

    // Center map on latest position if enabled in user settings
    if (trip.autoCenter) {
      this.map.panTo(lastPoint);
    }
  }

  /**
   * Clear active trip data from map
   */
  clearActiveTrip() {
    this.activeTrip = null;
    this.polyline.setLatLngs([]);

    if (this.map.hasLayer(this.marker)) {
      this.map.removeLayer(this.marker);
    }
  }

  /**
   * Update active trips count in UI
   * @param {number} count - Number of active trips
   */
  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
      this.activeTripsCountElem.setAttribute(
        "aria-label",
        `${count} active trips`
      );
    }
  }

  /**
   * Update trip metrics display
   * @param {Object} trip - Trip data
   */
  updateTripMetrics(trip) {
    if (!this.tripMetricsElem || !trip) return;

    const startTime = trip.startTime
      ? new Date(trip.startTime).toLocaleString()
      : "N/A";
    const duration = trip.duration || "N/A";
    const distance = trip.distance
      ? `${trip.distance.toFixed(2)} miles`
      : "N/A";
    const speed = trip.currentSpeed
      ? `${trip.currentSpeed.toFixed(1)} mph`
      : "N/A";

    this.tripMetricsElem.innerHTML = `
      <div>Start Time: ${startTime}</div>
      <div>Duration: ${duration}</div>
      <div>Distance: ${distance}</div>
      <div>Current Speed: ${speed}</div>
    `;
  }

  /**
   * Clean up resources when tracker is no longer needed
   */
  destroy() {
    // Clean up WebSocket connection
    if (this.websocket) {
      this.websocket.close();
    }

    // Clear any pending reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Remove map layers
    if (this.map) {
      if (this.map.hasLayer(this.polyline)) {
        this.map.removeLayer(this.polyline);
      }

      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
    }

    // Reset UI elements
    this.updateStatus(false, "Disconnected");
    this.updateActiveTripsCount(0);

    if (this.tripMetricsElem) {
      this.tripMetricsElem.innerHTML = "";
    }
  }
}

// Export for global usage
window.LiveTripTracker = LiveTripTracker;
