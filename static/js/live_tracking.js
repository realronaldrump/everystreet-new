/* global L, io, loadingManager, updateLoadingProgress, hideLoadingOverlay */

class LiveTripTracker {
  constructor(map) {
    if (!map || typeof map.addLayer !== "function") {
      throw new Error("Invalid map object provided to LiveTripTracker.");
    }

    this.map = map;
    this.activeTrips = new Map(); // Tracks active trips using transactionId as key
    this.liveTripsLayer = L.layerGroup().addTo(map); // Layer for live trip polylines
    this.vehicleMarkersLayer = L.layerGroup().addTo(map); // Separate layer for vehicle markers

    // Cache DOM elements for status display
    this.statusIndicator = document.querySelector(".status-indicator");
    this.activeTripsCount = document.querySelector(".active-trips-count");
    this.statusText = document.querySelector(".status-text");

    // Connect to Socket.IO for real-time updates
    this.connectToSocket();
    this.updateStatusDisplay(); // Initial status update
  }

  connectToSocket() {
    try {
      // Establish Socket.IO connection with explicit path
      this.socket = io({ path: "/socket.io" });

      // Handle connection events
      this.socket.on("connect", () => {
        console.log("Socket.IO connected.");
        this.updateConnectionStatus(true);
      });

      this.socket.on("disconnect", () => {
        console.warn("Socket.IO disconnected.");
        this.updateConnectionStatus(false);
      });

      // Handle trip-related events
      this.socket.on("trip_started", (data) => this.handleTripStart(data));
      this.socket.on("trip_update", (data) => this.handleTripUpdate(data));
      this.socket.on("trip_ended", (data) => this.handleTripEnd(data));
    } catch (error) {
      console.error("Error with Socket.IO:", error);
      this.updateConnectionStatus(false);
    }
  }

  updateConnectionStatus(isConnected) {
    if (this.statusIndicator) {
      this.statusIndicator.classList.toggle("active", isConnected);
    }
    if (this.statusText) {
      this.statusText.textContent = isConnected
        ? "Live Tracking Connected"
        : "Live Tracking Disconnected";
    }
  }

  handleTripStart(data) {
    const tripId = data.transactionId;
    console.log(`Trip started: ${tripId}`);

    // Initialize a new trip object
    this.activeTrips.set(tripId, {
      polyline: L.polyline([], {
        color: "#00f7ff", // Bright blue for active trip
        weight: 4, // Slightly thicker line
        opacity: 0.8,
        className: "active-trip",
      }).addTo(this.liveTripsLayer),
      coordinates: [],
      timestamps: [],
      startTime: new Date(data.start_time),
      vehicleMarker: null, // Placeholder for the vehicle marker
    });

    this.updateStatusDisplay();
  }

  handleTripUpdate(data) {
    const tripId = data.transactionId;
    const trip = this.activeTrips.get(tripId);

    if (!trip) {
      console.warn(`Trip update received for unknown trip ID: ${tripId}`);
      return;
    }

    // Add new coordinates and timestamps
    data.path.forEach((point) => {
      if (point.gps?.lat && point.gps.lon) {
        const timestamp = point.timestamp ? new Date(point.timestamp) : new Date();
        trip.coordinates.push([point.gps.lat, point.gps.lon]);
        trip.timestamps.push(timestamp);
      }
    });

    // Sort coordinates by timestamp to maintain correct order
    const sortedData = trip.coordinates
      .map((coord, index) => ({ coord, timestamp: trip.timestamps[index] }))
      .sort((a, b) => a.timestamp - b.timestamp);

    trip.coordinates = sortedData.map((item) => item.coord);
    trip.polyline.setLatLngs(trip.coordinates);

    // Update or create vehicle marker
    if (trip.coordinates.length > 0) {
      const lastCoord = trip.coordinates[trip.coordinates.length - 1];
      this.updateVehicleMarker(tripId, lastCoord);
      this.map.panTo(lastCoord);
    }
  }

  updateVehicleMarker(tripId, position) {
    const trip = this.activeTrips.get(tripId);
    if (!trip) return;

    const vehicleIcon = L.divIcon({
      className: "vehicle-marker",
      html: '<i class="fas fa-car"></i>', // Use a suitable icon
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    if (!trip.vehicleMarker) {
      // Create a new marker if it doesn't exist
      trip.vehicleMarker = L.marker(position, { icon: vehicleIcon }).addTo(this.vehicleMarkersLayer);
    } else {
      // Update the existing marker's position
      trip.vehicleMarker.setLatLng(position);
    }
  }

  handleTripEnd(data) {
    const tripId = data.transactionId;
    const trip = this.activeTrips.get(tripId);

    if (!trip) {
      console.warn(`Trip end event received for unknown trip ID: ${tripId}`);
      return;
    }

    // Add a marker at the end of the trip
    if (trip.coordinates.length > 0) {
      const endPoint = trip.coordinates[trip.coordinates.length - 1];
      L.marker(endPoint, {
        icon: L.divIcon({
          className: "trip-marker trip-end",
          html: '<i class="fas fa-flag-checkered"></i>',
          iconSize: [20, 20],
          iconAnchor: [10, 20],
        }),
      }).addTo(this.liveTripsLayer);
    }

    // Remove the vehicle marker from the map
    if (trip.vehicleMarker) {
      this.vehicleMarkersLayer.removeLayer(trip.vehicleMarker);
    }

    // Change the style of the polyline to indicate the trip has ended
    trip.polyline.setStyle({
      color: "#0066cc", // Darker blue for ended trip
      opacity: 0.6,
      weight: 2,
      className: "", // Remove the active-trip class
    });

    // Remove the trip from active trips
    this.activeTrips.delete(tripId);
    this.updateStatusDisplay();
  }

  updateStatusDisplay() {
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
    this.vehicleMarkersLayer.clearLayers();
    this.activeTrips.clear();
    this.updateStatusDisplay();

    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

// Initialize the LiveTripTracker when the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const checkMapInterval = setInterval(() => {
    if (window.EveryStreet && window.EveryStreet.map) {
      clearInterval(checkMapInterval);
      try {
          window.liveTracker = new LiveTripTracker(window.EveryStreet.map);
      } catch (error) {
          console.error("Error initializing LiveTripTracker:", error);
      }
    }
  }, 100);

  // Prevent memory leaks by clearing the interval after a timeout
  setTimeout(() => clearInterval(checkMapInterval), 10000); // 10 seconds timeout
});

// Ensure this script is imported after Leaflet and Socket.IO are loaded in your HTML.

// Expose the LiveTripTracker class globally for use in other scripts if needed
window.LiveTripTracker = LiveTripTracker;