/* global L */

class LiveTripTracker {
  constructor(map) {
    this.map = map;
    // This will hold the active trip document (if any)
    this.activeTrip = null;
    // Leaflet layers for drawing the trip path and current position
    this.polyline = null;
    this.marker = null;
    // WebSocket connection
    this.websocket = null;
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // UI elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");

    // Initialize map layers (polyline and marker)
    this.initMapLayers();
    // Begin live tracking
    this.initialize();
  }

  initMapLayers() {
    // Create a polyline with your preferred styling
    this.polyline = L.polyline([], { color: "#00FF00", weight: 3, opacity: 0.8 }).addTo(this.map);
    // Create a marker with a custom divIcon (adjust size and style as needed)
    this.marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "vehicle-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      })
    }).addTo(this.map);
    // Hide the marker until we have a valid coordinate
    this.marker.setOpacity(0);
  }

  async initialize() {
    // First, load any active trip from the server
    await this.loadInitialTripData();
    // Then, connect to the WebSocket for live updates
    this.connectWebSocket();
  }

  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");
      if (response.ok) {
        const trip = await response.json();
        console.log("Loaded active trip:", trip.transactionId);
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
      } else {
        console.log("No active trip found on server.");
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.error("Error loading active trip:", error);
      this.updateActiveTripsCount(0);
    }
  }

  setActiveTrip(trip) {
    this.activeTrip = trip;
    if (trip && Array.isArray(trip.coordinates) && trip.coordinates.length > 0) {
      // Ensure coordinates are sorted by timestamp
      trip.coordinates.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      // Build an array of Leaflet LatLng pairs
      const latLngs = trip.coordinates.map(coord => [coord.lat, coord.lon]);
      this.polyline.setLatLngs(latLngs);
      // Move the marker to the last coordinate
      const lastPoint = latLngs[latLngs.length - 1];
      this.marker.setLatLng(lastPoint);
      this.marker.setOpacity(1);
    } else {
      // No coordinates: clear the polyline and hide the marker
      this.polyline.setLatLngs([]);
      this.marker.setOpacity(0);
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;
    console.log("Connecting to WebSocket at", wsUrl);
    this.websocket = new WebSocket(wsUrl);

    this.websocket.onopen = () => {
      console.log("WebSocket connection established");
      this.updateStatus(true);
      this.reconnectAttempts = 0;
    };

    this.websocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        console.error("Error parsing WebSocket message:", err);
      }
    };

    this.websocket.onerror = (err) => {
      console.error("WebSocket error:", err);
      this.updateStatus(false);
    };

    this.websocket.onclose = () => {
      console.warn("WebSocket connection closed");
      this.updateStatus(false);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), 5000);
      } else {
        console.error("Maximum WebSocket reconnection attempts reached");
      }
    };
  }

  updateStatus(connected) {
    if (this.statusIndicator && this.statusText) {
      this.statusIndicator.classList.toggle("connected", connected);
      this.statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  handleMessage(message) {
    // Your Python backend sends messages with a "type" field.
    // Expected messages:
    //   { "type": "trip_update", "data": { ...active trip object... } }
    //   { "type": "heartbeat" }
    if (!message || !message.type) return;

    if (message.type === "trip_update") {
      // An active trip exists. Update the displayed trip.
      if (message.data) {
        console.log("Received trip_update for transaction", message.data.transactionId);
        this.setActiveTrip(message.data);
        this.updateActiveTripsCount(1);
      }
    } else if (message.type === "heartbeat") {
      // No active trip is in progress.
      console.log("Received heartbeat – no active trip");
      this.activeTrip = null;
      this.polyline.setLatLngs([]);
      this.marker.setOpacity(0);
      this.updateActiveTripsCount(0);
    } else if (message.type === "error") {
      console.error("Error from server:", message.message);
    } else {
      console.warn("Unhandled message type:", message.type);
    }
  }
}

// Expose the LiveTripTracker class globally so that your app.js can instantiate it.
window.LiveTripTracker = LiveTripTracker;