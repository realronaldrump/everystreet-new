/* global L */
/**
 * LiveTripTracker - Tracks and visualizes real-time vehicle location using polling
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

    // Polling state
    this.lastSequence = 0;
    this.pollingInterval = 2000; // Start with 2 seconds
    this.maxPollingInterval = 10000; // Max 10 seconds
    this.minPollingInterval = 1000; // Min 1 second
    this.pollingTimerId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPolling = false;

    // UI elements
    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.tripMetricsElem = document.querySelector(".live-trip-metrics");
    this.errorMessageElem = document.querySelector(".error-message");

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
      this.startPolling();

      // Handle page visibility changes to adjust polling
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.decreasePollingInterval(); // Speed up polling when page is visible
        } else {
          this.increasePollingInterval(); // Slow down polling when page is hidden
        }
      });

      // Cleanup on page unload
      window.addEventListener("beforeunload", () => {
        this.stopPolling();
      });
    } catch (error) {
      console.error("LiveTripTracker initialization error:", error);
      this.updateStatus(false);
      this.showError("Failed to initialize tracker. Will retry shortly.");
      setTimeout(() => this.initialize(), 5000);
    }
  }

  /**
   * Load initial trip data from API
   * @async
   */
  async loadInitialTripData() {
    try {
      console.log("Loading initial trip data");
      const response = await fetch("/api/active_trip");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log("Initial trip data response:", data);

      if (data.status === "success") {
        if (data.has_active_trip && data.trip) {
          console.log(
            `Found active trip: ${data.trip.transactionId} with sequence: ${data.trip.sequence}`
          );
          this.setActiveTrip(data.trip);
          this.updateActiveTripsCount(1);
          this.updateTripMetrics(data.trip);
          this.lastSequence = data.trip.sequence || 0;
          this.updateStatus(true);
        } else {
          console.log("No active trips found during initialization");
          this.updateStatus(true, "No active trips");
          this.updateActiveTripsCount(0);
        }
      } else {
        throw new Error(data.message || "Error loading initial trip data");
      }
    } catch (error) {
      console.error("Error loading initial trip data:", error);
      this.updateStatus(false, "Failed to load trip data");
      this.showError("Failed to load trip data: " + error.message);
      throw error;
    }
  }

  /**
   * Start polling for trip updates
   */
  startPolling() {
    if (this.isPolling) return;

    this.isPolling = true;
    this.poll();
    console.log(
      `LiveTripTracker: Started polling (${this.pollingInterval}ms interval)`
    );
  }

  /**
   * Stop polling for trip updates
   */
  stopPolling() {
    if (this.pollingTimerId) {
      clearTimeout(this.pollingTimerId);
      this.pollingTimerId = null;
    }
    this.isPolling = false;
    console.log("LiveTripTracker: Stopped polling");
  }

  /**
   * Poll the server for trip updates
   * @async
   */
  async poll() {
    if (!this.isPolling) return;

    try {
      console.log(`Polling for updates since sequence: ${this.lastSequence}`);
      await this.fetchTripUpdates();

      // Success, reset error counter
      this.consecutiveErrors = 0;

      // Speed up polling when we receive data
      if (this.activeTrip) {
        this.decreasePollingInterval();
      }
    } catch (error) {
      console.error("Error polling trip updates:", error);
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        // Too many consecutive errors, show status
        this.updateStatus(false, "Connection lost");
        this.showError("Connection lost. Retrying...");
        // Increase interval when facing errors
        this.increasePollingInterval();
      }
    } finally {
      // Schedule next poll with current interval
      this.pollingTimerId = setTimeout(() => {
        this.poll();
      }, this.pollingInterval);
    }
  }

  /**
   * Fetch trip updates from the server
   * @async
   */
  async fetchTripUpdates() {
    console.log(
      `Fetching trip updates with last_sequence=${this.lastSequence}`
    );

    const response = await fetch(
      `/api/trip_updates?last_sequence=${this.lastSequence}`
    );

    if (!response.ok) {
      console.error(`HTTP error: ${response.status}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log("Trip update response:", data);

    if (data.status === "success") {
      if (data.has_update && data.trip) {
        // We have new trip data
        console.log(
          `Received trip update with sequence: ${data.trip.sequence}`
        );
        this.setActiveTrip(data.trip);
        this.updateActiveTripsCount(1);
        this.updateTripMetrics(data.trip);
        this.lastSequence = data.trip.sequence || this.lastSequence;
        this.updateStatus(true);
        this.hideError();
      } else if (this.activeTrip && !data.has_update) {
        // No new updates for existing trip - keep current display
        console.log("No new updates for current trip");
        this.updateStatus(true);
      } else if (!this.activeTrip && !data.has_update) {
        // No active trip at all
        console.log("No active trips found");
        this.clearActiveTrip();
        this.updateActiveTripsCount(0);
        this.updateStatus(true, "No active trips");
      }
    } else {
      console.error(`API error: ${data.message || "Unknown error"}`);
      throw new Error(data.message || "Unknown error fetching trip updates");
    }
  }

  /**
   * Increase polling interval (slow down) with backoff
   */
  increasePollingInterval() {
    this.pollingInterval = Math.min(
      this.pollingInterval * 1.5,
      this.maxPollingInterval
    );
    console.log(
      `LiveTripTracker: Increased polling interval to ${this.pollingInterval}ms`
    );
  }

  /**
   * Decrease polling interval (speed up) for more responsive updates
   */
  decreasePollingInterval() {
    this.pollingInterval = Math.max(
      this.pollingInterval * 0.8,
      this.minPollingInterval
    );
    console.log(
      `LiveTripTracker: Decreased polling interval to ${this.pollingInterval}ms`
    );
  }

  /**
   * Update connection status UI
   * @param {boolean} connected - Whether connection is established
   * @param {string} [message] - Optional status message
   */
  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) return;

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);
    this.statusIndicator.setAttribute(
      "aria-label",
      connected ? "Connected" : "Disconnected"
    );

    this.statusText.textContent =
      message || (connected ? "Connected" : "Disconnected");
  }

  /**
   * Show error message
   * @param {string} message - Error message to display
   */
  showError(message) {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.textContent = message;
    this.errorMessageElem.classList.remove("d-none");
  }

  /**
   * Hide error message
   */
  hideError() {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.classList.add("d-none");
  }

  /**
   * Set active trip data and update map
   * @param {Object} trip - Trip data
   */
  setActiveTrip(trip) {
    if (!trip) return;

    // If trip is marked as completed, clear it from the map
    if (trip.status === "completed") {
      console.log("Trip is completed, clearing from map");
      this.clearActiveTrip();
      this.updateActiveTripsCount(0);
      this.updateStatus(true, "No active trips");
      return;
    }

    this.activeTrip = trip;

    if (!Array.isArray(trip.coordinates) || trip.coordinates.length === 0) {
      this.clearActiveTrip();
      return;
    }

    // Sort coordinates by timestamp for proper path
    const sortedCoords = [...trip.coordinates];
    sortedCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Update polyline path
    const latLngs = sortedCoords.map((coord) => [coord.lat, coord.lon]);
    this.polyline.setLatLngs(latLngs);

    // Update marker position to latest point
    const lastPoint = latLngs[latLngs.length - 1];
    if (!this.map.hasLayer(this.marker)) {
      this.marker.addTo(this.map);
    }

    this.marker.setLatLng(lastPoint);
    this.marker.setOpacity(1);

    // Pan to latest position if option is enabled
    // This now depends on a user preference setting rather than automatic
    if (localStorage.getItem("autoFollowVehicle") === "true") {
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
      this.marker.removeFrom(this.map);
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

    console.log("Updating trip metrics with:", trip);

    // Get values from backend if available, otherwise calculate
    const startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const endTime = trip.endTime ? new Date(trip.endTime) : null;
    const tripStatus = trip.status || "active";

    // Display preformatted duration from backend or format it client-side
    let durationStr = trip.durationFormatted;
    if (!durationStr && startTime) {
      // If trip is completed, use endTime for duration calculation
      // Otherwise use lastUpdate or current time
      const endTimeToUse =
        tripStatus === "completed" ? endTime : lastUpdate || new Date();

      if (endTimeToUse) {
        const duration = Math.floor((endTimeToUse - startTime) / 1000);
        // Only show positive durations
        if (duration >= 0) {
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);
          const seconds = duration % 60;
          durationStr = `${hours}:${minutes
            .toString()
            .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
        } else {
          // If we somehow got a negative duration, show 0
          durationStr = "0:00:00";
        }
      }
    }

    // Use backend-calculated values if available
    const distance = typeof trip.distance === "number" ? trip.distance : 0;
    const currentSpeed =
      typeof trip.currentSpeed === "number" ? trip.currentSpeed : 0;
    const avgSpeed = typeof trip.avgSpeed === "number" ? trip.avgSpeed : 0;
    const maxSpeed = typeof trip.maxSpeed === "number" ? trip.maxSpeed : 0;
    const pointsRecorded = trip.pointsRecorded || trip.coordinates?.length || 0;

    // Format start time for display
    const startTimeFormatted =
      trip.startTimeFormatted ||
      (startTime ? startTime.toLocaleString() : "N/A");

    // Format metrics for display
    const metrics = {
      "Start Time": startTimeFormatted,
      Duration: durationStr || "0:00:00",
      Distance: `${distance.toFixed(2)} miles`,
      "Current Speed": `${currentSpeed.toFixed(1)} mph`,
      "Average Speed": `${avgSpeed.toFixed(1)} mph`,
      "Max Speed": `${maxSpeed.toFixed(1)} mph`,
      "Points Recorded": pointsRecorded,
      "Last Update": lastUpdate ? DateUtils.formatTimeAgo(lastUpdate) : "N/A",
    };

    // Log metrics for debugging
    console.log("Displaying metrics:", metrics);

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
   * Update the polyline style based on user settings
   * @param {string} color - Hex color value
   * @param {number} opacity - Opacity value between 0 and 1
   */
  updatePolylineStyle(color, opacity) {
    if (!this.polyline) return;

    // Apply new style to the polyline
    this.polyline.setStyle({
      color: color || "#00FF00",
      opacity: parseFloat(opacity) || 0.8,
    });

    // If we have an active trip, ensure the polyline is visible
    if (
      this.activeTrip &&
      this.activeTrip.coordinates &&
      this.activeTrip.coordinates.length > 0
    ) {
      // Make sure changes are visible
      this.polyline.redraw();
    }
  }

  /**
   * Clean up resources when tracker is no longer needed
   */
  destroy() {
    // Stop polling
    this.stopPolling();

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

    // Remove event listeners
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
  }
}

// Export for global usage
window.LiveTripTracker = LiveTripTracker;
