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
    
    // Updated selectors to ensure we get the right elements
    this.statusIndicator = document.querySelector(".live-tracking-status .status-indicator");
    this.statusText = document.querySelector(".live-tracking-status .status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.heartbeatTimer = null;
    this.lastHeartbeat = 0;
    this.heartbeatInterval = 30000; // 30 seconds

    this.initialize();
  }

  async initialize() {
    try {
      await this.loadInitialTripData();
      this.connectWebSocket();
      
      // Set up periodic heartbeat check
      this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), this.heartbeatInterval);
    } catch (error) {
      console.error("LiveTripTracker initialization error:", error);
      if (notificationManager) {
        notificationManager.show("Error initializing live tracking.", "warning");
      }
    }
  }

  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");
      
      if (response.status === 404) {
        console.log("No active trip found - this is normal");
        this.clearTrip();
        this.updateActiveTripsCount(0);
        return;
      }
      
      if (!response.ok) {
        throw new Error(`Failed to fetch active trip: ${response.status}`);
      }
      
      const trip = await response.json();
      
      // Make sure we have valid coordinates before setting as active
      if (trip && Array.isArray(trip.coordinates) && trip.coordinates.length > 0) {
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
      } else {
        console.log("Trip data has no valid coordinates - treating as no active trip");
        this.clearTrip();
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      if (error.message.includes("404")) {
        console.log("No active trip available - this is normal");
        this.clearTrip();
        this.updateActiveTripsCount(0);
      } else {
        console.error("Error loading initial trip data:", error);
        this.clearTrip();
        this.updateActiveTripsCount(0);
        if (notificationManager) {
          notificationManager.show("Failed to load active trip data.", "warning", 5000, true);
        }
      }
    }
  }

  setActiveTrip(trip) {
    this.activeTrip = trip;
    if (!trip || !Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
      this.polyline.setLatLngs([]);
      if (this.map.hasLayer(this.marker)) this.map.removeLayer(this.marker);
      return;
    }
    
    // Sort coordinates by timestamp and update the polyline and marker
    trip.coordinates.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
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
      this.websocket.close();
      this.websocket = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;
    
    try {
      this.websocket = new WebSocket(wsUrl);
      
      this.websocket.addEventListener("open", this.handleWebSocketOpen.bind(this));
      this.websocket.addEventListener("message", this.handleWebSocketMessage.bind(this));
      this.websocket.addEventListener("error", this.handleWebSocketError.bind(this));
      this.websocket.addEventListener("close", this.handleWebSocketClose.bind(this));
      
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
        if (message.data && Array.isArray(message.data.coordinates) && message.data.coordinates.length > 0) {
          this.setActiveTrip(message.data);
          this.updateActiveTripsCount(1);
        } else {
          console.log("Trip update with invalid data - clearing trip");
          this.clearTrip();
          this.updateActiveTripsCount(0);
        }
        break;
      case "heartbeat":
        // Just update the timestamp, no active trip
        this.clearTrip();
        this.updateActiveTripsCount(0);
        break;
      case "error":
        console.error("WebSocket error from server:", message.message);
        if (notificationManager) {
          notificationManager.show(`Live tracking error: ${message.message}`, "warning", 5000, true);
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
    console.warn(`WebSocket closed (code: ${event.code}, reason: ${event.reason})`);
    this.updateStatus(false);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      
      // Exponential backoff with jitter
      const jitter = Math.random() * 1000;
      const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 60000);
      
      console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay/1000)}s`);
      
      setTimeout(() => this.connectWebSocket(), delay + jitter);
    } else {
      console.error("Maximum reconnect attempts reached");
      if (notificationManager) {
        notificationManager.show("Unable to establish live tracking connection. Please reload the page.", "danger");
      }
    }
  }

  checkHeartbeat() {
    const now = Date.now();
    const timeSinceLastHeartbeat = now - this.lastHeartbeat;
    
    if (this.lastHeartbeat > 0 && timeSinceLastHeartbeat > this.heartbeatInterval * 2) {
      console.warn(`No heartbeat received for ${Math.round(timeSinceLastHeartbeat/1000)}s, reconnecting...`);
      
      if (this.websocket) {
        this.websocket.close();
        this.websocket = null;
      }
      
      this.connectWebSocket();
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
}

// Export for use in the global scope
window.LiveTripTracker = LiveTripTracker;
