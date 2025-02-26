/* global L */
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
    this.maxReconnectAttempts = 5;
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");

    this.initialize();
  }

  async initialize() {
    await this.loadInitialTripData();
    this.connectWebSocket();
  }

  async loadInitialTripData() {
    try {
      const response = await fetch("/api/active_trip");
      if (response.ok) {
        const trip = await response.json();
        this.setActiveTrip(trip);
        this.updateActiveTripsCount(1);
      } else {
        console.log(
          `No active trip found - server returned ${response.status}`,
        );
        this.updateActiveTripsCount(0);
      }
    } catch (error) {
      console.log("No active trip available:", error.message);
      this.updateActiveTripsCount(0);
    }
  }

  setActiveTrip(trip) {
    this.activeTrip = trip;
    if (!Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
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
    if (!this.map.hasLayer(this.marker)) this.marker.addTo(this.map);
    this.marker.setLatLng(lastPoint);
    this.marker.setOpacity(1);
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws/live_trip`;
    this.websocket = new WebSocket(wsUrl);

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
      console.warn("WebSocket closed");
      this.updateStatus(false);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connectWebSocket(), 5000);
      } else {
        console.error("Maximum WS reconnect attempts reached.");
      }
    });
  }

  updateStatus(connected) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("connected", connected);
    }
    if (this.statusText) {
      this.statusText.textContent = connected ? "Connected" : "Disconnected";
    }
  }

  handleWebSocketMessage(message) {
    if (!message || !message.type) return;
    switch (message.type) {
      case "trip_update":
        if (message.data) {
          this.setActiveTrip(message.data);
          this.updateActiveTripsCount(1);
        }
        break;
      case "heartbeat":
        this.activeTrip = null;
        this.polyline.setLatLngs([]);
        if (this.map.hasLayer(this.marker)) this.map.removeLayer(this.marker);
        this.updateActiveTripsCount(0);
        break;
      case "error":
        console.error("WebSocket error from server:", message.message);
        break;
      default:
        console.warn("Unhandled WebSocket message type:", message.type);
    }
  }
}

window.LiveTripTracker = LiveTripTracker;
