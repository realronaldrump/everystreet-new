/* global L, notificationManager */
class LiveTripTracker {
  constructor(map) {
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
    this.websocket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 2000; // Start with 2 seconds

    // Updated selectors for the new location in map controls
    this.statusIndicator = document.querySelector(
      "#map-controls .status-indicator",
    );
    this.statusText = document.querySelector("#map-controls .status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.heartbeatTimer = null;
    this.lastHeartbeat = 0;
    this.heartbeatInterval = 30000; // 30 seconds

    // Hook up the focus button if it exists
    const focusButton = document.querySelector("#center-on-active");
    if (focusButton) {
      focusButton.addEventListener("click", () => this.centerOnActiveTrip());
    }

    this.initialize();
  }

  async initialize() {
    try {
      await this.loadInitialTripData();
      this.connectWebSocket();

      // Set up periodic heartbeat check
      this.heartbeatTimer = setInterval(
        () => this.checkHeartbeat(),
        this.heartbeatInterval,
      );
    } catch (error) {
      console.error("LiveTripTracker initialization error:", error);
      if (notificationManager) {
        notificationManager.show(
          "Error initializing live tracking.",
          "warning",
        );
      }
    }
  }

  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");

      if (!response.ok) {
        throw new Error(`Failed to fetch active trip: ${response.status}`);
      }

      const trip = await response.json();

      // Check if this is an active trip with coordinates or an empty placeholder
      if (
        trip &&
        trip.is_active &&
        Array.isArray(trip.coordinates) &&
        trip.coordinates.length > 0
      ) {
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
      } else {
        console.log("No active trip data - this is normal");
        this.clearTrip();
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.error("Error loading initial trip data:", error);
      this.clearTrip();
      this.updateActiveTripsCount(0);

      if (notificationManager) {
        notificationManager.show(
          "Failed to load active trip data.",
          "warning",
          5000,
          true,
        );
      }
    }
  }

  setActiveTrip(trip) {
    this.activeTrip = trip;
    if (
      !trip ||
      !Array.isArray(trip.coordinates) ||
      trip.coordinates.length === 0
    ) {
      this.polyline.setLatLngs([]);
      if (this.map.hasLayer(this.marker)) this.map.removeLayer(this.marker);
      return;
    }

    // Sort coordinates by timestamp and update the polyline and marker
    trip.coordinates.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
    );

    const latLngs = trip.coordinates.map((coord) => [coord.lat, coord.lon]);
    this.polyline.setLatLngs(latLngs);

