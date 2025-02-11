/* global L */

class LiveTripTracker {
  constructor(map) {
    // The Leaflet map instance
    this.map = map;

    // We store the entire active trip object returned by /api/active_trip,
    // e.g. { transactionId, status, startTime, endTime?, coordinates: [...], ... }
    this.activeTrip = null;

    // Create our polyline in Leaflet
    this.polyline = L.polyline([], {
      color: "#00FF00",
      weight: 3,
      opacity: 0.8
    }).addTo(this.map);

    // Create the marker but *do not* add it to the map here
    this.marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "vehicle-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    });
    // Note: we skip .addTo(this.map) in the constructor

    // WebSocket & reconnection logic
    this.websocket = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // UI elements: status indicator, status text, and active trips count
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");

    // Kick off initialization
    this.initialize();
  }

  async initialize() {
    // Step 1: Fetch any currently active trip from /api/active_trip
    await this.loadInitialTripData();
    // Step 2: Open a WebSocket to receive live trip updates
    this.connectWebSocket();
  }

  /**
   * Hit /api/active_trip to see if there's an active trip on the server
   */
  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");
      if (response.ok) {
        const trip = await response.json();
        
        // Set the trip (this draws the polyline & marker)
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
      } else {
        
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.error("Error loading initial active trip:", error);
      this.updateActiveTripsCount(0);
    }
  }

  /**
   * Store the active trip object in memory and render it
   */
  setActiveTrip(trip) {
    this.activeTrip = trip;

    // If 'trip.coordinates' doesn't exist or is empty => clear
    if (!Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
      this.polyline.setLatLngs([]);
      // Remove marker if it's on the map
      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
      return;
    }

    // Sort coordinates by timestamp (ISO date strings)
    trip.coordinates.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Convert them to Leaflet lat/lon pairs
    const latLngs = trip.coordinates.map(coord => [coord.lat, coord.lon]);
    this.polyline.setLatLngs(latLngs);

    // Move the marker to the last coordinate
    const lastPoint = latLngs[latLngs.length - 1];

    // If the marker isn't already on the map, add it
    if (!this.map.hasLayer(this.marker)) {
      this.marker.addTo(this.map);
    }
    this.marker.setLatLng(lastPoint);
    this.marker.setOpacity(1);  // Make sure it's visible
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
    }
  }

  connectWebSocket() {
    // Decide between ws:// or wss:// based on the current page
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;
    

    this.websocket = new WebSocket(wsUrl);

    this.websocket.onopen = () => {
      
      this.updateStatus(true);
      this.reconnectAttempts = 0;
    };

    this.websocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleWebSocketMessage(message);
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    this.websocket.onerror = (err) => {
      console.error("WebSocket error:", err);
      this.updateStatus(false);
    };

    this.websocket.onclose = () => {
      console.warn("WebSocket closed");
      this.updateStatus(false);
      // Attempt reconnect up to a certain limit
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), 5000);
      } else {
        console.error("Maximum WS reconnect attempts reached.");
      }
    };
  }

  updateStatus(connected) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("connected", connected);
    }
    if (this.statusText) {
      this.statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  /**
   * Respond to messages from the server – we expect the server to send:
   *  { "type": "trip_update", "data": {...} }
   *    or
   *  { "type": "heartbeat" }
   *    or
   *  { "type": "error", "message": "..."}
   */
  handleWebSocketMessage(message) {
    if (!message || !message.type) return;
    const { type } = message;

    if (type === "trip_update") {
      // There's an active trip => re-render it
      if (message.data) {
        
        this.setActiveTrip(message.data);
        this.updateActiveTripsCount(1);
      }
    } else if (type === "heartbeat") {
      // Means no trip is currently active => clear the map
      
      this.activeTrip = null;
      this.polyline.setLatLngs([]);
      // Remove marker from map if present
      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
      this.updateActiveTripsCount(0);
    } else if (type === "error") {
      console.error("WebSocket error from server:", message.message);
    } else {
      console.warn("Unhandled WebSocket message type:", type);
    }
  }
}

// Expose for global usage (e.g. window.liveTracker = new LiveTripTracker(map))
window.LiveTripTracker = LiveTripTracker;