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

    // Calculate duration
    const startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const duration =
      startTime && lastUpdate ? Math.floor((lastUpdate - startTime) / 1000) : 0;
    const hours = Math.floor(duration / 3600);
    const minutes = Math.floor((duration % 3600) / 60);
    const seconds = duration % 60;
    const durationStr = `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    // Calculate distance and speeds
    const coordinates = trip.coordinates || [];
    const distance = this.calculateTripDistance(coordinates);
    const currentSpeed = this.calculateCurrentSpeed(coordinates);
    const avgSpeed = duration > 0 ? distance / (duration / 3600) : 0;
    const maxSpeed = this.calculateMaxSpeed(coordinates);

    // Format metrics for display
    const metrics = {
      "Start Time": startTime ? startTime.toLocaleString() : "N/A",
      Duration: durationStr,
      Distance: `${distance.toFixed(2)} miles`,
      "Current Speed": `${currentSpeed.toFixed(1)} mph`,
      "Average Speed": `${avgSpeed.toFixed(1)} mph`,
      "Max Speed": `${maxSpeed.toFixed(1)} mph`,
      "Points Recorded": coordinates.length,
    };

    // Update the UI
    this.tripMetricsElem.innerHTML = Object.entries(metrics)
      .map(
        ([label, value]) => `<div class="metric-row">
        <span class="metric-label">${label}:</span>
        <span class="metric-value">${value}</span>
      </div>`
      )
      .join("");
  }

  /**
   * Calculate total trip distance from coordinates
   * @param {Array} coordinates - Array of coordinate objects
   * @returns {number} - Distance in miles
   */
  calculateTripDistance(coordinates) {
    if (!coordinates || coordinates.length < 2) return 0;

    let totalDistance = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const prev = coordinates[i - 1];
      const curr = coordinates[i];
      totalDistance += this.calculateDistance(
        prev.lat,
        prev.lon,
        curr.lat,
        curr.lon
      );
    }
    return totalDistance;
  }

  /**
   * Calculate distance between two points using Haversine formula
   * @param {number} lat1 - Latitude of point 1
   * @param {number} lon1 - Longitude of point 1
   * @param {number} lat2 - Latitude of point 2
   * @param {number} lon2 - Longitude of point 2
   * @returns {number} - Distance in miles
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Calculate current speed from recent coordinates
   * @param {Array} coordinates - Array of coordinate objects
   * @returns {number} - Speed in mph
   */
  calculateCurrentSpeed(coordinates) {
    if (!coordinates || coordinates.length < 2) return 0;

    // Use last two points to calculate current speed
    const last = coordinates[coordinates.length - 1];
    const prev = coordinates[coordinates.length - 2];

    const distance = this.calculateDistance(
      prev.lat,
      prev.lon,
      last.lat,
      last.lon
    );

    const timeDiff =
      (new Date(last.timestamp) - new Date(prev.timestamp)) / 1000 / 3600;
    return timeDiff > 0 ? distance / timeDiff : 0;
  }

  /**
   * Calculate maximum speed from coordinates
   * @param {Array} coordinates - Array of coordinate objects
   * @returns {number} - Speed in mph
   */
  calculateMaxSpeed(coordinates) {
    if (!coordinates || coordinates.length < 2) return 0;

    let maxSpeed = 0;
    for (let i = 1; i < coordinates.length; i++) {
      const prev = coordinates[i - 1];
      const curr = coordinates[i];

      const distance = this.calculateDistance(
        prev.lat,
        prev.lon,
        curr.lat,
        curr.lon
      );

      const timeDiff =
        (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000 / 3600;
      const speed = timeDiff > 0 ? distance / timeDiff : 0;
      maxSpeed = Math.max(maxSpeed, speed);
    }
    return maxSpeed;
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