    const lastPoint = latLngs[latLngs.length - 1];
    if (lastPoint && lastPoint.length === 2) {
      if (!this.map.hasLayer(this.marker)) this.marker.addTo(this.map);
      this.marker.setLatLng(lastPoint);
      this.marker.setOpacity(1);
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
    }
  }

  connectWebSocket() {
    if (this.websocket) {
      // Close existing connection before creating a new one
      try {
        this.websocket.close();
      } catch (err) {
        console.error("Error closing existing WebSocket:", err);
      }
      this.websocket = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;

    try {
      this.websocket = new WebSocket(wsUrl);

      // Track connection time for monitoring initial heartbeat
      this.connectTime = Date.now();

      this.websocket.addEventListener(
        "open",
        this.handleWebSocketOpen.bind(this),
      );
      this.websocket.addEventListener(
        "message",
        this.handleWebSocketMessage.bind(this),
      );
      this.websocket.addEventListener(
        "error",
        this.handleWebSocketError.bind(this),
      );
      this.websocket.addEventListener(
        "close",
        this.handleWebSocketClose.bind(this),
      );

      console.log("WebSocket connection attempt initiated");
    } catch (err) {
      console.error("Error creating WebSocket:", err);
      this.updateStatus(false);
      this.scheduleReconnect();
    }
  }

  handleWebSocketOpen() {
    console.log("WebSocket connection established");
    this.updateStatus(true);
    this.reconnectAttempts = 0;
    this.reconnectDelay = 2000; // Reset delay
    this.lastHeartbeat = Date.now();

    // Request active trip data immediately
    this.requestActiveTripData();
  }

  requestActiveTripData() {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      try {
        this.websocket.send(JSON.stringify({ type: "request_active_trip" }));
      } catch (err) {
        console.error("Error requesting active trip data:", err);
      }
    }
  }

  handleWebSocketMessage(event) {
    try {
      const message = JSON.parse(event.data);

      // Update heartbeat timestamp
      if (message.type === "heartbeat") {
        this.lastHeartbeat = Date.now();
        return;
      }

      this.processWebSocketMessage(message);
    } catch (err) {
      console.error("Error parsing WebSocket message:", err);
    }
  }

  processWebSocketMessage(message) {
    if (!message || !message.type) return;

    switch (message.type) {
      case "trip_update":
        if (
          message.data &&
          message.data.is_active &&
          Array.isArray(message.data.coordinates) &&
          message.data.coordinates.length > 0
        ) {
          this.setActiveTrip(message.data);
          this.updateActiveTripsCount(1);
          console.log(
            "Received active trip update with coordinates:",
            message.data.coordinates.length,
          );
        } else {
          console.log(
            "Received trip update with no active trip - clearing display",
          );
          this.clearTrip();
          this.updateActiveTripsCount(0);
        }
        break;
      case "heartbeat":
        // Update timestamp and make sure no trip is shown
        this.lastHeartbeat = Date.now();
        this.clearTrip();
        this.updateActiveTripsCount(0);
        break;
      case "error":
        console.error("WebSocket error from server:", message.message);
        if (notificationManager) {
          notificationManager.show(
            `Live tracking error: ${message.message}`,
            "warning",
            5000,
            true,
          );
        }
        break;
      default:
        console.warn("Unhandled WebSocket message type:", message.type);
    }
  }

  handleWebSocketError(error) {
    console.error("WebSocket error:", error);
    this.updateStatus(false);
  }

  handleWebSocketClose(event) {
    console.warn(
      `WebSocket closed (code: ${event.code}, reason: ${event.reason})`,
    );
    this.updateStatus(false);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;

      // Exponential backoff with jitter
      const jitter = Math.random() * 1000;
      const delay = Math.min(
        this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1),
        60000,
      );

      console.log(
        `Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay / 1000)}s`,
      );

      setTimeout(() => this.connectWebSocket(), delay + jitter);
    } else {
      console.error("Maximum reconnect attempts reached");
      if (notificationManager) {
        notificationManager.show(
          "Unable to establish live tracking connection. Please reload the page.",
          "danger",
        );
      }
    }
  }

  checkHeartbeat() {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - this.lastHeartbeat;

    // Only check if we've had at least one heartbeat
    if (this.lastHeartbeat > 0) {
      // Log heartbeat status for debugging
      console.log(
        `Last heartbeat was ${Math.round(timeSinceLastHeartbeat / 1000)}s ago`,
      );

      // If we've missed too many heartbeats, reconnect
      if (timeSinceLastHeartbeat > this.heartbeatInterval * 2) {
        console.warn(
          `No heartbeat received for ${Math.round(timeSinceLastHeartbeat / 1000)}s, reconnecting...`,
        );
        this.updateStatus(false);

        if (this.websocket && this.websocket.readyState !== WebSocket.CLOSED) {
          console.log("Closing stale WebSocket connection");
          try {
            this.websocket.close();
          } catch (err) {
            console.error("Error closing WebSocket:", err);
          }
          this.websocket = null;
        }

        // Wait a short moment before reconnecting
        setTimeout(() => {
          console.log("Attempting to reconnect WebSocket");
          this.connectWebSocket();
        }, 500);
      }
    } else {
      console.log("No heartbeat received yet");

      // If we haven't received a heartbeat in a while after connecting, try reconnecting
      if (this.websocket && now - this.connectTime > this.heartbeatInterval) {
        console.warn(
          `No initial heartbeat received after ${Math.round((now - this.connectTime) / 1000)}s, reconnecting...`,
        );
        this.updateStatus(false);

        if (this.websocket) {
          try {
            this.websocket.close();
          } catch (err) {
            console.error("Error closing WebSocket:", err);
          }
          this.websocket = null;
        }

        this.connectWebSocket();
      }
    }
  }

  updateStatus(connected) {
    if (this.statusIndicator) {
      // Ensure we use the correct class names from base.html
      this.statusIndicator.classList.toggle("connected", connected);
      this.statusIndicator.classList.toggle("disconnected", !connected);
    }

    if (this.statusText) {
      this.statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  destroy() {
    // Cleanup method to properly dispose resources
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.map) {
      if (this.map.hasLayer(this.polyline)) {
        this.map.removeLayer(this.polyline);
      }

      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
    }
  }

  clearTrip() {
    this.activeTrip = null;
    this.polyline.setLatLngs([]);
    if (this.map.hasLayer(this.marker)) this.map.removeLayer(this.marker);
  }

  // Add new method to center map on active trip
  centerOnActiveTrip() {
    if (
      this.activeTrip &&
      Array.isArray(this.activeTrip.coordinates) &&
      this.activeTrip.coordinates.length > 0
    ) {
      const latLngs = this.activeTrip.coordinates.map((coord) => [
        coord.lat,
        coord.lon,
      ]);
      if (latLngs.length > 0) {
        // Create a bounds object from the trip coordinates
        const bounds = L.latLngBounds(latLngs);
        // Fit the map to these bounds with some padding
        this.map.fitBounds(bounds, { padding: [30, 30] });
        if (notificationManager) {
          notificationManager.show("Map centered on active trip", "info", 3000);
        }
        return true;
      }
    }

    // If no active trip or no coordinates, show a notification
    if (notificationManager) {
      notificationManager.show("No active trip to focus on", "warning", 3000);
    }
    return false;
  }
}

// Export for use in the global scope
window.LiveTripTracker = LiveTripTracker;
