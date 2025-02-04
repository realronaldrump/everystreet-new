/* global L */

class LiveTripTracker {
  constructor(map) {
    this.map = map;
    this.currentTrip = null;
    this.websocket = null;
    this.polyline = null;
    this.marker = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.localCoords = [];

    // Status elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCount = document.querySelector("#active-trips-count");
    this.tripMetrics = document.querySelector(".live-trip-metrics");

    this.config = {
      polyline: { color: "#00FF00", weight: 3, opacity: 0.8 },
      marker: {
        icon: L.divIcon({
          className: "vehicle-marker",
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
      },
    };

    this.initialize();
  }

  initialize() {
    this.polyline = L.polyline([], this.config.polyline).addTo(this.map);
    this.marker = L.marker([0, 0], { icon: this.config.marker.icon }).addTo(this.map);
    this.marker.setOpacity(0);
    this.localCoords = [];
    this.loadInitialTripData();
    this.connectWebSocket();
  }

  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");
      if (!response.ok) {
        console.error("Failed to fetch initial trip data:", response.statusText);
        return;
      }
      const data = await response.json();
      if (data && data.transactionId && data.coordinates) {
        this.updateActiveTripsCount(1);  // Active trip exists
        this.handleTripUpdate(data);
      } else {
        console.log("No active trip data found on server.");
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.error("Error fetching initial trip data:", error);
    }
  }

  updateStatus(connected) {
    if (this.statusIndicator && this.statusText) {
      this.statusIndicator.classList.toggle("connected", connected);
      this.statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCount) {
      this.activeTripsCount.textContent = count;
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;
    if (this.websocket) {
      this.websocket.close();
    }
    this.websocket = new WebSocket(wsUrl);

    this.websocket.onopen = () => {
      console.log("WebSocket connection established");
      this.updateStatus(true);
      this.reconnectAttempts = 0;
    };

    this.websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleUpdate(data);
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    };

    this.websocket.onerror = (error) => {
      console.error("WebSocket error:", error);
      this.updateStatus(false);
    };

    this.websocket.onclose = () => {
      console.warn("WebSocket closed, attempting to reconnect...");
      this.updateStatus(false);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), 5000);
      } else {
        console.error("Max WebSocket reconnection attempts reached.");
      }
    };
  }

  handleUpdate(data) {
    if (!data || !data.type) return;
    switch (data.type) {
      case "trip_update":
        this.updateActiveTripsCount(1);  // An active trip exists
        this.handleTripUpdate(data.data);
        break;
      case "heartbeat":
        this.updateActiveTripsCount(0);  // No active trip
        break;
      case "error":
        console.error("WebSocket server error:", data.message);
        break;
      case "connected":
        console.log("WebSocket: Connected");
        break;
      default:
        console.log("Unhandled WebSocket message type:", data.type);
    }
  }

  handleTripUpdate(tripData) {
    if (!tripData || !tripData.coordinates || !tripData.coordinates.length) return;
    this.currentTrip = tripData.transactionId;
    if (!this.localCoords) {
      this.localCoords = [];
    }
    const existingKeys = new Set(
      this.localCoords.map(
        (c) => `${c.timestamp}-${c.lat.toFixed(6)}-${c.lon.toFixed(6)}`
      )
    );
    const newPoints = [];
    for (const c of tripData.coordinates) {
      if (!c.timestamp || c.lat == null || c.lon == null) continue;
      const key = `${c.timestamp}-${c.lat.toFixed(6)}-${c.lon.toFixed(6)}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        newPoints.push(c);
      }
    }
    if (newPoints.length) {
      this.localCoords = this.localCoords.concat(newPoints);
      this.localCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
    const latLngs = this.localCoords.map((coord) => [coord.lat, coord.lon]);
    this.polyline.setLatLngs(latLngs);
    const lastPos = latLngs[latLngs.length - 1];
    this.marker.setLatLng(lastPos);
    this.marker.setOpacity(1);
  }
}