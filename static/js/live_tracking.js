/* global L, DateUtils */

class LiveTripTracker {
  constructor(map) {
    if (!map) {
      window.handleError(
        "LiveTripTracker: Map is required",
        "LiveTripTracker constructor",
      );
      return;
    }

    this.map = map;
    this.activeTrip = null;
    this.polyline = L.polyline([], {
      color: "#00FF00",
      weight: 3,
      opacity: 0.8,
      zIndex: 1000,
    }).addTo(this.map);

    this.marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "vehicle-marker",
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      zIndexOffset: 1000,
    });

    this.lastSequence = 0;
    this.pollingInterval = 2000;
    this.maxPollingInterval = 10000;
    this.minPollingInterval = 500;
    this.pollingTimerId = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    this.isPolling = false;

    this.statusIndicator = document.querySelector(".status-indicator");
    this.statusText = document.querySelector(".status-text");
    this.activeTripsCountElem = document.querySelector("#active-trips-count");
    this.tripMetricsElem = document.querySelector(".live-trip-metrics");
    this.errorMessageElem = document.querySelector(".error-message");

    this.initialize();
  }

  async initialize() {
    try {
      await this.loadInitialTripData();
      this.startPolling();

      document.addEventListener("mapUpdated", () => {
        this.bringLiveTripToFront();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.decreasePollingInterval();
          this.bringLiveTripToFront();
        } else {
          this.increasePollingInterval();
        }
      });

      window.addEventListener("beforeunload", () => {
        this.stopPolling();
      });
    } catch (error) {
      window.handleError(
        "LiveTripTracker initialization error: " + error,
        "initialize",
      );
      this.updateStatus(false);
      this.showError("Failed to initialize tracker. Will retry shortly.");
      setTimeout(() => this.initialize(), 5000);
    }
  }

  async loadInitialTripData() {
    try {
      console.info("Loading initial trip data", "loadInitialTripData");
      const response = await fetch("/api/active_trip");

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.info(
        "Initial trip data response: " + JSON.stringify(data),
        "loadInitialTripData",
      );

      if (data.status === "success") {
        if (data.has_active_trip && data.trip) {
          console.info(
            `Found active trip: ${data.trip.transactionId} with sequence: ${data.trip.sequence}`,
            "loadInitialTripData",
          );
          this.setActiveTrip(data.trip);
          this.updateActiveTripsCount(1);
          this.updateTripMetrics(data.trip);
          this.lastSequence = data.trip.sequence || 0;
          this.updateStatus(true);
        } else {
          console.info(
            "No active trips found during initialization",
            "loadInitialTripData",
          );
          this.updateStatus(true, "No active trips");
          this.updateActiveTripsCount(0);
          console.info(
            "No active trips found during initialization",
            "loadInitialTripData",
          );
        }
      } else {
        throw new Error(data.message || "Error loading initial trip data");
      }
    } catch (error) {
      window.handleError(
        "Error loading initial trip data: " + error,
        "loadInitialTripData",
      );
      this.updateStatus(false, "Failed to load trip data");
      this.showError(`Failed to load trip data: ${error.message}`);
      throw error;
    }
  }

  startPolling() {
    if (this.isPolling) return;

    this.isPolling = true;
    this.poll();
    console.info(
      `LiveTripTracker: Started polling (${this.pollingInterval}ms interval)`,
      "startPolling",
    );
  }

  stopPolling() {
    if (this.pollingTimerId) {
      clearTimeout(this.pollingTimerId);
      this.pollingTimerId = null;
    }
    this.isPolling = false;
    console.info("LiveTripTracker: Stopped polling", "stopPolling");
  }

  async poll() {
    if (!this.isPolling) return;

    try {
      console.info(
        `Polling for updates since sequence: ${this.lastSequence}`,
        "poll",
      );
      await this.fetchTripUpdates();

      this.consecutiveErrors = 0;

      if (this.activeTrip) {
        this.decreasePollingInterval();
      }
    } catch (error) {
      window.handleError("Error polling trip updates: " + error, "poll");
      this.consecutiveErrors++;

      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.updateStatus(false, "Connection lost");
        this.showError("Connection lost. Retrying...");
        this.increasePollingInterval();
      }
    } finally {
      this.pollingTimerId = setTimeout(() => {
        this.poll();
      }, this.pollingInterval);
    }
  }

  async fetchTripUpdates() {
    console.info(
      `Fetching trip updates with last_sequence=${this.lastSequence}`,
    );
    console.info(
      `Fetching trip updates with last_sequence=${this.lastSequence}`,
      "fetchTripUpdates",
    );

    const response = await fetch(
      `/api/trip_updates?last_sequence=${this.lastSequence}`,
    );

    if (!response.ok) {
      window.handleError(`HTTP error: ${response.status}`, "fetchTripUpdates");
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.info(
      "Trip update response: " + JSON.stringify(data),
      "fetchTripUpdates",
    );

    if (data.status === "success") {
      if (data.has_update && data.trip) {
        console.info(
          `Received trip update with sequence: ${data.trip.sequence}`,
          "fetchTripUpdates",
        );
        this.setActiveTrip(data.trip);
        this.updateActiveTripsCount(1);
        this.updateTripMetrics(data.trip);
        this.lastSequence = data.trip.sequence || this.lastSequence;
        this.updateStatus(true);
        this.hideError();

        this.setAdaptivePollingInterval(data.trip, true);
      } else if (this.activeTrip && !data.has_update) {
        console.info("No new updates for current trip", "fetchTripUpdates");
        this.updateStatus(true);

        this.setAdaptivePollingInterval(this.activeTrip, false);
      } else if (!this.activeTrip && !data.has_update) {
        console.info("No active trips found", "fetchTripUpdates");
        this.clearActiveTrip();
        this.updateActiveTripsCount(0);
        this.updateStatus(true, "No active trips");

        this.increasePollingInterval(1.2);
      }
    } else {
      window.handleError(
        `API error: ${data.message || "Unknown error"}`,
        "fetchTripUpdates",
      );
      throw new Error(data.message || "Unknown error fetching trip updates");
    }
  }

  increasePollingInterval(factor = 1.5) {
    const oldInterval = this.pollingInterval;
    this.pollingInterval = Math.min(
      this.pollingInterval * factor,
      this.maxPollingInterval,
    );

    if (this.pollingInterval !== oldInterval) {
      console.info(
        `LiveTripTracker: Increased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "increasePollingInterval",
      );
    }

    if (this.pollingInterval >= this.maxPollingInterval && !this.activeTrip) {
      this.updateStatus(true, "Standby mode - waiting for trips");
    }
  }

  decreasePollingInterval(factor = 0.7, forceMinimum = false) {
    const oldInterval = this.pollingInterval;

    if (forceMinimum) {
      this.pollingInterval = this.minPollingInterval;
    } else {
      this.pollingInterval = Math.max(
        this.pollingInterval * factor,
        this.activeTrip ? this.minPollingInterval : this.minPollingInterval * 2,
      );
    }

    if (this.pollingInterval !== oldInterval) {
      console.info(
        `LiveTripTracker: Decreased polling interval to ${Math.round(this.pollingInterval)}ms`,
        "decreasePollingInterval",
      );
    }

    if (this.activeTrip) {
      this.updateStatus(true, "Connected - tracking active");
    }
  }

  setAdaptivePollingInterval(trip, hasNewData) {
    if (!trip) {
      this.increasePollingInterval(1.2);
      return;
    }

    const isMoving = trip.currentSpeed > 2;
    const isFastMoving = trip.currentSpeed > 15;

    if (isFastMoving && hasNewData) {
      this.decreasePollingInterval(0.5, true);
    } else if (isMoving && hasNewData) {
      this.decreasePollingInterval(0.8);
    } else if (isMoving) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else if (hasNewData) {
      this.pollingInterval = Math.max(
        this.minPollingInterval * 1.5,
        Math.min(this.pollingInterval, this.maxPollingInterval / 2),
      );
    } else {
      this.increasePollingInterval(1.1);
    }
  }

  updateStatus(connected, message) {
    if (!this.statusIndicator || !this.statusText) return;

    this.statusIndicator.classList.toggle("connected", connected);
    this.statusIndicator.classList.toggle("disconnected", !connected);
    this.statusIndicator.setAttribute(
      "aria-label",
      connected ? "Connected" : "Disconnected",
    );

    this.statusText.textContent =
      message || (connected ? "Connected" : "Disconnected");
  }

  showError(message) {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.textContent = message;
    this.errorMessageElem.classList.remove("d-none");
  }

  hideError() {
    if (!this.errorMessageElem) return;

    this.errorMessageElem.classList.add("d-none");
  }

  setActiveTrip(trip) {
    if (!trip) return;

    const isNewTrip =
      !this.activeTrip || this.activeTrip.transactionId !== trip.transactionId;

    if (trip.status === "completed") {
      console.info("Trip is completed, clearing from map", "setActiveTrip");
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

    const sortedCoords = [...trip.coordinates];
    sortedCoords.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const latLngs = sortedCoords.map((coord) => [coord.lat, coord.lon]);

    const lastPoint = latLngs[latLngs.length - 1];

    if (isNewTrip) {
      this.polyline.setLatLngs(latLngs);
      this.polyline.bringToFront();

      if (!this.map.hasLayer(this.marker)) {
        this.marker.addTo(this.map);
      }

      this.marker.setLatLng(lastPoint);
      this.marker.setOpacity(1);

      if (latLngs.length > 1) {
        try {
          const bounds = L.latLngBounds(latLngs);
          this.map.fitBounds(bounds, { padding: [50, 50] });
        } catch (e) {
          console.error("Error fitting bounds:", e);
          this.map.setView(lastPoint, 15);
          console.error("Error fitting bounds: " + e, "setActiveTrip");
        }
      } else {
        this.map.setView(lastPoint, 15);
      }
    } else {
      const prevCoords = this.polyline.getLatLngs();

      if (latLngs.length > prevCoords.length) {
        this.polyline.setLatLngs(latLngs);
        this.polyline.bringToFront();

        if (prevCoords.length > 0) {
          const prevLastPoint = prevCoords[prevCoords.length - 1];

          if (
            prevLastPoint[0] !== lastPoint[0] ||
            prevLastPoint[1] !== lastPoint[1]
          ) {
            this.marker.setLatLng(lastPoint);

            if (localStorage.getItem("autoFollowVehicle") === "true") {
              if (!this.map.getBounds().contains(lastPoint)) {
                this.map.panTo(lastPoint);
              }
            }
          }
        } else {
          this.marker.setLatLng(lastPoint);
        }
      }
    }

    this.updateMarkerIcon(trip.currentSpeed);
  }

  updateMarkerIcon(speed) {
    if (!this.marker) return;

    let iconClass = "vehicle-marker";

    if (speed === 0) {
      iconClass += " vehicle-stopped";
    } else if (speed < 10) {
      iconClass += " vehicle-slow";
    } else if (speed < 35) {
      iconClass += " vehicle-medium";
    } else {
      iconClass += " vehicle-fast";
    }

    if (this.marker.options.icon.options.className !== iconClass) {
      this.marker.setIcon(
        L.divIcon({
          className: iconClass,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
          html: `<div class="vehicle-marker-inner" data-speed="${Math.round(
            speed,
          )}"></div>`,
        }),
      );
    }
  }

  clearActiveTrip() {
    this.activeTrip = null;
    this.polyline.setLatLngs([]);

    if (this.map.hasLayer(this.marker)) {
      this.marker.removeFrom(this.map);
    }
  }

  updateActiveTripsCount(count) {
    if (this.activeTripsCountElem) {
      this.activeTripsCountElem.textContent = count;
      this.activeTripsCountElem.setAttribute(
        "aria-label",
        `${count} active trips`,
      );
    }
  }

  updateTripMetrics(trip) {
    if (!this.tripMetricsElem || !trip) return;

    let startTime = trip.startTime ? new Date(trip.startTime) : null;
    const lastUpdate = trip.lastUpdate ? new Date(trip.lastUpdate) : null;
    const endTime = trip.endTime ? new Date(trip.endTime) : null;
    const tripStatus = trip.status || "active";

    let durationStr = trip.durationFormatted;
    if (!durationStr && startTime) {
      const endTimeToUse =
        tripStatus === "completed" ? endTime : lastUpdate || new Date();

      if (endTimeToUse) {
        durationStr = DateUtils.formatDurationHMS(startTime, endTimeToUse);
      }
    }

    const distance = typeof trip.distance === "number" ? trip.distance : 0;
    const currentSpeed =
      typeof trip.currentSpeed === "number" ? trip.currentSpeed : 0;
    const avgSpeed = typeof trip.avgSpeed === "number" ? trip.avgSpeed : 0;
    const maxSpeed = typeof trip.maxSpeed === "number" ? trip.maxSpeed : 0;
    const pointsRecorded = trip.pointsRecorded || trip.coordinates?.length || 0;
    const startOdometer =
      trip.startOdometer !== undefined && trip.startOdometer !== null
        ? trip.startOdometer
        : "N/A";
    const totalIdlingTime =
      typeof trip.totalIdlingTime === "number" ? trip.totalIdlingTime : 0;
    const hardBrakingCounts =
      typeof trip.hardBrakingCounts === "number" ? trip.hardBrakingCounts : 0;
    const hardAccelerationCounts =
      typeof trip.hardAccelerationCounts === "number"
        ? trip.hardAccelerationCounts
        : 0;

    let startTimeFormatted = "N/A";

    if (trip.startTimeFormatted) {
      startTimeFormatted = trip.startTimeFormatted;
    } else if (startTime) {
      try {
        if (typeof startTime === "string") {
          startTime = new Date(startTime);
        }

        if (!isNaN(startTime.getTime())) {
          startTimeFormatted = startTime.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            hour12: true,
          });
        }
      } catch (err) {
        console.error("Error formatting start time:", err);
      }
    }

    const metrics = this.formatTripMetrics({
      trip,
      startTime,
      lastUpdate,
      endTime,
      tripStatus,
      durationStr,
      distance,
      currentSpeed,
      avgSpeed,
      maxSpeed,
      pointsRecorded,
      startOdometer,
      totalIdlingTime,
      hardBrakingCounts,
      hardAccelerationCounts,
      startTimeFormatted,
    });

    console.info("Displaying metrics:", metrics);

    this.tripMetricsElem.innerHTML = Object.entries(metrics)
      .map(
        ([label, value]) => `<div class="metric-row">
        <span class="metric-label">${label}:</span>
        <span class="metric-value">${value}</span>
      </div>`,
      )
      .join("");
  }

  formatTripMetrics({
    trip,
    startTime,
    lastUpdate,
    endTime,
    tripStatus,
    durationStr,
    distance,
    currentSpeed,
    avgSpeed,
    maxSpeed,
    pointsRecorded,
    startOdometer,
    totalIdlingTime,
    hardBrakingCounts,
    hardAccelerationCounts,
    startTimeFormatted,
  }) {
    return {
      "Start Time": startTimeFormatted,
      Duration: durationStr || "0:00:00",
      Distance: `${distance.toFixed(2)} miles`,
      "Current Speed": `${currentSpeed.toFixed(1)} mph`,
      "Average Speed": `${avgSpeed.toFixed(1)} mph`,
      "Max Speed": `${maxSpeed.toFixed(1)} mph`,
      "Points Recorded": pointsRecorded,
      "Start Odometer": `${startOdometer}${startOdometer !== "N/A" ? " miles" : ""}`,
      "Total Idling Time": `${DateUtils.formatSecondsToHMS(totalIdlingTime)}`,
      "Hard Braking": hardBrakingCounts,
      "Hard Acceleration": hardAccelerationCounts,
      "Last Update": lastUpdate ? DateUtils.formatTimeAgo(lastUpdate) : "N/A",
    };
  }

  updatePolylineStyle(color, opacity) {
    if (!this.polyline) return;

    this.polyline.setStyle({
      color: color || "#00FF00",
      opacity: parseFloat(opacity) || 0.8,
      zIndex: 1000,
    });

    if (
      this.activeTrip?.coordinates &&
      this.activeTrip.coordinates.length > 0
    ) {
      this.polyline.redraw();
      this.bringLiveTripToFront();
    }

    console.info(
      "LiveTripTracker: Polyline style updated",
      "updatePolylineStyle",
    );
  }

  bringLiveTripToFront() {
    if (this.polyline && this.map.hasLayer(this.polyline)) {
      this.polyline.bringToFront();
      console.info(
        "LiveTripTracker: Polyline brought to front",
        "bringLiveTripToFront",
      );
    }
    if (this.marker && this.map.hasLayer(this.marker)) {
      this.marker.bringToFront();
    }
  }

  destroy() {
    this.stopPolling();

    if (this.map) {
      if (this.map.hasLayer(this.polyline)) {
        this.map.removeLayer(this.polyline);
      }

      if (this.map.hasLayer(this.marker)) {
        this.map.removeLayer(this.marker);
      }
    }

    this.updateStatus(false, "Disconnected");
    this.updateActiveTripsCount(0);

    if (this.tripMetricsElem) {
      this.tripMetricsElem.innerHTML = "";
    }

    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );

    console.info("LiveTripTracker instance destroyed");
  }
}

window.LiveTripTracker = LiveTripTracker;
