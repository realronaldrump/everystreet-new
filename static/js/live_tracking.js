/* global L, io */

class LiveTripTracker {
  constructor(map) {
    if (!map || typeof map.addLayer !== "function") {
      throw new Error("Invalid map object for LiveTripTracker");
    }

    this.map = map;
    this.activeTrips = new Map(); // Store active trips by transactionId
    this.liveTripsLayer = L.layerGroup().addTo(map);

    this.statusIndicator = document.querySelector(".status-indicator");
    this.activeTripsCount = document.querySelector(".active-trips-count");
    this.statusText = document.querySelector(".status-text");
    this.metricsContainer = document.querySelector(".live-trip-metrics");

    this.connectToSocket(); // Initialize Socket.IO connection here
    this.updateStatus();
  }

  connectToSocket() {
    try {
      this.socket = io(); // Create Socket.IO connection
      this.socket.on("connect", () => this.updateConnectionStatus(true));
      this.socket.on("disconnect", () => this.updateConnectionStatus(false));
      this.socket.on("trip_started", (data) => this.handleTripStart(data));
      this.socket.on("trip_update", (data) => this.handleTripUpdate(data));
      this.socket.on("trip_ended", (data) => this.handleTripEnd(data));
    } catch (error) {
      console.error("Error connecting to WebSocket:", error);
      this.updateConnectionStatus(false);
    }
  }

  updateConnectionStatus(connected) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("active", connected);
    }
    if (this.statusText) {
      this.statusText.textContent = connected
        ? "Live Tracking Connected"
        : "Live Tracking Disconnected";
    }
  }

  handleTripStart(data) {
    const tripId = data.transactionId;
    const startTime = new Date(data.start_time);

    const trip = {
      polyline: L.polyline([], {
        color: "#00f7ff", // Bright blue for active trip
        weight: 3,         // Slightly thicker line
        opacity: 0.8,
        className: "active-trip",
      }).addTo(this.liveTripsLayer),
      coordinates: [],
      timestamps: [], // To store timestamps along with coordinates
      startTime: startTime,
      vehicleMarker: null,
    };

    this.activeTrips.set(tripId, trip);
    this.updateStatus();
    console.log(`Trip started: ${tripId}`);
  }

  handleTripUpdate(data) {
      const tripId = data.transactionId;
      const trip = this.activeTrips.get(tripId);

      if (!trip) {
          console.warn(`Trip ${tripId} not found for update.`);
          return;
      }

      // Add new coordinates with their timestamps
      data.path.forEach(point => {
          if (point.gps?.lat && point.gps.lon) {
              // Assuming the timestamp is available in each point under a 'timestamp' field
              const timestamp = point.timestamp ? new Date(point.timestamp) : new Date();
              trip.coordinates.push([point.gps.lat, point.gps.lon]);
              trip.timestamps.push(timestamp);
          }
      });

      // Sort coordinates by timestamp
      const sortedData = trip.coordinates.map((coord, index) => ({
          coord,
          timestamp: trip.timestamps[index]
      })).sort((a, b) => a.timestamp - b.timestamp);

      trip.coordinates = sortedData.map(item => item.coord);
      trip.polyline.setLatLngs(trip.coordinates);

      // Update or create the vehicle marker
      if (trip.coordinates.length > 0) {
          const lastCoord = trip.coordinates[trip.coordinates.length - 1];
          this.updateVehicleMarker(tripId, lastCoord);
          this.map.panTo(lastCoord);
      }
  }

  updateVehicleMarker(tripId, position) {
    const trip = this.activeTrips.get(tripId);
    if (!trip) return;
  
    if (!trip.vehicleMarker) {
      // Create a div element for the marker
      const markerElement = document.createElement('div');
      markerElement.className = 'vehicle-marker';
  
      // Create the marker with the div element as its icon
      trip.vehicleMarker = L.marker([position[0], position[1]], {
        icon: L.divIcon({
          html: markerElement,
          className: 'custom-vehicle-marker', // Add a custom class for any additional styling
          iconSize: [12, 12], // Adjust size as needed
          iconAnchor: [6, 6], // Center the icon
        }),
      }).addTo(this.liveTripsLayer);
    } else {
      trip.vehicleMarker.setLatLng([position[0], position[1]]);
    }
  }

  handleTripEnd(data) {
    const tripId = data.transactionId;
    const trip = this.activeTrips.get(tripId);

    if (!trip) {
      console.warn(`Trip ${tripId} not found for ending.`);
      return;
    }

    // Remove the trip from the active trips map
    this.activeTrips.delete(tripId);

    // Optionally, add a marker at the end of the trip
    if (trip.coordinates.length > 0) {
      const endPoint = trip.coordinates[trip.coordinates.length - 1];
      L.marker([endPoint[0], endPoint[1]], {
        icon: L.divIcon({
          className: "trip-marker trip-end",
          html: '<i class="fas fa-flag-checkered"></i>',
        }),
      }).addTo(this.liveTripsLayer);
    }

    // Remove the vehicle marker
    if (trip.vehicleMarker) {
      this.liveTripsLayer.removeLayer(trip.vehicleMarker);
    }

    // Change the style of the polyline to indicate the trip has ended
    trip.polyline.setStyle({
        color: "#0066cc", // Darker blue for ended trip
        opacity: 0.6,
        weight: 2
    });

    this.updateStatus();
  }

  updateStatus() {
    const activeCount = this.activeTrips.size;
    if (this.activeTripsCount) {
      this.activeTripsCount.textContent = activeCount;
    }
    if (this.statusText) {
      this.statusText.textContent =
        activeCount > 0
          ? `Tracking ${activeCount} active trip${activeCount !== 1 ? "s" : ""}`
          : "No active trips";
    }
  }

  cleanup() {
    this.liveTripsLayer.clearLayers();
    this.activeTrips.clear();
    this.updateStatus();

    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

// If you need to make the class globally accessible
window.LiveTripTracker = LiveTripTracker;